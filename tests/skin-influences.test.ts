import { describe, expect, it } from "vitest";
import { Matrix4 } from "three";
import { addSplat, emptyScene, type SplatShapeNode, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { createSkinWeightLookup, type SkinWeightContext } from "../src/skin-weights.ts";
import { addSkinInfluence, removeSkinInfluence } from "../src/skin-influences.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";

const matrix = (x = 0) => new Matrix4().makeTranslation(x, 0, 0).toArray();
function fixture() {
  const { document } = addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "Skin", [0, 0, 0], "object", "shape");
  document.joints = ["a", "b", "c", "d", "e", "new"].map((id, index) => ({ id, name: id, parentId: index ? "a" : null, position: [index, 0, 0] }));
  (document.nodes.shape as SplatShapeNode).binding = { jointIds: ["a", "b", "c", "d", "e"], restMatrices: [0, 1, 2, 3, 4].map(matrix), weights: { count: 3, overrides: { "1": [{ jointId: "b", weight: 1 }] } } };
  const store = createSceneStore(document), original = binding(store), lookup = createSkinWeightLookup(original);
  const context: SkinWeightContext = { count: 3, getWeights: index => lookup(index, [index + .2, 0, 0]) };
  return { store, context, rows: [0, 1, 2].map(context.getWeights) };
}
const binding = (store: ReturnType<typeof createSceneStore>) => (store.getState().document.nodes.shape as SplatShapeNode).binding!;

describe("preserving skin influence management", () => {
  it("adds at zero weight and preserves automatic and authored effective rows exactly", () => {
    const { store, context, rows } = fixture(), original = binding(store);
    addSkinInfluence(store, "shape", "new", matrix(8), context);
    const next = binding(store), lookup = createSkinWeightLookup(next);
    expect(next.jointIds).toEqual([...original.jointIds, "new"]);
    expect(next.restMatrices.slice(0, 5)).toEqual(original.restMatrices);
    for (let index = 0; index < 3; index++) expect(lookup(index, [500, 100, 0])).toEqual(rows[index]);
    expect(original.weights!.overrides).toEqual({ "1": [{ jointId: "b", weight: 1 }] });
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(binding(store)).toEqual(original);
    store.temporal.getState().redo(); expect(binding(store)).toEqual(next);
  });
  it("normalizes surviving weights proportionally, maintains four-influence limit and paired rest matrices", () => {
    const { store, context, rows } = fixture();
    removeSkinInfluence(store, "shape", "a", context);
    const next = binding(store);
    expect(next.jointIds).toEqual(["b", "c", "d", "e"]);
    expect(next.restMatrices).toEqual([1, 2, 3, 4].map(matrix));
    rows.forEach((row, index) => {
      const remaining = row.filter(entry => entry.jointId !== "a"), sum = remaining.reduce((sum, entry) => sum + entry.weight, 0);
      expect(next.weights!.overrides[index]).toEqual(remaining.length === row.length ? row : remaining.map(entry => ({ ...entry, weight: entry.weight / sum })));
      expect(next.weights!.overrides[index].length).toBeLessThanOrEqual(4);
    });
    expect(store.temporal.getState().pastStates).toHaveLength(1);
  });
  it("rejects sole-influence removal atomically unless a replacement is explicit", () => {
    const { store, context } = fixture(), before = store.getState().document;
    expect(() => removeSkinInfluence(store, "shape", "b", context)).toThrow(/explicit replacement/);
    expect(store.getState().document).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    removeSkinInfluence(store, "shape", "b", context, "e");
    expect(binding(store).weights!.overrides["1"]).toEqual([{ jointId: "e", weight: 1 }]);
  });
  it("does not silently regenerate automatic rows beyond the preservation limit", () => {
    const { store } = fixture(), before = store.getState().document;
    delete binding(store).weights;
    const context = { count: 200001, getWeights: () => { throw Error("Should not read components"); } };
    expect(() => addSkinInfluence(store, "shape", "new", matrix(), context)).toThrow(/200,000/);
    expect(() => removeSkinInfluence(store, "shape", "a", context)).toThrow(/200,000/);
    expect(store.getState().document).toBe(before);
  });
  it("keeps already-bound additions out of history and rejects missing joints and invalid matrices", () => {
    const { store, context } = fixture();
    addSkinInfluence(store, "shape", "a", matrix(), context);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    expect(() => addSkinInfluence(store, "shape", "missing", matrix(), context)).toThrow(/existing joint/);
    for (const invalid of [[], matrix().map(() => 0), matrix().map((value, index) => index === 3 ? 1 : value), matrix().map((value, index) => index === 0 ? NaN : value)])
      expect(() => addSkinInfluence(store, "shape", "new", invalid, context)).toThrow(/bind matrix/);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });
  it("rejects missing influences, invalid replacement and last influence without history", () => {
    const { store, context } = fixture();
    expect(() => removeSkinInfluence(store, "shape", "missing", context)).toThrow(/bound joint/);
    expect(() => removeSkinInfluence(store, "shape", "b", context, "b")).toThrow(/different bound/);
    expect(() => removeSkinInfluence(store, "shape", "b", context, "new")).toThrow(/different bound/);
    const value = binding(store); value.jointIds = ["b"]; value.restMatrices = [matrix()]; value.weights = { count: 3, overrides: {} };
    expect(() => removeSkinInfluence(store, "shape", "b", { count: 3, getWeights: () => [{ jointId: "b", weight: 1 }] })).toThrow(/last/);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });
  it("rejects stale counts and invalid effective rows before any edit", () => {
    const { store, context } = fixture(), before = store.getState().document;
    expect(() => addSkinInfluence(store, "shape", "new", matrix(), { ...context, count: 4 })).toThrow(/does not match/);
    expect(() => addSkinInfluence(store, "shape", "new", matrix(), { ...context, getWeights: () => [{ jointId: "other", weight: 1 }] })).toThrow(/bound joint/);
    expect(store.getState().document).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });
  it("detects document changes caused by a component provider", () => {
    const { store, context } = fixture();
    const changed = { ...store.getState().document, name: "Changed" };
    expect(() => addSkinInfluence(store, "shape", "new", matrix(), { count: 3, getWeights: index => { store.setState({ document: changed }); return context.getWeights(index); } })).toThrow(/scene changed/);
    expect(store.getState().document).toBe(changed);
    expect(binding(store).jointIds).not.toContain("new");
  });
  it("round-trips palette, bind matrices and preserved rows through MSB", async () => {
    const { store, context } = fixture(); addSkinInfluence(store, "shape", "new", matrix(8), context);
    removeSkinInfluence(store, "shape", "b", { count: 3, getWeights: index => binding(store).weights!.overrides[index] }, "new");
    const scene = store.getState().document;
    const bytes = await encodeProject(scene, new Map(), { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: .01, far: 1000 }, time: 0 });
    expect((await decodeProject(bytes)).scene).toEqual(scene);
  });
});
