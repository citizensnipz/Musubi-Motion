import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { setAnimationSettings, upsertTrack } from "../src/animation.ts";
import { createController, findControllerShape } from "../src/controller-curves.ts";
import { createMeshPrimitive, findMeshShape } from "../src/mesh-modeling.ts";
import { createParticleEmitter, findParticleShape, updateParticleEmitter, type ParticleShapeNode } from "../src/particle-emitter.ts";
import { createParticlePoseSampler } from "../src/particle-pose-sampler.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { addSplat, deleteSceneItems, emptyScene, type SceneDocument, type TransformNode, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore, type SceneStore } from "../src/scene-store.ts";

const editor = { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: 0.01, far: 1000 }, time: 1.25 };
function fixture() {
  const file = new File([new Uint8Array([7, 4, 1, 9, 2, 8])], "particle-source.splat"), assetId = "source-file";
  const initial = addSplat(emptyScene(), { id: assetId, kind: "file", fileName: file.name, byteLength: file.size }, "Capture", [1, -2, 3]).document;
  const store = createSceneStore(initial), meshId = createMeshPrimitive(store, "cube", { name: "EmissionSurface", position: [2, 3, 4], rotation: [0, 45, 0], scale: [2, 1, 3] });
  const mesh = findMeshShape(store.getState().document, meshId)!, curveId = createController(store, "circle", { name: "Driver", plane: "XY" });
  const emitterId = createParticleEmitter(store, "surface", { name: "SurfaceFX", surfaceId: mesh.id }), emitter = findParticleShape(store.getState().document, emitterId)!;
  updateParticleEmitter(store, emitter.id, { seed: 0xfedcba98, rate: 75, lifetime: 2.5, speedRandom: 3.5, turbulence: { strength: 0.75, scale: 2 }, attraction: { position: [1, 2, 3], strength: -0.5, radius: 4 }, colors: ["#aBc123", "#112233"] });
  for (const [targetId, channel, end] of [[meshId, "rotation.y", 180], [emitterId, "position.x", 2]] as const) {
    const id = `${targetId}-animation`;
    upsertTrack(store, { id, targetId, channel, keys: [
      { id: `${id}-start`, time: 0, value: 0, interpolation: "linear", tangentMode: "auto" },
      { id: `${id}-end`, time: 48, value: end, interpolation: "linear", tangentMode: "auto" },
    ] });
  }
  return { store, emitterId, emitterShapeId: emitter.id, meshId, meshShapeId: mesh.id, curveShapeId: findControllerShape(store.getState().document, curveId)!.id, assetId, file, files: new Map([[assetId, file]]) };
}
function mutateArchive(bytes: Uint8Array, mutate: (doc: SceneDocument) => void) {
  const entries = unzipSync(bytes), manifest = JSON.parse(strFromU8(entries["scene.json"])); mutate(manifest.scene); entries["scene.json"] = strToU8(JSON.stringify(manifest)); return zipSync(entries);
}
// Mirrors the application's decode-before-commit boundary. GPU/runtime staging
// is intentionally outside this archive-unit test.
async function openAfterValidation(store: SceneStore, bytes: Uint8Array) {
  const opened = await decodeProject(bytes); store.setState({ document: opened.scene, editLabel: "Open scene" });
}

describe("particle scenes in portable archives", () => {
  it("round-trips mixed surfaces, splats, curves, emitter settings, animation and original source bytes", async () => {
    const data = fixture(), doc = data.store.getState().document, bytes = await encodeProject(doc, data.files, editor), opened = await decodeProject(bytes);
    expect(opened.scene).toEqual(doc); expect(opened.editor).toEqual(editor);
    expect(new Uint8Array(await opened.files.get(data.assetId)!.arrayBuffer())).toEqual(new Uint8Array(await data.file.arrayBuffer()));
    expect(opened.files.get(data.assetId)!.name).toBe(data.file.name);
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual([`assets/${data.assetId}`, "scene.json"]);
    expect(findParticleShape(opened.scene, data.emitterId)).toMatchObject({ seed: 0xfedcba98, surfaceId: data.meshShapeId, speedRandom: 3.5, colors: ["#aBc123", "#112233"] });
    expect((opened.scene.nodes[data.emitterId] as TransformNode).parentId).toBe(data.meshId);
    const before = createParticlePoseSampler(doc), after = createParticlePoseSampler(opened.scene);
    for (const frame of [0, 7.125, 24, 48]) expect(after.worldAt(frame).get(data.emitterId)!.elements).toEqual(before.worldAt(frame).get(data.emitterId)!.elements);
    const reopened = await decodeProject(await encodeProject(opened.scene, opened.files, opened.editor)); expect(reopened.scene).toEqual(opened.scene);
  });
  it("rejects malformed settings, live budgets, surface references and parenting before committing a scene", async () => {
    const data = fixture(), bytes = await encodeProject(data.store.getState().document, data.files, editor);
    const active = createSceneStore(); createParticleEmitter(active, "omni", { name: "UnsavedActive" });
    const original = active.getState().document, past = [...active.temporal.getState().pastStates], label = active.getState().editLabel;
    const mutations: Array<(doc: SceneDocument) => void> = [
      doc => (doc.nodes[data.emitterShapeId] as ParticleShapeNode).seed = 0x100000000,
      doc => (doc.nodes[data.emitterShapeId] as ParticleShapeNode).rate = 10001,
      doc => { const emitter = doc.nodes[data.emitterShapeId] as ParticleShapeNode; emitter.rate = 10000; emitter.lifetime = 60; },
      doc => (doc.nodes[data.emitterShapeId] as ParticleShapeNode).endFrame = 7201,
      doc => (doc.nodes[data.emitterShapeId] as ParticleShapeNode).surfaceId = "missing",
      doc => (doc.nodes[data.emitterShapeId] as ParticleShapeNode).surfaceId = data.curveShapeId,
      doc => { doc.nodes[data.emitterId].parentId = null; doc.rootIds.push(data.emitterId); },
      doc => { const emitter = doc.nodes[data.emitterShapeId] as ParticleShapeNode; emitter.emission = "box"; emitter.enabled = false; emitter.surfaceId = "missing"; },
    ];
    for (const mutate of mutations) {
      await expect(openAfterValidation(active, mutateArchive(bytes, mutate))).rejects.toThrow();
      expect(active.getState().document).toBe(original); expect(active.getState().editLabel).toBe(label); expect(active.temporal.getState().pastStates).toEqual(past); expect(active.temporal.getState().futureStates).toEqual([]);
    }
  });
  it("rejects combined scene budgets and emitter counts in packed metadata", async () => {
    const data = fixture(), bytes = await encodeProject(data.store.getState().document, data.files, editor);
    function addCopies(doc: SceneDocument, count: number, rate: number) {
      const source = doc.nodes[data.emitterShapeId] as ParticleShapeNode;
      for (let index = 0; index < count; index++) {
        const id = `extra-${index}`, shapeId = `${id}-shape`;
        doc.nodes[id] = { id, type: "transform", name: id, parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" }; doc.rootIds.push(id);
        const { surfaceId: _surfaceId, ...settings } = source;
        doc.nodes[shapeId] = { ...settings, id: shapeId, name: shapeId, parentId: id, emission: "omni", rate, lifetime: 1.99 };
      }
    }
    await expect(decodeProject(mutateArchive(bytes, doc => addCopies(doc, 6, 10000)))).rejects.toThrow(/100,000/);
    await expect(decodeProject(mutateArchive(bytes, doc => addCopies(doc, 32, 1)))).rejects.toThrow(/32/);
  });
  it("rejects an FPS change that makes an authored emission longer than 300 seconds atomically", async () => {
    const data = fixture(); updateParticleEmitter(data.store, data.emitterShapeId, { startFrame: 0, endFrame: 7200 });
    const before = data.store.getState().document, history = [...data.store.temporal.getState().pastStates], label = data.store.getState().editLabel;
    expect(() => setAnimationSettings(data.store, { fps: 12 })).toThrow(/300 seconds/);
    expect(data.store.getState().document).toBe(before); expect(data.store.getState().editLabel).toBe(label); expect(data.store.temporal.getState().pastStates).toEqual(history);
    setAnimationSettings(data.store, { fps: 48 }); const changed = data.store.getState().document;
    expect(changed.animation!.fps).toBe(48); expect((await decodeProject(await encodeProject(changed, data.files, editor))).scene).toEqual(changed);
    data.store.temporal.getState().undo(); expect(data.store.getState().document).toBe(before);
    data.store.temporal.getState().redo(); expect(data.store.getState().document).toBe(changed);
  });
  it("deletes surface emitters with their source subtree and preserves unrelated file assets", async () => {
    const data = fixture(), before = data.store.getState().document, removed = deleteSceneItems(before, [data.meshId]);
    expect(removed.nodes[data.emitterId]).toBeUndefined(); expect(removed.nodes[data.emitterShapeId]).toBeUndefined(); expect(removed.animation!.tracks).toEqual([]);
    expect(removed.assets[data.assetId]).toEqual(before.assets[data.assetId]);
    const opened = await decodeProject(await encodeProject(removed, data.files, editor)); expect(opened.scene).toEqual(removed);
    expect(new Uint8Array(await opened.files.get(data.assetId)!.arrayBuffer())).toEqual(new Uint8Array(await data.file.arrayBuffer()));
  });
});
