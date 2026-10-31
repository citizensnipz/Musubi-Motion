import { describe, expect, it } from "vitest";
import { addSplat, deleteSceneItems, emptyScene, serializeScene } from "../src/scene-document.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { defaultAnimation, evaluateChannels, type CurveKey } from "../src/animation.ts";
import { deleteDrivenKeys, evaluateDrivenKeys, removeDrivenRelationship, setDrivenKey, upsertDrivenRelationship, validateDrivenKeys,
  type DrivenKeyRelationship, type DrivenProperty, type EvaluatedPose } from "../src/driven-keys.ts";

function fixture() {
  let document = emptyScene();
  for (const id of ["a", "b", "c"]) document = addSplat(document, { id: `asset-${id}`, kind: "procedural", generator: "knot-v1" }, id, [0, 0, 0], id, `shape-${id}`).document;
  document.joints = [{ id: "joint", name: "joint", parentId: null, position: [0, 0, 0] }];
  return createSceneStore(document);
}
const prop = (targetId: string, channel: DrivenProperty["channel"] = "position.x"): DrivenProperty => ({ targetId, channel });
const key = (id: string, time: number, value: number): CurveKey => ({ id, time, value, interpolation: "linear", tangentMode: "auto" });
const relation = (id: string, driver: DrivenProperty, driven: DrivenProperty, keys = [key(`key-${id}`, 0, 0)]): DrivenKeyRelationship => ({ id, driver, driven, keys });
function poses(store: ReturnType<typeof fixture>, frame = 0) {
  const doc = store.getState().document;
  return new Map<string, EvaluatedPose>(["a", "b", "c", "joint"].map(id => [id, evaluateChannels(doc, id, frame)]));
}

describe("Set Driven Key", () => {
  it("interpolates fractional and negative driver values, holds endpoints, and preserves the authored scene", () => {
    const store = fixture();
    setDrivenKey(store, prop("a"), prop("b", "rotation.z"), -0.5, -90);
    setDrivenKey(store, prop("a"), prop("b", "rotation.z"), 0.5, 90);
    const doc = store.getState().document, before = serializeScene(doc);
    for (const [x, expected] of [[-1, -90], [-0.25, -45], [0, 0], [0.25, 45], [2, 90]]) {
      const current = poses(store); current.get("a")!.position[0] = x;
      evaluateDrivenKeys(doc, current);
      expect(current.get("b")!.rotation[2]).toBeCloseTo(expected);
    }
    expect(serializeScene(doc)).toBe(before);
    expect(JSON.parse(before).drivenKeys).toEqual(doc.drivenKeys);
  });

  it("evaluates chained properties independent of relationship order, with fanout and same-object connections", () => {
    const store = fixture();
    setDrivenKey(store, prop("b"), prop("c"), 0, 0); setDrivenKey(store, prop("b"), prop("c"), 10, 100);
    setDrivenKey(store, prop("a"), prop("b"), 0, 0); setDrivenKey(store, prop("a"), prop("b"), 1, 10);
    setDrivenKey(store, prop("a"), prop("a", "rotation.x"), 0, 0); setDrivenKey(store, prop("a"), prop("a", "rotation.x"), 1, 180);
    setDrivenKey(store, prop("a"), prop("joint", "rotation.y"), 0, 0); setDrivenKey(store, prop("a"), prop("joint", "rotation.y"), 1, 90);
    const current = poses(store); current.get("a")!.position[0] = 0.5;
    evaluateDrivenKeys(store.getState().document, current);
    expect(current.get("b")!.position[0]).toBe(5);
    expect(current.get("c")!.position[0]).toBe(50);
    expect(current.get("a")!.rotation[0]).toBe(90);
    expect(current.get("joint")!.rotation[1]).toBe(45);
  });

  it("applies time curves before driven curves", () => {
    const store = fixture();
    const doc = store.getState().document;
    store.setState({ document: { ...doc, animation: { ...defaultAnimation(), tracks: [{ id: "track", targetId: "a", channel: "position.x", keys: [key("t0", 0, 0), key("t10", 10, 1)] }] } } });
    setDrivenKey(store, prop("a"), prop("b", "rotation.y"), 0, 0);
    setDrivenKey(store, prop("a"), prop("b", "rotation.y"), 1, 360);
    const current = poses(store, 5); evaluateDrivenKeys(store.getState().document, current);
    expect(current.get("b")!.rotation[1]).toBe(180);
  });

  it("rejects self-cycles, indirect cycles, duplicate outputs and time-key ownership atomically", () => {
    const store = fixture();
    expect(() => setDrivenKey(store, prop("a"), prop("a"), 0, 1)).toThrow(/cycle/);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    setDrivenKey(store, prop("a"), prop("b"), 0, 0);
    setDrivenKey(store, prop("b"), prop("c"), 0, 0);
    const before = store.getState().document;
    expect(() => setDrivenKey(store, prop("c"), prop("a"), 0, 0)).toThrow(/cycle/);
    expect(() => setDrivenKey(store, prop("c"), prop("b"), 0, 0)).toThrow(/different driver/);
    expect(() => upsertDrivenRelationship(store, relation("second", prop("c"), prop("b")))).toThrow(/one driver/);
    expect(store.getState().document).toBe(before);
    const animated = { ...before, animation: { ...defaultAnimation(), tracks: [{ id: "track", targetId: "b", channel: "position.x" as const, keys: [key("time-key", 0, 0)] }] } };
    expect(() => validateDrivenKeys(before.drivenKeys, animated)).toThrow(/time keys/);
  });

  it("replaces a value pair by driver value, preserves its ID, supports undo/redo and ignores no-ops", () => {
    const store = fixture();
    setDrivenKey(store, prop("a"), prop("b"), 0.125, 5);
    const first = store.getState().document, id = first.drivenKeys![0].keys[0].id;
    setDrivenKey(store, prop("a"), prop("b"), 0.125, 7);
    expect(store.getState().document.drivenKeys![0].keys).toEqual([expect.objectContaining({ id, time: 0.125, value: 7 })]);
    expect(store.temporal.getState().pastStates).toHaveLength(2);
    setDrivenKey(store, prop("a"), prop("b"), 0.125, 7);
    expect(store.temporal.getState().pastStates).toHaveLength(2);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(first);
    store.temporal.getState().redo(); expect(store.getState().document.drivenKeys![0].keys[0].value).toBe(7);
  });

  it("edits Bezier tangent presets and deletes final keys without retaining an empty dependency", () => {
    const store = fixture();
    setDrivenKey(store, prop("a"), prop("b"), 0, 0); setDrivenKey(store, prop("a"), prop("b"), 1, 1);
    const original = store.getState().document.drivenKeys![0];
    upsertDrivenRelationship(store, { ...original, keys: original.keys.map(item => ({ ...item, interpolation: "bezier", tangentMode: "flat" })) });
    const current = poses(store); current.get("a")!.position[0] = 0.25;
    evaluateDrivenKeys(store.getState().document, current);
    expect(current.get("b")!.position[0]).toBeCloseTo(0.15625, 5);
    deleteDrivenKeys(store, original.id, [original.keys[0].id]); expect(store.getState().document.drivenKeys![0].keys).toHaveLength(1);
    deleteDrivenKeys(store, original.id, [original.keys[1].id]); expect(store.getState().document.drivenKeys).toEqual([]);
    store.temporal.getState().undo(); expect(store.getState().document.drivenKeys).toHaveLength(1);
    removeDrivenRelationship(store, original.id); expect(store.getState().document.drivenKeys).toEqual([]);
  });

  it("validates malformed archives, missing targets, unsupported channels, duplicate IDs and invalid values", () => {
    const doc = fixture().getState().document;
    for (const bad of [null, {}, [null], [relation("r", prop("missing"), prop("b"))], [relation("r", prop("a"), prop("joint", "scale.x"))],
      [relation("r", prop("a"), prop("b"), [])], [relation("r", prop("a"), prop("b"), [key("k", NaN, 0)])],
      [relation("r", prop("a"), prop("b"), [key("k", 0, Infinity)])],
      [relation("r", prop("a"), prop("b"), [key("k", 0, 0), key("k2", 0, 1)])],
      [relation("r", prop("a"), prop("b")), relation("r", prop("a"), prop("c"))],
      [relation("r", prop("a"), prop("b"), [key("k", 0, 0)]), relation("s", prop("a"), prop("c"), [key("k", 0, 0)])],
      [relation("r", prop("a"), prop("b", "visibility"), [key("k", 0, 2)])],
      [relation("r", prop("a"), prop("b", "scale.x"), [key("k", 0, -1)])],
    ]) expect(() => validateDrivenKeys(bad, doc)).toThrow();
  });

  it("uses stepped visibility and clamps Bezier scale overshoot without changing curve data", () => {
    const store = fixture();
    setDrivenKey(store, prop("a"), prop("b", "visibility"), 0, 0); setDrivenKey(store, prop("a"), prop("b", "visibility"), 1, 1);
    const current = poses(store); current.get("a")!.position[0] = 0.5; evaluateDrivenKeys(store.getState().document, current);
    expect(current.get("b")!.visibility).toBe(0);
    upsertDrivenRelationship(store, relation("scale", prop("a"), prop("c", "scale.x"), [
      { ...key("scale0", 0, 1), interpolation: "bezier", tangentMode: "fixed", outSlope: -20 },
      { ...key("scale1", 1, 1), interpolation: "bezier", tangentMode: "fixed", inSlope: 20 },
    ]));
    evaluateDrivenKeys(store.getState().document, current); expect(current.get("c")!.scale[0]).toBe(0.001);
  });

  it("round-trips portable scene archives and removes orphaned relationships when deleting a target", async () => {
    const store = fixture();
    setDrivenKey(store, prop("a"), prop("b", "rotation.x"), -1.5, -90);
    setDrivenKey(store, prop("a"), prop("b", "rotation.x"), 1.5, 90);
    setDrivenKey(store, prop("b", "rotation.x"), prop("joint", "rotation.z"), 0, 0);
    const doc = store.getState().document;
    const packed = await encodeProject(doc, new Map(), { camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: 0.01, far: 1000 }, time: 0 });
    const opened = await decodeProject(packed);
    expect(opened.scene.drivenKeys).toEqual(doc.drivenKeys);
    const remaining = deleteSceneItems(doc, ["b"]);
    expect(remaining.drivenKeys).toEqual([]);
    expect(() => validateScene(remaining)).not.toThrow();
  });
});
