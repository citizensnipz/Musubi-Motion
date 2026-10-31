import { describe, expect, it } from "vitest";
import { Euler, MathUtils, Quaternion, Vector3 } from "three";
import { defaultAnimation, evaluateSceneAnimation, type AnimationPose } from "../src/animation.ts";
import { evaluateIK, evaluateRigStages, jointWorldMatrices } from "../src/ik.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { emptyScene, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { validateJoints } from "../src/skeleton.ts";

function fixture(solver: "ccd" | "two-bone" = "two-bone"): SceneDocument {
  return { ...emptyScene(), joints: [
    { id: "base", name: "Base", parentId: null, position: [2, -1, .5], rotation: [20, 30, 10] },
    { id: "root", name: "Root", parentId: "base", position: [0, 0, 0], rotation: [25, -10, 20] },
    { id: "middle", name: "Middle", parentId: "root", position: [0, 1.2, 0], rotation: [10, 0, -20] },
    { id: "end", name: "End", parentId: "middle", position: [0, 1.2, 0], rotation: [10, 20, 30] },
  ], ikHandles: [{ id: "ik", name: "Arm", rootId: "root", endId: "end", target: [2.8, .1, .7],
    poleTarget: [2, -1, 3.5], solver, enabled: true, blend: 1, iterations: 128 }] };
}
function preferences(doc: SceneDocument): SceneDocument {
  return { ...doc, joints: doc.joints!.map(joint => ({ ...joint, preferredAngle: (
    joint.id === "root" ? [-35, 10, 5] : joint.id === "middle" ? [15, 25, 20] : [150, 123, 18]
  ) as Vec3 })) };
}
function solve(doc: SceneDocument, frame = 0) {
  const poses = evaluateSceneAnimation(doc, frame); evaluateRigStages(doc, poses, false, frame); return poses;
}
const rotation = (pose: AnimationPose) => new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3, "XYZ"));
const position = (matrix: import("three").Matrix4) => new Vector3().setFromMatrixPosition(matrix);

describe("explicit joint preferred angles seed IK", () => {
  it.each(["ccd", "two-bone"] as const)("keeps %s behavior unchanged when preferences are absent", solver => {
    const doc = fixture(solver), absent = { ...doc, joints: doc.joints!.map(joint => ({ ...joint, preferredAngle: undefined })) };
    const lowLevel = evaluateSceneAnimation(doc, 0); evaluateIK(doc, lowLevel);
    expect([...solve(absent)]).toEqual([...lowLevel]);
    expect([...solve(doc)]).toEqual([...lowLevel]);
  });

  it.each(["ccd", "two-bone"] as const)("uses nonplanar preferred seeds for %s without moving ancestors, lengths, or local effector rotation", solver => {
    const doc = preferences(fixture(solver)), before = JSON.stringify(doc), fk = evaluateSceneAnimation(doc, 0), poses = solve(doc);
    const world = jointWorldMatrices(doc, poses);
    expect(position(world.get("end")!).distanceTo(new Vector3(...doc.ikHandles![0].target))).toBeLessThan(solver === "ccd" ? .001 : 1e-8);
    expect(position(world.get("middle")!).distanceTo(position(world.get("root")!))).toBeCloseTo(1.2, 10);
    expect(position(world.get("end")!).distanceTo(position(world.get("middle")!))).toBeCloseTo(1.2, 10);
    expect(poses.get("base")).toEqual(fk.get("base")); expect(poses.get("end")!.rotation).toEqual(fk.get("end")!.rotation);
    for (const id of ["root", "middle", "end"]) expect(poses.get(id)!.position).toEqual(fk.get(id)!.position);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it.each(["ccd", "two-bone"] as const)("blends %s from the original animated FK quaternions, not the preference seed", solver => {
    const fullDoc = preferences(fixture(solver)), full = solve(fullDoc), fk = evaluateSceneAnimation(fullDoc, 0);
    const partialDoc = { ...fullDoc, ikHandles: fullDoc.ikHandles!.map(handle => ({ ...handle, blend: .4 })) }, partial = solve(partialDoc);
    for (const id of ["root", "middle"]) {
      const expected = rotation(fk.get(id)!).slerp(rotation(full.get(id)!), .4);
      expect(expected.angleTo(rotation(partial.get(id)!))).toBeLessThan(1e-7);
      const preference = fullDoc.joints!.find(joint => joint.id === id)!.preferredAngle!;
      const wrong = rotation({ ...fk.get(id)!, rotation: preference }).slerp(rotation(full.get(id)!), .4);
      expect(wrong.angleTo(rotation(partial.get(id)!))).toBeGreaterThan(.1);
    }
  });

  it("retains exact FK at blend zero or when disabled despite stored preferences", () => {
    for (const patch of [{ blend: 0 }, { enabled: false }]) {
      const original = preferences(fixture()), doc = { ...original, ikHandles: original.ikHandles!.map(handle => ({ ...handle, ...patch })) };
      const poses = evaluateSceneAnimation(doc, 0), before = new Map(poses); evaluateIK(doc, poses);
      for (const [id, pose] of before) expect(poses.get(id)).toBe(pose);
    }
  });

  it("keeps full and mixed IK orientations continuous across animated FK bend zero crossings", () => {
    const original = fixture();
    original.joints = original.joints!.map(joint => ({ ...joint,
      rotation: joint.id === "root" ? [0, 0, 20] : joint.id === "middle" ? [0, 0, 0] : joint.rotation,
    }));
    original.animation = { ...defaultAnimation(), tracks: [{ id: "bend", targetId: "middle", channel: "rotation.z", keys: [
      { id: "negative", time: 0, value: -1, interpolation: "linear", tangentMode: "auto" },
      { id: "positive", time: 2, value: 1, interpolation: "linear", tangentMode: "auto" },
    ] }] };
    const preferred = { ...original, joints: original.joints!.map(joint => joint.id === "root" || joint.id === "middle"
      ? { ...joint, preferredAngle: (joint.id === "root" ? [0, 0, 20] : [0, 0, 30]) as Vec3 } : joint) };
    const frames = [.9999, 1.0001];
    const legacy = frames.map(frame => solve(original, frame));
    expect(rotation(legacy[0].get("root")!).angleTo(rotation(legacy[1].get("root")!))).toBeGreaterThan(3);
    for (const blend of [1, .8]) {
      const doc = { ...preferred, ikHandles: preferred.ikHandles!.map(handle => ({ ...handle, blend })) };
      const poses = frames.map(frame => solve(doc, frame));
      for (const joint of ["root", "middle"]) expect(rotation(poses[0].get(joint)!).angleTo(rotation(poses[1].get(joint)!))).toBeLessThan(1e-5);
      const endpoints = poses.map(pose => position(jointWorldMatrices(doc, pose).get("end")!));
      expect(endpoints[0].distanceTo(endpoints[1])).toBeLessThan(1e-5);
    }
  });

  it.each(["ccd", "two-bone"] as const)("evaluates %s in arbitrary frame order deterministically", solver => {
    const doc = preferences(fixture(solver));
    doc.animation = { ...defaultAnimation(), tracks: [{ id: "turn", targetId: "root", channel: "rotation.y", keys: [
      { id: "turn0", time: 0, value: -45, interpolation: "linear", tangentMode: "auto" },
      { id: "turn10", time: 10, value: 45, interpolation: "linear", tangentMode: "auto" },
    ] }] };
    doc.ikHandles![0].blend = .5;
    const expected = new Map([0, 3.5, 10].map(frame => [frame, JSON.stringify([...solve(doc, frame)])]));
    for (const frame of [10, 0, 3.5, 10, 3.5, 0]) expect(JSON.stringify([...solve(doc, frame)])).toBe(expected.get(frame));
  });

  it("supports arbitrary non-axis-aligned local bone directions", () => {
    const doc = preferences(fixture());
    doc.joints = doc.joints!.map(joint => joint.id === "middle" ? { ...joint, position: [.5, 1, .3] }
      : joint.id === "end" ? { ...joint, position: [.7, .4, -.1] } : joint);
    const poses = solve(doc), world = jointWorldMatrices(doc, poses);
    expect(position(world.get("end")!).distanceTo(new Vector3(...doc.ikHandles![0].target))).toBeLessThan(1e-8);
    expect(position(world.get("middle")!).distanceTo(position(world.get("root")!))).toBeCloseTo(Math.hypot(.5, 1, .3), 10);
    expect(position(world.get("end")!).distanceTo(position(world.get("middle")!))).toBeCloseTo(Math.hypot(.7, .4, -.1), 10);
  });

  it("applies only preferences authored for links in the current handle", () => {
    const original = fixture(), unrelated = { ...original, joints: original.joints!.map(joint => joint.id === "base" || joint.id === "end"
      ? { ...joint, preferredAngle: [123, 45, 67] as Vec3 } : joint) };
    expect([...solve(unrelated)]).toEqual([...solve(original)]);
    const partial = { ...original, joints: original.joints!.map(joint => joint.id === "middle" ? { ...joint, preferredAngle: [0, 0, 30] as Vec3 } : joint) };
    const poses = solve(partial);
    expect(position(jointWorldMatrices(partial, poses).get("end")!).distanceTo(new Vector3(...original.ikHandles![0].target))).toBeLessThan(1e-8);
  });

  it("validates dense finite preference triples with the same bounds as joint rotation", () => {
    const doc = fixture();
    for (const value of [null, [], [0, 0], [0, 0, 0, 0], [NaN, 0, 0], [0, Infinity, 0], ["0", 0, 0], Array(3)]) {
      const joints = doc.joints!.map(joint => ({ ...joint, preferredAngle: value as Vec3 }));
      expect(() => validateJoints(joints)).toThrow(/preferred angle/);
      expect(() => validateScene({ ...doc, joints })).toThrow(/preferred angle/);
    }
    const large = doc.joints!.map(joint => ({ ...joint, preferredAngle: [720, -360, 1e7] as Vec3 }));
    expect(() => validateJoints(large)).not.toThrow();
  });

  it("preserves preferences through archive readback without aliasing source arrays", async () => {
    const doc = preferences(fixture());
    const opened = await decodeProject(await encodeProject(doc, new Map(), { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: .01, far: 1000 }, time: 0 }));
    expect(opened.scene.joints).toEqual(doc.joints);
    expect(opened.scene.joints![1].preferredAngle).not.toBe(doc.joints![1].preferredAngle);
    expect([...solve(opened.scene)]).toEqual([...solve(doc)]);
  });
});
