import { describe, expect, it } from "vitest";
import type { SplatMesh, SplatSkinning } from "@sparkjsdev/spark";
import { Color, Matrix4, Quaternion, Raycaster, Vector3 } from "three";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { addSplat, emptyScene, type SceneDocument, type SplatShapeNode } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { commitSplatComponentEdit, editSplatComponents, isSplatComponentActive, SPLAT_EDIT_RUN_LIMIT, validateSplatComponentEdits, type SplatComponentEdits } from "../src/splat-component-edits.ts";
import { editedSplatBounds, pickEditedSplats, populateSplatEditMask } from "../src/splat-component-runtime.ts";
import { posedSelection } from "../src/splat-selection.ts";

const asset = { id: "cloud", kind: "file", fileName: "cloud.splat", byteLength: 128 } as const;
const identity = { shapeId: "shape", assetId: asset.id, count: 4 };
const editsOf = (doc: SceneDocument, shapeId = "shape") => (doc.nodes[shapeId] as SplatShapeNode).componentEdits;
function scene() {
  const first = addSplat(emptyScene(), asset, "Regions", [0, 0, 0], "object", "shape").document;
  return addSplat(first, asset, "Duplicate", [0, 0, 0], "duplicate", "duplicate-shape").document;
}
const editor = { camera: { position: [0, 0, 8] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 42, near: .01, far: 1000 }, time: 0 };

describe("authored splat edits", () => {
  it("edits only active originals on the selected instance, with distinct reversible hide/delete", () => {
    const original = scene(), hide = editSplatComponents(original, identity, "hide", [3, 1, 1]);
    const remove = editSplatComponents(hide, identity, "delete", [2, 3]);
    expect(editsOf(remove)).toEqual({ version: 1, sourceCount: 4, hidden: [1, 2, 3, 4], deleted: [2, 3] });
    expect([0, 1, 2, 3].map(i => isSplatComponentActive(editsOf(remove), i))).toEqual([true, false, false, false]);
    expect(editsOf(remove, "duplicate-shape")).toBeUndefined();
    expect(remove.nodes["duplicate-shape"]).toBe(original.nodes["duplicate-shape"]);
    expect(remove.assets).toBe(original.assets);
    expect(editsOf(original)).toBeUndefined();
    const shown = editSplatComponents(remove, identity, "show");
    expect(editsOf(shown)).toEqual({ version: 1, sourceCount: 4, hidden: [], deleted: [2, 3] });
    expect(editsOf(editSplatComponents(remove, identity, "restore"))?.hidden).toEqual([1, 2, 3, 4]);
    expect(editsOf(editSplatComponents(shown, identity, "restore"))).toBeUndefined();
  });

  it("compresses delete all, creates one undo, and keeps invalid and empty commands atomic", () => {
    const original = scene(), store = createSceneStore(original);
    expect(commitSplatComponentEdit(store, identity, "delete", [])).toBe(false);
    expect(() => commitSplatComponentEdit(store, identity, "delete", [0, 4])).toThrow(/invalid original index/);
    expect(() => commitSplatComponentEdit(store, { ...identity, assetId: "stale" }, "hide", [0])).toThrow(/changed/);
    expect(store.getState().document).toBe(original);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    expect(commitSplatComponentEdit(store, identity, "delete", [3, 2, 0, 1])).toBe(true);
    const removed = store.getState().document;
    expect(editsOf(removed)?.deleted).toEqual([0, 4]);
    expect(commitSplatComponentEdit(store, identity, "hide", [0, 3])).toBe(false);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(original);
    store.temporal.getState().redo();
    expect(store.getState().document).toBe(removed);
    expect(commitSplatComponentEdit(store, identity, "restore")).toBe(true);
    expect(editsOf(store.getState().document)).toBeUndefined();
  });

  it("rejects excessive range fragmentation without an undo item", () => {
    const store = createSceneStore(scene()), count = (SPLAT_EDIT_RUN_LIMIT + 1) * 2;
    const alternating = Uint32Array.from({ length: SPLAT_EDIT_RUN_LIMIT + 1 }, (_, i) => i * 2);
    expect(() => commitSplatComponentEdit(store, { ...identity, count }, "delete", alternating)).toThrow(/separate splat ranges/);
    expect(editsOf(store.getState().document)).toBeUndefined();
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("round trips distinct versioned edit ranges while preserving the one shared source binary", async () => {
    const doc = editSplatComponents(editSplatComponents(scene(), identity, "delete", [0, 1]), identity, "hide", [3]);
    const source = Uint8Array.from({ length: asset.byteLength }, (_, index) => index);
    const archived = await encodeProject(doc, new Map([[asset.id, new File([source], asset.fileName)]]), editor);
    const project = await decodeProject(archived);
    expect(project.scene).toEqual(doc);
    expect(project.files.size).toBe(1);
    expect(new Uint8Array(await project.files.get(asset.id)!.arrayBuffer())).toEqual(source);
    expect(() => validateSplatComponentEdits(editsOf(project.scene), 3)).toThrow(/decoded splat count/);
  });

  it.each([
    { version: 2 }, { sourceCount: -1 }, { sourceCount: 2 },
    { hidden: [1, 2, 2, 4] }, { hidden: [3, 4, 1, 2] }, { hidden: [0, 2, 1, 3] }, { hidden: [1, 3] },
    { hidden: [1] }, { hidden: [1, 1] }, { hidden: [1.5, 2] }, { hidden: [null, 2] }, { hidden: [-1, 2] },
    { hidden: [], deleted: [] },
  ])("rejects malformed archive edits %o", invalid => {
    const doc = scene();
    (doc.nodes.shape as SplatShapeNode).componentEdits = { version: 1, sourceCount: 4, hidden: [3, 4], deleted: [2, 3], ...invalid } as SplatComponentEdits;
    expect(() => validateScene(doc)).toThrow(/splat/i);
  });
});

describe("evaluated splat edits", () => {
  it("fills an index bit mask at exact word boundaries and erases stale bits when showing originals", () => {
    const words = new Uint32Array(4);
    populateSplatEditMask(words, { version: 1, sourceCount: 110, hidden: [0, 1, 28, 35], deleted: [3, 5, 64, 108] });
    expect(Array.from(words)).toEqual([0xf0000019, 0x7, 0xffffffff, 0xfff]);
    populateSplatEditMask(words, { version: 1, sourceCount: 110, hidden: [], deleted: [31, 33] });
    expect(Array.from(words)).toEqual([0x80000000, 1, 0, 0]);
  });

  it("removes an inactive far region from bounds and ray hits, including every inactive splat", () => {
    const centers = [-8, 2, 10], scale = new Vector3(.3, .2, .1), q = new Quaternion(), color = new Color();
    const get = (index: number) => ({ center: new Vector3(centers[index], 0, 0), scales: scale, quaternion: q, opacity: 1, color });
    const source = { numSplats: centers.length, getSplat: get, forEachSplat(cb: Function) {
      centers.forEach((_, i) => { const s = get(i); cb(i, s.center, s.scales, s.quaternion, s.opacity, s.color); });
    } };
    const mesh = { extSplats: source, opacity: 1, minRaycastOpacity: .05, matrixWorld: new Matrix4(), updateWorldMatrix() {} } as unknown as SplatMesh;
    const active = (index: number) => index === 1;
    const ray = (x: number) => new Raycaster(new Vector3(x, 0, 8), new Vector3(0, 0, -1));
    expect(editedSplatBounds(mesh, active).min.x).toBeCloseTo(1.7);
    expect(editedSplatBounds(mesh, active).max.x).toBeCloseTo(2.3);
    expect(editedSplatBounds(mesh, () => false).isEmpty()).toBe(true);
    expect(pickEditedSplats(mesh, active, ray(10))).toBe(Infinity);
    expect(pickEditedSplats(mesh, active, ray(2))).toBeCloseTo(7.8);
    const skin = { skinData: new Uint16Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]) } as SplatSkinning;
    const posed = posedSelection(mesh, skin, [new Matrix4().makeTranslation(3, 0, 0)], active);
    expect(Array.from(posed.centers)).toEqual([NaN, NaN, NaN, 5, 0, 0, NaN, NaN, NaN]);
    expect(posed.bounds.min.x).toBeCloseTo(4.4);
    expect(posed.pick(ray(13))).toBe(Infinity);
    expect(posed.pick(ray(5))).toBeCloseTo(7.8);
  });
});
