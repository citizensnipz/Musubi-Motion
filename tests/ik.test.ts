import { describe, expect, it } from "vitest";
import { Quaternion, Euler, MathUtils, Vector3 } from "three";
import { evaluateSceneAnimation, upsertTrack, type AnimationPose } from "../src/animation.ts";
import { createIKHandle, deleteIKHandle, evaluateIK, ikChain, jointWorldMatrices, matchFKToIK, matchIKToFK, updateIKHandle, validateIKHandles, type IKHandle } from "../src/ik.ts";
import { evaluateDrivenKeys, setDrivenKey } from "../src/driven-keys.ts";
import { createConstraint, evaluateConstraints, updateConstraint } from "../src/constraints.ts";
import { emptyScene, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture(): SceneDocument {
  return { ...emptyScene(), joints: [
    { id: "root", name: "root", parentId: null, position: [0, 0, 0] },
    { id: "middle", name: "middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "end", parentId: "middle", position: [0, 1, 0] },
  ] };
}
function handle(target: Vec3, patch: Partial<IKHandle> = {}): IKHandle {
  return { id: "handle", name: "Arm", rootId: "root", endId: "end", target, enabled: true, iterations: 128, blend: 1, ...patch };
}
function endpoint(doc: SceneDocument, poses: Map<string, AnimationPose>, id = "end") {
  return new Vector3().setFromMatrixPosition(jointWorldMatrices(doc, poses).get(id)!);
}
function solve(target: Vec3, patch: Partial<IKHandle> = {}) {
  const doc = fixture(); doc.ikHandles = [handle(target, patch)];
  const poses = evaluateSceneAnimation(doc, 0);
  evaluateIK(doc, poses);
  return { doc, poses, end: endpoint(doc, poses) };
}

describe("shared joint IK evaluation", () => {
  it("solves a reachable two-bone target without changing translations or rest data", () => {
    const { doc, poses, end } = solve([1, 1, 0]);
    expect(end.distanceTo(new Vector3(1, 1, 0))).toBeLessThan(0.001);
    expect(poses.get("middle")!.position).toEqual([0, 1, 0]);
    expect(poses.get("end")!.position).toEqual([0, 1, 0]);
    expect(doc.joints![0].rotation).toBeUndefined();
    expect(endpoint(doc, evaluateSceneAnimation(doc, 0)).toArray()).toEqual([0, 2, 0]);
  });
  it("handles straight, reversed, root-coincident and unreachable targets without NaNs", () => {
    for (const target of [[0, 1, 0], [0, -1, 0], [0, 0, 0], [0, 5, 0], [5, 5, 0]] as Vec3[]) {
      const { poses, end } = solve(target);
      expect([...poses.values()].every(pose => pose.rotation.every(Number.isFinite))).toBe(true);
      expect(end.toArray().every(Number.isFinite)).toBe(true);
      expect(end.length()).toBeLessThanOrEqual(2.000001);
      if (new Vector3(...target).length() <= 2) expect(end.distanceTo(new Vector3(...target))).toBeLessThan(0.02);
      else expect(end.distanceTo(new Vector3(...target))).toBeLessThan(new Vector3(...target).length() - 2 + 0.02);
    }
  });
  it("supports longer chains and parent-space transforms", () => {
    const doc = fixture();
    doc.joints!.unshift({ id: "parent", name: "parent", parentId: null, position: [3, 0, 0], rotation: [0, 0, 90] });
    doc.joints![1].parentId = "parent";
    doc.joints!.push({ id: "tip", name: "tip", parentId: "end", position: [0, 1, 0] });
    doc.ikHandles = [handle([2, 1, 1], { endId: "tip" })];
    const poses = evaluateSceneAnimation(doc, 0); evaluateIK(doc, poses);
    expect(endpoint(doc, poses, "tip").distanceTo(new Vector3(2, 1, 1))).toBeLessThan(0.01);
    expect(poses.get("parent")!.rotation).toEqual([0, 0, 90]);
  });
  it("preserves exact FK at zero blend/disabled and uses quaternion blending", () => {
    expect(solve([1, 1, 0], { blend: 0 }).poses.get("root")!.rotation).toEqual([0, 0, 0]);
    expect(solve([1, 1, 0], { enabled: false }).end.toArray()).toEqual([0, 2, 0]);
    const full = solve([1, 1, 0]).poses.get("middle")!.rotation;
    const half = solve([1, 1, 0], { blend: 0.5 }).poses.get("middle")!.rotation;
    const asQuaternion = (degrees: Vec3) => new Quaternion().setFromEuler(new Euler(...degrees.map(MathUtils.degToRad) as Vec3));
    expect(asQuaternion(half).angleTo(new Quaternion().slerp(asQuaternion(full), 0.5))).toBeLessThan(1e-6);
  });
  it("is independent of scrub order and skips collapsed animated bones safely", () => {
    const doc = fixture(); doc.ikHandles = [handle([1, 1, 0])];
    const first = evaluateSceneAnimation(doc, 0); evaluateIK(doc, first);
    const unrelated = evaluateSceneAnimation(doc, 10); unrelated.get("root")!.rotation[2] = 20; evaluateIK(doc, unrelated);
    const repeat = evaluateSceneAnimation(doc, 0); evaluateIK(doc, repeat);
    expect(repeat).toEqual(first);
    const collapsed = evaluateSceneAnimation(doc, 0); collapsed.get("middle")!.position = [0, 0, 0];
    evaluateIK(doc, collapsed);
    expect(collapsed.get("root")!.rotation).toEqual([0, 0, 0]);
  });
});

describe("IK commands and validation", () => {
  it("creates, edits, matches, serializes, deletes and undoes handles", () => {
    const store = createSceneStore(fixture());
    const id = createIKHandle(store, "root", "end");
    expect(store.getState().document.ikHandles![0].target).toEqual([0, 2, 0]);
    updateIKHandle(store, id, { target: [1, 1, 0], blend: 0.5 });
    const poses = evaluateSceneAnimation(store.getState().document, 0); poses.get("root")!.rotation[2] = 90;
    matchIKToFK(store, id, poses);
    expect(store.getState().document.ikHandles![0].target[0]).toBeCloseTo(-2);
    const serialized = JSON.parse(JSON.stringify(store.getState().document));
    expect(() => validateIKHandles(serialized.ikHandles, serialized)).not.toThrow();
    deleteIKHandle(store, id);
    expect(store.getState().document.ikHandles).toEqual([]);
    store.temporal.getState().undo();
    expect(store.getState().document.ikHandles).toHaveLength(1);
    store.temporal.getState().redo();
    expect(store.getState().document.ikHandles).toEqual([]);
  });
  it("rejects bad settings, unrelated roots, collapsed rest bones and overlapping chains atomically", () => {
    const doc = fixture(), store = createSceneStore(doc);
    expect(ikChain(doc, "root", "end")).toEqual(["root", "middle", "end"]);
    for (const invalid of [handle([NaN, 0, 0]), handle([0, 0, 0], { iterations: 0 }), handle([0, 0, 0], { blend: 2 }),
      handle([0, 0, 0], { rootId: "end", endId: "root" }), handle([0, 0, 0], { rootId: "root", endId: "root" })]) {
      expect(() => validateIKHandles([invalid], doc)).toThrow();
    }
    createIKHandle(store, "root", "end");
    const previous = store.getState().document;
    expect(() => createIKHandle(store, "middle", "end")).toThrow(/share joints/);
    expect(store.getState().document).toBe(previous);
    doc.joints![1].position = [0, 0, 0];
    expect(() => validateIKHandles([handle([1, 0, 0])], doc)).toThrow(/nonzero/);
  });
  it("evaluates multiple disjoint chains", () => {
    const doc = fixture();
    doc.joints!.push(...fixture().joints!.map(joint => ({ ...joint, id: `${joint.id}2`, name: `${joint.name}2`, parentId: joint.parentId ? `${joint.parentId}2` : null,
      position: joint.id === "root" ? [3, 0, 0] as Vec3 : joint.position })));
    doc.ikHandles = [handle([1, 1, 0]), handle([4, 1, 0], { id: "other", rootId: "root2", endId: "end2" })];
    validateIKHandles(doc.ikHandles, doc);
    const poses = evaluateSceneAnimation(doc, 0); evaluateIK(doc, poses);
    expect(endpoint(doc, poses).distanceTo(new Vector3(1, 1, 0))).toBeLessThan(0.01);
    expect(endpoint(doc, poses, "end2").distanceTo(new Vector3(4, 1, 0))).toBeLessThan(0.01);
  });
  it("rejects chains moved by another solver's ancestor even if their paths do not intersect", () => {
    const doc = fixture();
    doc.joints!.push({ id: "branch", name: "branch", parentId: "root", position: [1, 0, 0] },
      { id: "branchEnd", name: "branchEnd", parentId: "branch", position: [1, 0, 0] });
    expect(() => validateIKHandles([handle([1, 1, 0]), handle([1, 1, 0], { id: "other", rootId: "branch", endId: "branchEnd" })], doc)).toThrow(/ancestors/);
  });
  it("measures repeated multi-chain evaluation without changing scene data", () => {
    const doc = emptyScene(); doc.joints = []; doc.ikHandles = [];
    for (let index = 0; index < 20; index++) {
      doc.joints.push(...fixture().joints!.map(joint => ({ ...joint, id: `${joint.id}${index}`, name: `${joint.name}${index}`,
        parentId: joint.parentId ? `${joint.parentId}${index}` : null,
        position: joint.id === "root" ? [index * 3, 0, 0] as Vec3 : joint.position })));
      doc.ikHandles.push(handle([index * 3 + 0.7, 1.2, 0.3], { id: `handle${index}`, rootId: `root${index}`, endId: `end${index}`, iterations: 64 }));
    }
    const original = JSON.stringify(doc), started = performance.now();
    for (let frame = 0; frame < 100; frame++) evaluateIK(doc, evaluateSceneAnimation(doc, frame));
    console.info(`IK benchmark: 20 three-joint chains × 100 evaluations in ${(performance.now() - started).toFixed(1)} ms`);
    expect(JSON.stringify(doc)).toBe(original);
  });
});

describe("matching FK to solved IK", () => {
  function solvedPose(doc: SceneDocument, frame: number) {
    const poses = evaluateSceneAnimation(doc, frame); evaluateDrivenKeys(doc, poses); evaluateIK(doc, poses); return poses;
  }
  function expectChainWorldEqual(before: SceneDocument, beforePose: Map<string, AnimationPose>, after: SceneDocument, afterPose: Map<string, AnimationPose>) {
    const a = jointWorldMatrices(before, beforePose), b = jointWorldMatrices(after, afterPose);
    for (const id of ["root", "middle", "end"]) a.get(id)!.elements.forEach((value, index) => expect(b.get(id)!.elements[index]).toBeCloseTo(value, 8));
  }
  it("keys all chain rotations and switches blend to FK as one undoable, serializable operation", () => {
    const store = createSceneStore(fixture()), id = createIKHandle(store, "root", "end", [1, 1, 0]);
    const before = store.getState().document, solved = solvedPose(before, 12.5);
    store.temporal.getState().clear(); matchFKToIK(store, id, 12.5);
    const after = store.getState().document;
    expect(after.ikHandles![0]).toMatchObject({ enabled: true, blend: 0 });
    expect(after.animation!.tracks).toHaveLength(9);
    expect(after.animation!.tracks.every(track => track.channel.startsWith("rotation.") && track.keys.length === 1 && track.keys[0].time === 12.5)).toBe(true);
    expect(after.joints).toBe(before.joints);
    expectChainWorldEqual(before, solved, after, solvedPose(after, 12.5));
    const roundTrip = JSON.parse(JSON.stringify(after)); expectChainWorldEqual(after, solvedPose(after, 12.5), roundTrip, solvedPose(roundTrip, 12.5));
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
  });
  it("retains full-turn Euler continuity using the provided pre-IK reference", () => {
    const doc = fixture(); doc.joints![0].rotation = [0, 0, 720]; doc.joints![1].rotation = [0, 0, 720]; doc.joints![2].rotation = [0, 0, 360];
    const store = createSceneStore(doc), id = createIKHandle(store, "root", "end", [1, 1, 0]);
    const before = store.getState().document, reference = evaluateSceneAnimation(before, 5); reference.get("root")!.rotation = [0, 0, 1080];
    const solved = new Map(reference); evaluateIK(before, solved);
    matchFKToIK(store, id, 5, solved, reference);
    const result = evaluateSceneAnimation(store.getState().document, 5);
    expect(Math.abs(result.get("root")!.rotation[2] - 1080)).toBeLessThan(180);
    expect(Math.abs(result.get("middle")!.rotation[2] - 720)).toBeLessThan(180);
    expect(result.get("end")!.rotation[2]).toBe(360);
    expectChainWorldEqual(before, solved, store.getState().document, result);
  });
  it("captures a partially blended solution under a rotated and translated parent", () => {
    const doc = fixture(); doc.joints![0].parentId = "parent";
    doc.joints!.push({ id: "parent", name: "parent", parentId: null, position: [2, -3, 1], rotation: [25, -30, 15] });
    const store = createSceneStore(doc), id = createIKHandle(store, "root", "end", [3, -2, 2]); updateIKHandle(store, id, { blend: 0.35 });
    const before = store.getState().document, solved = solvedPose(before, 14);
    matchFKToIK(store, id, 14);
    expectChainWorldEqual(before, solved, store.getState().document, solvedPose(store.getState().document, 14));
    expect(store.getState().document.animation!.tracks.some(track => track.targetId === "parent")).toBe(false);
  });
  it("preserves existing key IDs and tangent settings at fractional frames outside playback range", () => {
    const store = createSceneStore(fixture()), id = createIKHandle(store, "root", "end", [1, 1, 0]);
    upsertTrack(store, { id: "rotation-track", targetId: "middle", channel: "rotation.z", keys: [
      { id: "existing-key", time: -3.25, value: 730, interpolation: "linear", tangentMode: "fixed", inSlope: 1, outSlope: 2, inWeight: 0.2, outWeight: 0.4, broken: true },
    ] });
    matchFKToIK(store, id, -3.25);
    expect(store.getState().document.animation!.tracks.find(track => track.id === "rotation-track")!.keys[0]).toMatchObject({
      id: "existing-key", time: -3.25, interpolation: "linear", tangentMode: "fixed", inSlope: 1, outSlope: 2, inWeight: 0.2, outWeight: 0.4, broken: true,
    });
    expect(store.getState().document.animation!.start).toBe(0);
  });
  it("rejects driven-key rotation ownership and active rotation constraints atomically", () => {
    const store = createSceneStore(fixture()), id = createIKHandle(store, "root", "end", [1, 1, 0]);
    setDrivenKey(store, { targetId: "root", channel: "position.x" }, { targetId: "middle", channel: "rotation.x" }, 0, 0);
    const before = store.getState().document;
    expect(() => matchFKToIK(store, id, 0)).toThrow(/driven-key rotation/); expect(store.getState().document).toBe(before);
    for (const type of ["orient", "aim", "parent"] as const) {
      const doc = fixture(); doc.joints!.push({ id: "control", name: "control", parentId: null, position: [3, 3, 0] });
      const constrained = createSceneStore(doc), handleId = createIKHandle(constrained, "root", "end", [1, 1, 0]);
      const constraintId = createConstraint(constrained, type, "control", "middle", false);
      const original = constrained.getState().document;
      expect(() => matchFKToIK(constrained, handleId, 0)).toThrow(/active rotation constraint/); expect(constrained.getState().document).toBe(original);
      updateConstraint(constrained, constraintId, { enabled: false });
      expect(() => matchFKToIK(constrained, handleId, 0)).not.toThrow();
    }
  });
  it("rejects unkeyed position previews instead of silently moving the chain", () => {
    const store = createSceneStore(fixture()), id = createIKHandle(store, "root", "end", [1, 1, 0]), doc = store.getState().document;
    const reference = evaluateSceneAnimation(doc, 0); reference.get("root")!.position = [1, 0, 0];
    const solved = new Map(reference); evaluateIK(doc, solved);
    const history = store.temporal.getState().pastStates.length;
    expect(() => matchFKToIK(store, id, 0, solved, reference)).toThrow(/Key any position previews/);
    expect(store.getState().document).toBe(doc); expect(store.temporal.getState().pastStates).toHaveLength(history);
  });
  it("rejects SDK dependencies driven by newly keyed rotations when they change chain positions", () => {
    const store = createSceneStore(fixture()), id = createIKHandle(store, "root", "end", [1, 1, 0]);
    const driver = { targetId: "middle", channel: "rotation.z" as const }, driven = { targetId: "end", channel: "position.y" as const };
    setDrivenKey(store, driver, driven, 0, 1); setDrivenKey(store, driver, driven, -90, 2);
    const before = store.getState().document;
    expect(() => matchFKToIK(store, id, 0)).toThrow(/driven or constraint dependencies/);
    expect(store.getState().document).toBe(before);
  });
  it("verifies final constrained poses for rotation-to-SDK-to-point dependency chains", () => {
    const doc = fixture(); doc.nodes.control = { id: "control", name: "control", type: "transform", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
    const store = createSceneStore(doc), id = createIKHandle(store, "root", "end", [1, 1, 0]);
    const driver = { targetId: "middle", channel: "rotation.z" as const }, driven = { targetId: "control", channel: "position.x" as const };
    setDrivenKey(store, driver, driven, 0, 0); setDrivenKey(store, driver, driven, -90, 3);
    createConstraint(store, "point", "control", "root", false);
    const before = store.getState().document;
    expect(() => matchFKToIK(store, id, 0)).toThrow(/driven or constraint dependencies/);
    expect(store.getState().document).toBe(before);
  });
  it("allows benign point constraints when both underlying and final poses are preserved", () => {
    const doc = fixture(); doc.joints!.push({ id: "control", name: "control", parentId: null, position: [3, 3, 0] });
    const store = createSceneStore(doc), id = createIKHandle(store, "root", "end", [1, 1, 0]);
    createConstraint(store, "point", "control", "root", false);
    const before = store.getState().document, expected = solvedPose(before, 0); evaluateConstraints(before, expected);
    matchFKToIK(store, id, 0);
    const after = store.getState().document, actual = solvedPose(after, 0); evaluateConstraints(after, actual);
    expectChainWorldEqual(before, expected, after, actual);
  });
  it("validates frames, active blend and supplied pose completeness before editing", () => {
    const store = createSceneStore(fixture()), id = createIKHandle(store, "root", "end", [1, 1, 0]), before = store.getState().document;
    for (const frame of [NaN, Infinity, -Infinity, 1000001, -1000001]) expect(() => matchFKToIK(store, id, frame)).toThrow(/match frame/);
    expect(() => matchFKToIK(store, "missing", 0)).toThrow(/does not exist/);
    expect(() => matchFKToIK(store, id, 0, new Map())).toThrow(/incomplete/);
    const malformed = solvedPose(before, 0); malformed.get("root")!.rotation[0] = NaN;
    expect(() => matchFKToIK(store, id, 0, malformed)).toThrow(/finite transforms/);
    expect(store.getState().document).toBe(before);
    updateIKHandle(store, id, { enabled: false }); expect(() => matchFKToIK(store, id, 0)).toThrow(/Enable the IK handle/);
    updateIKHandle(store, id, { enabled: true, blend: 0 }); expect(() => matchFKToIK(store, id, 0)).toThrow(/above zero/);
  });
});
