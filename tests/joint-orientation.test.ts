import { describe, expect, it } from "vitest";
import { Matrix4, Quaternion, Vector3 } from "three";
import { evaluateSceneAnimation, setKeys } from "../src/animation.ts";
import { constraintWorldMatrices, createConstraint, evaluateConstraints } from "../src/constraints.ts";
import { evaluateIK, jointWorldMatrices, type IKHandle } from "../src/ik.ts";
import { freezeJointRotations, setJointLocalAxes, setJointOrientation } from "../src/joint-orientation.ts";
import { angleQuaternion, jointLocalQuaternion, jointRotationFromQuaternion } from "../src/joint-transform.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { addSplat, emptyScene, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { reparentJoint, validateJoints } from "../src/skeleton.ts";

function fixture(): SceneDocument {
  return { ...emptyScene(), joints: [
    { id: "root", name: "Root", parentId: null, position: [1, 2, 0], orientation: [10, 20, 30], rotation: [5, -15, 25] },
    { id: "mid", name: "Middle", parentId: "root", position: [0, 1, 0], orientation: [15, -10, 20], rotation: [0, 0, 15], preferredAngle: [10, 20, 30] },
    { id: "end", name: "End", parentId: "mid", position: [0, 1, 0], orientation: [10, 5, -5] },
  ] };
}
function sameMatrix(a: Matrix4, b: Matrix4) { a.elements.forEach((value, index) => expect(value).toBeCloseTo(b.elements[index], 9)); }
function worldRotation(matrix: Matrix4) {
  const result = new Quaternion(); matrix.decompose(new Vector3(), result, new Vector3()); return result.normalize();
}
const handle = (solver: "ccd" | "two-bone"): IKHandle => ({ id: "ik", name: "Arm", rootId: "root", endId: "end", target: [1.8, 3, .3],
  enabled: true, blend: 1, iterations: 128, solver, ...(solver === "two-bone" ? { poleTarget: [0, 3, 2] as Vec3 } : {}) });

describe("joint orientation coordinate frames", () => {
  it("composes orientation before animated XYZ rotation and removes it on writeback", () => {
    const joint = fixture().joints![0], expected = angleQuaternion(joint.orientation!).multiply(angleQuaternion(joint.rotation!));
    expect(jointLocalQuaternion(joint, joint.rotation!).angleTo(expected)).toBeLessThan(1e-7);
    expect(expected.angleTo(angleQuaternion(joint.rotation!).multiply(angleQuaternion(joint.orientation!)))).toBeGreaterThan(.01);
    const recovered = jointRotationFromQuaternion(joint, expected, joint.rotation);
    expect(angleQuaternion(recovered).angleTo(angleQuaternion(joint.rotation!))).toBeLessThan(1e-7);
  });

  it("retains authored revolutions when a channel reference is provided", () => {
    const joint = fixture().joints![0], authored: Vec3 = [725, -375, 1105];
    jointRotationFromQuaternion(joint, jointLocalQuaternion(joint, authored), authored).forEach((value, axis) => expect(value).toBeCloseTo(authored[axis], 8));
  });

  it("agrees between IK FK worlds and constraint worlds for all joints", () => {
    const doc = fixture(), poses = evaluateSceneAnimation(doc, 7), ikWorld = jointWorldMatrices(doc, poses), constraintWorld = constraintWorldMatrices(doc, poses);
    for (const [id, matrix] of ikWorld) sameMatrix(matrix, constraintWorld.get(id)!);
  });

  it("preserves legacy zero-orientation worlds", () => {
    const doc = fixture(); for (const joint of doc.joints!) delete joint.orientation;
    const original = jointWorldMatrices(doc), explicit = { ...doc, joints: doc.joints!.map(joint => ({ ...joint, orientation: [0, 0, 0] as Vec3 })) };
    for (const [id, matrix] of original) sameMatrix(matrix, jointWorldMatrices(explicit).get(id)!);
  });

  it("preserves world poses and orientation metadata across reparent and detach", () => {
    const doc = fixture();
    doc.joints!.push({ id: "other", name: "Other", parentId: null, position: [-2, 1, 3], orientation: [20, 30, -15], rotation: [10, 15, 5] });
    const original = jointWorldMatrices(doc);
    const attached = { ...doc, joints: reparentJoint(doc.joints!, "mid", "other") };
    expect(attached.joints.find(j => j.id === "mid")!.orientation).toEqual(doc.joints![1].orientation);
    for (const [id, matrix] of original) sameMatrix(matrix, jointWorldMatrices(attached).get(id)!);
    const detached = { ...attached, joints: reparentJoint(attached.joints, "mid", null) };
    for (const [id, matrix] of original) sameMatrix(matrix, jointWorldMatrices(detached).get(id)!);
  });

  it.each(["ccd", "two-bone"] as const)("solves oriented %s chains and returns rotation-channel values", solver => {
    const doc = fixture(); doc.ikHandles = [handle(solver)];
    const before = JSON.stringify(doc), poses = evaluateSceneAnimation(doc, 0); evaluateIK(doc, poses);
    const world = jointWorldMatrices(doc, poses), target = new Vector3(...doc.ikHandles[0].target);
    expect(new Vector3().setFromMatrixPosition(world.get("end")!).distanceTo(target)).toBeLessThan(.001);
    const again = evaluateSceneAnimation(doc, 50); evaluateIK(doc, again);
    expect(again).toEqual(poses); expect(JSON.stringify(doc)).toBe(before);
    for (const id of ["root", "mid"]) {
      const joint = doc.joints!.find(j => j.id === id)!;
      const localWorld = world.get(id)!.clone();
      if (joint.parentId) localWorld.premultiply(world.get(joint.parentId)!.clone().invert());
      expect(jointLocalQuaternion(joint, poses.get(id)!.rotation).angleTo(worldRotation(localWorld))).toBeLessThan(1e-7);
    }
  });

  it("blends oriented IK from the true FK quaternion and preserves exact zero blend", () => {
    const doc = fixture(); doc.ikHandles = [handle("two-bone")];
    const fk = evaluateSceneAnimation(doc, 0), full = evaluateSceneAnimation(doc, 0); evaluateIK(doc, full);
    const halfDoc = { ...doc, ikHandles: [{ ...doc.ikHandles[0], blend: .5 }] }, half = evaluateSceneAnimation(halfDoc, 0); evaluateIK(halfDoc, half);
    for (const id of ["root", "mid"]) {
      const joint = doc.joints!.find(j => j.id === id)!;
      const expected = jointLocalQuaternion(joint, fk.get(id)!.rotation).slerp(jointLocalQuaternion(joint, full.get(id)!.rotation), .5);
      expect(jointLocalQuaternion(joint, half.get(id)!.rotation).angleTo(expected)).toBeLessThan(1e-7);
    }
    const zeroDoc = { ...doc, ikHandles: [{ ...doc.ikHandles[0], blend: 0 }] }, zero = evaluateSceneAnimation(zeroDoc, 0); evaluateIK(zeroDoc, zero);
    expect(zero).toEqual(fk);
  });

  it.each(["orient", "parent", "aim"] as const)("correctly strips target orientation from %s constraints", type => {
    const doc = fixture();
    doc.nodes.source = { id: "source", type: "transform", name: "Source", parentId: null, position: [4, 3, 2], rotation: [30, -15, 70], scale: [1, 1, 1], rotationOrder: "XYZ" };
    doc.rootIds.push("source");
    const store = createSceneStore(doc), poses = evaluateSceneAnimation(doc, 0);
    createConstraint(store, type, "source", "mid", false, poses);
    const current = store.getState().document; evaluateConstraints(current, poses);
    const world = constraintWorldMatrices(current, poses), actual = worldRotation(world.get("mid")!);
    if (type !== "aim") expect(actual.angleTo(angleQuaternion([30, -15, 70]))).toBeLessThan(1e-7);
    else {
      const direction = new Vector3().setFromMatrixPosition(world.get("source")!).sub(new Vector3().setFromMatrixPosition(world.get("mid")!)).normalize();
      expect(new Vector3(0, 0, 1).applyQuaternion(actual).distanceTo(direction)).toBeLessThan(1e-7);
    }
    for (const [id, matrix] of jointWorldMatrices(current, poses)) sameMatrix(matrix, world.get(id)!);
  });

  it("keeps maintain-offset orientation constraints stable on their initial pose", () => {
    const doc = fixture(), store = createSceneStore(doc), poses = evaluateSceneAnimation(doc, 0), before = constraintWorldMatrices(doc, poses);
    createConstraint(store, "orient", "root", "mid", true, poses);
    evaluateConstraints(store.getState().document, poses);
    for (const [id, matrix] of before) sameMatrix(matrix, constraintWorldMatrices(store.getState().document, poses).get(id)!);
  });
});

describe("joint orientation commands and persistence", () => {
  it("sets orientation in one history step, copies input and skips no-ops", () => {
    const doc = fixture(), store = createSceneStore(doc), value: Vec3 = [30, 45, 60];
    setJointOrientation(store, "root", value); value[0] = 999;
    expect(store.getState().document.joints![0].orientation).toEqual([30, 45, 60]);
    setJointOrientation(store, "root", [30, 45, 60]); expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo(); expect(store.getState().document.joints![0].orientation).toEqual([30, 45, 60]);
  });

  it("persists local-axis visibility independently, validates it and skips default false", async () => {
    const doc = fixture(), store = createSceneStore(doc);
    setJointLocalAxes(store, "mid", false); expect(store.getState().document).toBe(doc);
    setJointLocalAxes(store, "mid", true);
    expect(store.getState().document.joints![1].showLocalAxes).toBe(true);
    const packed = await encodeProject(store.getState().document, new Map(), { camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0 });
    expect((await decodeProject(packed)).scene.joints![1].showLocalAxes).toBe(true);
    expect(() => setJointLocalAxes(store, "mid", 1 as unknown as boolean)).toThrow();
    expect(() => validateJoints([{ ...doc.joints![0], showLocalAxes: "true" as unknown as boolean }])).toThrow(/local-axis/);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo(); expect(store.getState().document.joints![1].showLocalAxes).toBe(true);
  });

  it("freezes multiple local rotations while preserving every descendant matrix and preferred seed", () => {
    const doc = fixture(), store = createSceneStore(doc), before = jointWorldMatrices(doc), preferred = jointLocalQuaternion(doc.joints![1], doc.joints![1].preferredAngle!);
    freezeJointRotations(store, ["root", "mid"]);
    const next = store.getState().document;
    expect(next.joints![0].rotation).toEqual([0, 0, 0]); expect(next.joints![1].rotation).toEqual([0, 0, 0]);
    for (const [id, matrix] of before) sameMatrix(matrix, jointWorldMatrices(next).get(id)!);
    expect(jointLocalQuaternion(next.joints![1], next.joints![1].preferredAngle!).angleTo(preferred)).toBeLessThan(1e-7);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    freezeJointRotations(store, ["root", "mid"]); expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
  });

  it("freezes supplied prepared FK rotations rather than authored or solved poses", () => {
    const doc = fixture(), poses = evaluateSceneAnimation(doc, 0); poses.get("root")!.rotation = [30, 40, 50];
    const before = jointWorldMatrices(doc, poses), store = createSceneStore(doc);
    freezeJointRotations(store, ["root"], poses);
    poses.get("root")!.rotation = [0, 0, 0];
    for (const [id, matrix] of before) sameMatrix(matrix, jointWorldMatrices(store.getState().document, poses).get(id)!);
  });

  it("rejects invalid dense orientation metadata and missing targets atomically", () => {
    const store = createSceneStore(fixture()), before = store.getState().document;
    for (const value of [[NaN, 0, 0], [Infinity, 0, 0], [0, 1], [0, , 0], ["0", 0, 0]]) {
      expect(() => setJointOrientation(store, "root", value as Vec3)).toThrow(/orientation/);
      expect(() => validateJoints([{ ...before.joints![0], orientation: value as Vec3 }])).toThrow(/orientation/);
    }
    expect(() => setJointOrientation(store, "missing", [0, 0, 0])).toThrow();
    expect(() => freezeJointRotations(store, ["root", "missing"])).toThrow();
    expect(() => freezeJointRotations(store, ["root", "root"])).toThrow();
    expect(() => freezeJointRotations(store, ["root"], new Map())).toThrow(/Missing prepared/);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("rejects freezing animated and SDK-owned or SDK-driving rotation channels", () => {
    const doc = fixture(), store = createSceneStore(doc); setKeys(store, ["root"], 0, evaluateSceneAnimation(doc, 0), ["rotation.x"]);
    const animated = store.getState().document; expect(() => freezeJointRotations(store, ["root"])).toThrow(/time curves/);
    expect(store.getState().document).toBe(animated);
    for (const reverse of [false, true]) {
      const a = { targetId: "root", channel: "rotation.x" as const }, b = { targetId: "end", channel: "rotation.z" as const };
      const current = { ...doc, drivenKeys: [{ id: "sdk", driver: reverse ? b : a, driven: reverse ? a : b,
        keys: [{ id: "key", time: 0, value: 0, interpolation: "linear" as const, tangentMode: "auto" as const }] }] };
      const sdk = createSceneStore(current); expect(() => freezeJointRotations(sdk, ["root"])).toThrow(/driven-key/);
      expect(sdk.getState().document).toBe(current);
    }
  });

  it("rejects freezing active IK/rotation constraints and permits disabled solvers", () => {
    const doc = fixture(); doc.ikHandles = [handle("two-bone")];
    const store = createSceneStore(doc); expect(() => freezeJointRotations(store, ["mid"])).toThrow(/Disable IK/);
    const disabled = createSceneStore({ ...doc, ikHandles: [{ ...doc.ikHandles[0], enabled: false }] });
    expect(() => freezeJointRotations(disabled, ["mid"])).not.toThrow();
    const constrained = createSceneStore(fixture()); createConstraint(constrained, "orient", "root", "mid", true);
    expect(() => freezeJointRotations(constrained, ["mid"])).toThrow(/constraints/);
  });

  it("round-trips orientation and frozen rotations through msb", async () => {
    const doc = fixture(), store = createSceneStore(doc); freezeJointRotations(store, ["root", "mid"]);
    const current = store.getState().document;
    const packed = await encodeProject(current, new Map(), { camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0 });
    const opened = await decodeProject(packed);
    expect(opened.scene.joints).toEqual(current.joints);
    for (const [id, matrix] of jointWorldMatrices(current)) sameMatrix(matrix, jointWorldMatrices(opened.scene).get(id)!);
  });

  it("preserves captured skin rest matrices and bone deformation transforms when freezing", async () => {
    const doc = addSplat(fixture(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "Bound splat", [0, 0, 0], "object", "shape").document;
    const shape = doc.nodes.shape;
    if (shape.type !== "splatShape") throw Error("Expected splat fixture");
    const rest = jointWorldMatrices(doc);
    shape.binding = { jointIds: ["root", "mid"], restMatrices: [rest.get("root")!.toArray(), rest.get("mid")!.toArray()] };
    const binding = shape.binding, store = createSceneStore(doc);
    freezeJointRotations(store, ["root", "mid"]);
    const next = store.getState().document;
    expect(next.nodes.shape).toBe(shape); expect(shape.binding).toBe(binding);
    const worlds = jointWorldMatrices(next);
    binding.jointIds.forEach((id, index) => sameMatrix(worlds.get(id)!.clone().multiply(new Matrix4().fromArray(binding.restMatrices[index]).invert()), new Matrix4()));
    const packed = await encodeProject(next, new Map(), { camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0 });
    const reopened = (await decodeProject(packed)).scene.nodes.shape;
    expect(reopened.type === "splatShape" && reopened.binding).toEqual(binding);
  });
});
