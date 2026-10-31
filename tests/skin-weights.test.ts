import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { addSplat, emptyScene, type SkinBinding, type SkinInfluence, type SplatShapeNode, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { createSkinWeightLookup, editSkinWeight, resetSkinWeights, validateSkinWeightCount, validateSkinWeights } from "../src/skin-weights.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";

function binding(count = 5): SkinBinding {
  return { jointIds: Array.from({ length: count }, (_, index) => `j${index}`), restMatrices: Array.from({ length: count }, (_, index) => new Matrix4().makeTranslation(index, 0, 0).toArray()) };
}
function fixture(value = binding()) {
  const { document } = addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "Skin", [0, 0, 0], "object", "shape");
  (document.nodes.shape as SplatShapeNode).binding = value;
  return createSceneStore(document);
}
const row = (a = 0.25): SkinInfluence[] => [{ jointId: "j0", weight: a }, { jointId: "j1", weight: 1 - a }];
const stored = (store: ReturnType<typeof fixture>) => (store.getState().document.nodes.shape as SplatShapeNode).binding!;
const editor = { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: 0.01, far: 1000 }, time: 0 };

describe("effective skin weight lookup", () => {
  it("matches legacy nearest-four inverse squared distances, including stable ties and the distance floor", () => {
    const value = binding(6), lookup = createSkinWeightLookup(value);
    for (const point of [[0, 0, 0], [2.5, 0, 0], [1e-7, 0, 0], [3, 4, 5]] as Vec3[]) {
      const center = new Vector3(...point);
      const expected = value.restMatrices.map((matrix, index) => ({ jointId: value.jointIds[index], weight: 1 / Math.max(1e-8, new Vector3().setFromMatrixPosition(new Matrix4().fromArray(matrix)).distanceToSquared(center)) })).sort((a, b) => b.weight - a.weight).slice(0, 4);
      const total = expected.reduce((sum, entry) => sum + entry.weight, 0);
      expect(lookup(0, point)).toEqual(expected.map(entry => ({ ...entry, weight: entry.weight / total })));
    }
    expect(lookup(0, [2.5, 0, 0]).map(entry => entry.jointId)).toEqual(["j2", "j3", "j1", "j4"]);
  });
  it("uses precise authored weights and protects saved rows from caller mutation", () => {
    const value: SkinBinding = { ...binding(), weights: { count: 3, overrides: { "1": row(0.123456789123) } } }, lookup = createSkinWeightLookup(value);
    const result = lookup(1, [100, 100, 100]); expect(result).toEqual(row(0.123456789123)); result[0].weight = 1;
    expect(value.weights!.overrides["1"][0].weight).toBe(0.123456789123);
    expect(lookup(0, [0, 0, 0])).toHaveLength(4);
    expect(() => lookup(3, [0, 0, 0])).toThrow(/out of range/);
  });
  it("handles fewer influences and validates source positions and counts", () => {
    expect(createSkinWeightLookup(binding(1))(0, [10, 5, 0])).toEqual([{ jointId: "j0", weight: 1 }]);
    expect(createSkinWeightLookup(binding(2))(0, [0.5, 0, 0])).toEqual(row(0.5));
    expect(() => createSkinWeightLookup(binding())(-1, [0, 0, 0])).toThrow();
    expect(() => createSkinWeightLookup(binding())(0, [NaN, 0, 0])).toThrow();
    validateSkinWeightCount(binding(), 0);
    expect(() => validateSkinWeightCount(binding(), 1.5)).toThrow();
    expect(() => validateSkinWeightCount({ ...binding(), weights: { count: 5, overrides: {} } }, 4)).toThrow(/does not match/);
  });
});

describe("normalized skin weight commands", () => {
  it("sets the selected influence exactly and preserves ratios of other weights in one undo step", () => {
    const store = fixture(), before = store.getState().document;
    const source: SkinInfluence[] = [{ jointId: "j0", weight: 0.2 }, { jointId: "j1", weight: 0.3 }, { jointId: "j2", weight: 0.5 }];
    editSkinWeight(store, "shape", [0, 2, 2], "j0", 0.6, { count: 3, getWeights: () => source });
    const weights = stored(store).weights!;
    expect(weights.count).toBe(3); expect(Object.keys(weights.overrides)).toEqual(["0", "2"]);
    for (const result of Object.values(weights.overrides)) {
      expect(result.find(entry => entry.jointId === "j0")!.weight).toBe(0.6);
      expect(result.find(entry => entry.jointId === "j1")!.weight).toBeCloseTo(0.15, 15);
      expect(result.find(entry => entry.jointId === "j2")!.weight).toBeCloseTo(0.25, 15);
      expect(result.reduce((sum, entry) => sum + entry.weight, 0)).toBeCloseTo(1, 15);
    }
    expect(source[0].weight).toBe(0.2); expect(store.temporal.getState().pastStates).toHaveLength(1);
    const after = store.getState().document; store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
  });
  it("adds influences, removes zeros and rigidifies without inventing an influence", () => {
    const store = fixture(), context = { count: 2, getWeights: () => [{ jointId: "j0", weight: 1 }] };
    editSkinWeight(store, "shape", [0], "j1", 0.3, context);
    expect(stored(store).weights!.overrides["0"]).toEqual([{ jointId: "j0", weight: 0.7 }, { jointId: "j1", weight: 0.3 }]);
    editSkinWeight(store, "shape", [0], "j0", 0, context); expect(stored(store).weights!.overrides["0"]).toEqual([{ jointId: "j1", weight: 1 }]);
    expect(() => editSkinWeight(store, "shape", [0], "j1", 0.5, context)).toThrow(/sole influence/);
    editSkinWeight(store, "shape", [0], "j4", 1, context); expect(stored(store).weights!.overrides["0"]).toEqual([{ jointId: "j4", weight: 1 }]);
  });
  it("rejects fifth active influences but permits rigid replacement and removing one first", () => {
    const store = fixture(), four = binding(4).jointIds.map(jointId => ({ jointId, weight: 0.25 })), context = { count: 2, getWeights: () => four };
    const before = store.getState().document;
    expect(() => editSkinWeight(store, "shape", [0], "j4", 0.2, context)).toThrow(/four active/); expect(store.getState().document).toBe(before);
    editSkinWeight(store, "shape", [0], "j0", 0, context); editSkinWeight(store, "shape", [0], "j4", 0.2, context);
    expect(stored(store).weights!.overrides["0"]).toHaveLength(4);
    editSkinWeight(store, "shape", [1], "j4", 1, context); expect(stored(store).weights!.overrides["1"]).toEqual([{ jointId: "j4", weight: 1 }]);
  });
  it("validates the complete batch before committing and preserves no-op identity", () => {
    const store = fixture(), before = store.getState().document;
    expect(() => editSkinWeight(store, "shape", [0, 1], "j0", 0.5, { count: 2, getWeights: index => index === 0 ? row() : [{ jointId: "j0", weight: 1 }] })).toThrow(/sole influence/);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(0);
    editSkinWeight(store, "shape", [0], "j0", 0.25, { count: 2, getWeights: () => row() });
    editSkinWeight(store, "shape", [0], "j4", 0, { count: 2, getWeights: () => row() });
    editSkinWeight(store, "shape", [], "j0", 0.5, { count: 2, getWeights: () => row() });
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(0);
  });
  it("uses authored precise rows and rejects a stale asset component count", () => {
    const store = fixture({ ...binding(), weights: { count: 3, overrides: { "1": row(0.123456789123) } } });
    editSkinWeight(store, "shape", [1], "j0", 0.4, { count: 3, getWeights: () => { throw Error("Authored row should take precedence"); } });
    expect(stored(store).weights!.overrides["1"].find(entry => entry.jointId === "j0")!.weight).toBe(0.4);
    const before = store.getState().document;
    expect(() => editSkinWeight(store, "shape", [0], "j0", 0.4, { count: 4, getWeights: () => row() })).toThrow(/does not match/);
    expect(store.getState().document).toBe(before);
  });
  it("resets selected overrides or all weights back to automatic with undo", () => {
    const store = fixture({ ...binding(), weights: { count: 3, overrides: { "0": row(), "2": row(0.5) } } });
    const before = store.getState().document; resetSkinWeights(store, "shape", [1]); expect(store.getState().document).toBe(before);
    resetSkinWeights(store, "shape", [0]); expect(Object.keys(stored(store).weights!.overrides)).toEqual(["2"]);
    expect(createSkinWeightLookup(stored(store))(0, [0, 0, 0])).toHaveLength(4);
    resetSkinWeights(store, "shape", [2]); expect(stored(store).weights).toBeUndefined();
    store.temporal.getState().undo(); expect(Object.keys(stored(store).weights!.overrides)).toEqual(["2"]);
    resetSkinWeights(store, "shape", null); expect(stored(store).weights).toBeUndefined();
  });
  it("rejects invalid indices, inputs and excessive edit batches without partial state", () => {
    const store = fixture(), before = store.getState().document, context = { count: 3, getWeights: () => row() };
    for (const indices of [[-1], [0.5], [3], [NaN], Array(20001).fill(0)]) expect(() => editSkinWeight(store, "shape", indices, "j0", 0.5, context)).toThrow();
    for (const value of [-0.1, 1.1, NaN, Infinity]) expect(() => editSkinWeight(store, "shape", [0], "j0", value, context)).toThrow();
    expect(() => editSkinWeight(store, "shape", [0], "missing", 0.5, context)).toThrow(/bound joint/);
    expect(() => editSkinWeight(store, "object", [0], "j0", 0.5, context)).toThrow(/bound splat/);
    expect(() => editSkinWeight(store, "shape", [0], "j0", 0.5, { count: 3, getWeights: () => [{ jointId: "j0", weight: 0.1 }] })).toThrow(/normalized/);
    expect(() => resetSkinWeights(store, "shape", Array(20001).fill(0))).toThrow(/20,000/);
    expect(store.getState().document).toBe(before);
  });
  it("enforces the total sparse override cap while allowing edits at the cap", () => {
    const overrides = Object.fromEntries(Array.from({ length: 200000 }, (_, index) => [String(index), row()]));
    const store = fixture({ ...binding(), weights: { count: 200001, overrides } }), before = store.getState().document;
    expect(() => editSkinWeight(store, "shape", [200000], "j0", 0.5, { count: 200001, getWeights: () => row() })).toThrow(/200,000/);
    expect(store.getState().document).toBe(before);
    editSkinWeight(store, "shape", [0], "j0", 0.5, { count: 200001, getWeights: () => row() });
    expect(Object.keys(stored(store).weights!.overrides)).toHaveLength(200000);
    expect(() => validateSkinWeights({ ...binding(), weights: { count: 200001, overrides: { ...overrides, "200000": row() } } })).toThrow(/200,000/);
  });
});

describe("skin weight archive validation", () => {
  it("rejects noncanonical indices, invalid rows, unknown joints and nonnormalized weights", () => {
    const cases: unknown[] = [
      { count: -1, overrides: {} }, { count: 1.5, overrides: {} }, { count: 3, overrides: [] },
      ...["01", "1.0", "1e0", "-0", "-1", "3", "9007199254740992", "__proto__"].map(key => ({ count: 3, overrides: Object.fromEntries([[key, row()]]) })),
      ...[[], [{ jointId: "missing", weight: 1 }], [{ jointId: "j0", weight: 0 }], [{ jointId: "j0", weight: NaN }], [{ jointId: "j0", weight: 0.9 }], [{ jointId: "j0", weight: 0.5 }, { jointId: "j0", weight: 0.5 }], binding().jointIds.map(jointId => ({ jointId, weight: 0.2 }))].map(value => ({ count: 3, overrides: { "0": value } })),
    ];
    for (const weights of cases) expect(() => validateSkinWeights({ ...binding(), weights })).toThrow();
    expect(() => validateSkinWeights({ jointIds: ["j0", "j0"], restMatrices: binding(2).restMatrices })).toThrow();
    expect(() => validateSkinWeights({ ...binding(), restMatrices: [[1, 2]] })).toThrow();
    expect(() => validateSkinWeights({ ...binding(), weights: { count: 0, overrides: {} } })).not.toThrow();
  });
  it("round-trips precise sparse weights and rejects malformed packed archives", async () => {
    const store = fixture({ ...binding(), weights: { count: 10, overrides: { "2": row(0.123456789123) } } });
    const doc = store.getState().document, bytes = await encodeProject(doc, new Map(), editor);
    expect((await decodeProject(bytes)).scene).toEqual(doc);
    for (const change of [(value: any) => value.count = 1, (value: any) => value.overrides["2"][0].weight = 0, (value: any) => value.overrides["2"][0].jointId = "missing"]) {
      const entries = unzipSync(bytes), manifest = JSON.parse(strFromU8(entries["scene.json"])); change(manifest.scene.nodes.shape.binding.weights); entries["scene.json"] = strToU8(JSON.stringify(manifest));
      await expect(decodeProject(zipSync(entries))).rejects.toThrow();
    }
    expect(() => validateScene(doc)).not.toThrow(); // Missing deleted joints still use the existing rest-pose fallback.
  });
  it("round-trips a sparse manifest genuinely larger than the old 4 MiB limit", async () => {
    const four = binding(4).jointIds.map(jointId => ({ jointId, weight: 0.25 }));
    const overrides = Object.fromEntries(Array.from({ length: 40000 }, (_, index) => [String(index), four]));
    const store = fixture({ ...binding(), weights: { count: 40000, overrides } });
    const bytes = await encodeProject(store.getState().document, new Map(), editor);
    expect(unzipSync(bytes)["scene.json"].byteLength).toBeGreaterThan(4 * 1024 * 1024);
    const opened = await decodeProject(bytes), restored = (opened.scene.nodes.shape as SplatShapeNode).binding!.weights!;
    expect(restored.count).toBe(40000); expect(Object.keys(restored.overrides)).toHaveLength(40000); expect(restored.overrides["39999"]).toEqual(four);
  });
});
