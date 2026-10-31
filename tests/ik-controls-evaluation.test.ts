import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { evaluateSceneAnimation, upsertTrack, type AnimationPose } from "../src/animation.ts";
import { createConstraint, evaluateConstraints } from "../src/constraints.ts";
import { evaluateDrivenKeys, setDrivenKey } from "../src/driven-keys.ts";
import { createIKHandle, evaluateIK, evaluateRigStages, getIKTargetPoints, jointWorldMatrices, matchFKToIK, matchIKToFK, updateIKHandle, validateIKHandles, type IKControlLink } from "../src/ik.ts";
import { emptyScene, type SceneDocument, type TransformNode, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

const transform = (id: string, position: Vec3, parentId: string | null = null): TransformNode => ({ id, name: id, type: "transform", parentId, position, rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" });
function fixture() {
  const doc: SceneDocument = { ...emptyScene(), nodes: {
    controlParent: transform("controlParent", [0, 0, 0]), control: transform("control", [1, 1, 0], "controlParent"),
    pole: transform("pole", [0, 0, 3]), source: transform("source", [10, 0, 0]),
  }, rootIds: ["controlParent", "pole", "source"], joints: [
    { id: "base", name: "Base", parentId: null, position: [0, 0, 0] },
    { id: "root", name: "Root", parentId: "base", position: [0, 0, 0] },
    { id: "middle", name: "Middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "End", parentId: "middle", position: [0, 1, 0] },
  ] };
  return createSceneStore(doc);
}
const link = (objectId = "control", offset: Vec3 = [0, 0, 0]): IKControlLink => ({ objectId, offset });
function createLinked(store: ReturnType<typeof fixture>) {
  return createIKHandle(store, "root", "end", [0, 2, 0], { solver: "two-bone", poleTarget: [0, 0, 3], targetControl: link(), poleControl: link("pole") });
}
function inputs(doc: SceneDocument, frame = 0) {
  const poses = evaluateSceneAnimation(doc, frame); evaluateDrivenKeys(doc, poses); return poses;
}
function endPosition(doc: SceneDocument, poses: Map<string, AnimationPose>, id = "end") {
  return new Vector3().setFromMatrixPosition(jointWorldMatrices(doc, poses).get(id)!);
}
function ancestorFixture() {
  const store = fixture();
  createConstraint(store, "point", "source", "base", false);
  createConstraint(store, "point", "base", "control", true);
  return { store, id: createLinked(store) };
}

describe("linked IK control evaluation", () => {
  it("resolves parented animated origins and keeps offsets in world space", () => {
    const store = fixture(), id = createLinked(store);
    updateIKHandle(store, id, { targetControl: link("control", [.25, 0, 0]) });
    upsertTrack(store, { id: "rotation", targetId: "controlParent", channel: "rotation.z", keys: [
      { id: "k0", time: 0, value: 0, interpolation: "linear", tangentMode: "auto" },
      { id: "k1", time: 24, value: 90, interpolation: "linear", tangentMode: "auto" },
    ] });
    const doc = store.getState().document, poses = inputs(doc, 12), before = JSON.stringify(doc);
    evaluateRigStages(doc, poses);
    const points = getIKTargetPoints(doc, poses).get(id)!;
    expect(points.target[0]).toBeCloseTo(.25, 10); expect(points.target[1]).toBeCloseTo(Math.sqrt(2), 10);
    expect(endPosition(doc, poses).distanceTo(new Vector3(...points.target))).toBeLessThan(1e-8);
    expect(points.poleTarget).toEqual([0, 0, 3]); expect(JSON.stringify(doc)).toBe(before);
    points.target[0] = 99; expect(getIKTargetPoints(doc, poses).get(id)!.target[0]).toBeCloseTo(.25, 10);
  });

  it("uses driven-key controller values after the SDK stage", () => {
    const store = fixture(), id = createLinked(store);
    setDrivenKey(store, { targetId: "source", channel: "position.x" }, { targetId: "control", channel: "position.x" }, 0, .25);
    setDrivenKey(store, { targetId: "source", channel: "position.x" }, { targetId: "control", channel: "position.x" }, 20, 1.25);
    const doc = store.getState().document, poses = inputs(doc);
    evaluateRigStages(doc, poses);
    expect(getIKTargetPoints(doc, poses).get(id)!.target).toEqual([.75, 1, 0]);
    expect(endPosition(doc, poses).distanceTo(new Vector3(.75, 1, 0))).toBeLessThan(1e-8);
  });

  it("animates the linked pole while keeping the endpoint on its linked target", () => {
    const store = fixture(), id = createLinked(store);
    upsertTrack(store, { id: "pole-motion", targetId: "pole", channel: "position.z", keys: [
      { id: "p0", time: 0, value: 3, interpolation: "linear", tangentMode: "auto" },
      { id: "p1", time: 24, value: -3, interpolation: "linear", tangentMode: "auto" },
    ] });
    const doc = store.getState().document;
    for (const [frame, sign] of [[0, 1], [24, -1]]) {
      const poses = inputs(doc, frame); evaluateRigStages(doc, poses);
      expect(getIKTargetPoints(doc, poses).get(id)!.poleTarget![2]).toBe(sign * 3);
      expect(endPosition(doc, poses, "middle").z * sign).toBeGreaterThan(.5);
      expect(endPosition(doc, poses).distanceTo(new Vector3(1, 1, 0))).toBeLessThan(1e-8);
    }
  });

  it("solves from the constrained FK ancestor and matches the final displayed controller", () => {
    const { store, id } = ancestorFixture(), doc = store.getState().document, poses = inputs(doc);
    const stages = evaluateRigStages(doc, poses, true);
    expect(stages.fkPoses!.get("base")!.position).toEqual([10, 0, 0]);
    expect(stages.fkPoses!.get("root")!.rotation).toEqual([0, 0, 0]);
    expect(stages.solvedPoses!.get("root")!.rotation).not.toEqual([0, 0, 0]);
    expect(getIKTargetPoints(doc, poses).get(id)!.target).toEqual([11, 1, 0]);
    expect(endPosition(doc, poses).distanceTo(new Vector3(11, 1, 0))).toBeLessThan(1e-8);
  });

  it("prepares a constrained root ancestor even when the target itself is unconstrained", () => {
    const store = fixture();
    createConstraint(store, "point", "source", "base", false);
    const id = createLinked(store); updateIKHandle(store, id, { targetControl: link("control", [10, 0, 0]) });
    const doc = store.getState().document, poses = inputs(doc); evaluateRigStages(doc, poses);
    expect(endPosition(doc, poses).distanceTo(new Vector3(11, 1, 0))).toBeLessThan(1e-8);
  });

  it("moves a shared FK ancestor before both linked and unlinked sibling chains solve", () => {
    const { store } = ancestorFixture();
    const doc = store.getState().document;
    store.setState({ document: { ...doc, joints: [...doc.joints!,
      { id: "root2", name: "Root2", parentId: "base", position: [0, 3, 0] },
      { id: "middle2", name: "Middle2", parentId: "root2", position: [0, 1, 0] },
      { id: "end2", name: "End2", parentId: "middle2", position: [0, 1, 0] },
    ] } });
    createIKHandle(store, "root2", "end2", [11, 4, 0], { solver: "two-bone", poleTarget: [10, 3, 3] });
    const current = store.getState().document, poses = inputs(current); evaluateRigStages(current, poses);
    expect(endPosition(current, poses).distanceTo(new Vector3(11, 1, 0))).toBeLessThan(1e-8);
    expect(endPosition(current, poses, "end2").distanceTo(new Vector3(11, 4, 0))).toBeLessThan(1e-8);
  });

  it("keeps configured-link stage ordering stable while disabled or at blend zero", () => {
    for (const patch of [{ blend: 0 }, { enabled: false }]) {
      const { store, id } = ancestorFixture(); updateIKHandle(store, id, patch);
      const doc = store.getState().document, poses = inputs(doc), stages = evaluateRigStages(doc, poses, true);
      expect(stages.fkPoses!.get("base")!.position).toEqual([10, 0, 0]);
      expect(stages.solvedPoses!.get("root")!.rotation).toEqual([0, 0, 0]);
      expect(endPosition(doc, poses).toArray()).toEqual([10, 2, 0]);
    }
  });

  it("preserves legacy IK-then-constraints order when handles have no links", () => {
    const store = fixture(); createConstraint(store, "point", "source", "base", false);
    createIKHandle(store, "root", "end", [1, 1, 0], { solver: "two-bone", poleTarget: [0, 0, 3] });
    const doc = store.getState().document, actual = inputs(doc), legacy = inputs(doc);
    evaluateIK(doc, legacy); evaluateConstraints(doc, legacy);
    const stages = evaluateRigStages(doc, actual, true);
    expect(stages.fkPoses!.get("base")!.position).toEqual([0, 0, 0]);
    expect([...actual]).toEqual([...legacy]);
  });

  it("does not publish upstream or IK mutations when a later constraint fails", () => {
    const { store } = ancestorFixture();
    const initial = store.getState().document;
    store.setState({ document: { ...initial, rootIds: [...initial.rootIds, "failure"], nodes: { ...initial.nodes, failure: transform("failure", [0, 3, 0]) } } });
    createConstraint(store, "aim", "source", "failure", false);
    const doc = store.getState().document, poses = inputs(doc);
    poses.set("failure", { ...poses.get("failure")!, position: [10, 0, 0] });
    const before = new Map(poses), snapshot = JSON.stringify([...poses]);
    expect(() => evaluateRigStages(doc, poses, true)).toThrow(/coincide/);
    expect(JSON.stringify([...poses])).toBe(snapshot);
    for (const [id, pose] of before) expect(poses.get(id)).toBe(pose);
  });

  it("rejects evaluated linked targets outside finite world bounds atomically", () => {
    for (const enabled of [true, false]) {
      const store = fixture(), id = createLinked(store); updateIKHandle(store, id, { enabled });
      const doc = store.getState().document, poses = inputs(doc);
      poses.set("controlParent", { ...poses.get("controlParent")!, scale: [2e6, 1, 1] });
      const before = JSON.stringify([...poses]);
      expect(() => evaluateRigStages(doc, poses)).toThrow(/1,000,000/);
      expect(JSON.stringify([...poses])).toBe(before);
    }
  });

  it("matches FK to linked IK with a constrained ancestor in one undoable command", () => {
    const { store, id } = ancestorFixture(), before = store.getState().document, solved = inputs(before, 12.5);
    evaluateRigStages(before, solved);
    const expected = endPosition(before, solved), history = store.temporal.getState().pastStates.length;
    matchFKToIK(store, id, 12.5);
    const after = store.getState().document, matched = inputs(after, 12.5); evaluateRigStages(after, matched);
    expect(after.ikHandles![0].blend).toBe(0); expect(after.ikHandles![0].targetControl).toEqual(link());
    expect(after.animation!.tracks).toHaveLength(9); expect(after.animation!.tracks.every(track => track.keys[0].time === 12.5)).toBe(true);
    expect(endPosition(after, matched).distanceTo(expected)).toBeLessThan(1e-8);
    expect(store.temporal.getState().pastStates).toHaveLength(history + 1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
  });

  it("rejects literal matching for linked handles without editing them", () => {
    const store = fixture(), id = createLinked(store), before = store.getState().document, count = store.temporal.getState().pastStates.length;
    expect(() => matchIKToFK(store, id)).toThrow(/linked controls/);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(count);
  });

  it("validates candidate links and copies caller-owned settings", () => {
    const store = fixture(), settings = link(), id = createIKHandle(store, "root", "end", undefined, { targetControl: settings });
    settings.offset[0] = 77; expect(store.getState().document.ikHandles![0].targetControl!.offset).toEqual([0, 0, 0]);
    const before = store.getState().document, count = store.temporal.getState().pastStates.length;
    for (const invalid of [null, {}, { objectId: "root", offset: [0, 0, 0] }, { objectId: "missing", offset: [0, 0, 0] }, link("control", [Infinity, 0, 0]), { objectId: "control", offset: Array(3) }]) {
      expect(() => updateIKHandle(store, id, { targetControl: invalid as IKControlLink })).toThrow();
    }
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(count);
    expect(() => validateIKHandles(before.ikHandles, before)).not.toThrow();
  });

  it("rejects a candidate control link that feeds IK output back into its target", () => {
    const store = fixture(); createConstraint(store, "point", "end", "control", true);
    const id = createIKHandle(store, "root", "end"), before = store.getState().document, count = store.temporal.getState().pastStates.length;
    expect(() => updateIKHandle(store, id, { targetControl: link() })).toThrow(/IK|feedback|depend/i);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(count);
  });
});
