import { describe, expect, it } from "vitest";
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import { emptyScene, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { evaluateSceneAnimation, type AnimationPose } from "../src/animation.ts";
import { createIKHandle, defaultPoleTarget, evaluateIK, jointWorldMatrices, matchFKToIK, matchIKToFK, updateIKHandle, validateIKHandles } from "../src/ik.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";

function fixture(upper: Vec3 = [0, 1, 0], lower: Vec3 = [0, 1, 0]): SceneDocument {
  return { ...emptyScene(), joints: [
    { id: "root", name: "Root", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0] },
    { id: "middle", name: "Middle", parentId: "root", position: upper, rotation: [0, 0, 0] },
    { id: "end", name: "End", parentId: "middle", position: lower, rotation: [20, 10, 30] },
  ] };
}
function solve(doc: SceneDocument, target: Vec3, poleTarget: Vec3, blend = 1) {
  const store = createSceneStore(doc), id = createIKHandle(store, "root", "end", target, { solver: "two-bone", poleTarget });
  if (blend !== 1) updateIKHandle(store, id, { blend });
  const result = store.getState().document, poses = evaluateSceneAnimation(result, 0); evaluateIK(result, poses);
  return { doc: result, poses, store, id, worlds: jointWorldMatrices(result, poses) };
}
const position = (worlds: Map<string, Matrix4>, id: string) => new Vector3().setFromMatrixPosition(worlds.get(id)!);
const quaternion = (pose: AnimationPose) => new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3));

describe("analytic two-bone IK with pole targets", () => {
  it("reaches targets while choosing opposite bend sides from opposite poles", () => {
    const doc = fixture();
    for (const sign of [-1, 1]) {
      const result = solve(doc, [1, 1, 0], [0, 0, sign * 3]);
      expect(position(result.worlds, "end").distanceTo(new Vector3(1, 1, 0))).toBeLessThan(1e-8);
      expect(position(result.worlds, "middle").z * sign).toBeGreaterThan(0.5);
      expect(result.poses.get("middle")!.position).toEqual([0, 1, 0]); expect(result.poses.get("end")!.position).toEqual([0, 1, 0]);
      expect(result.poses.get("end")!.rotation).toEqual([20, 10, 30]);
    }
    expect(doc.joints![0].rotation).toEqual([0, 0, 0]);
  });
  it("clamps unreachable and too-close targets to the chain reach interval without stretching", () => {
    for (const [target, expectedDistance] of [[[10, 0, 0], 3], [[0.1, 0, 0], 1], [[0, 0, 0], 1]] as [Vec3, number][]) {
      const result = solve(fixture([0, 2, 0], [0, 1, 0]), target, [0, 0, 3]);
      const root = position(result.worlds, "root"), middle = position(result.worlds, "middle"), end = position(result.worlds, "end");
      expect(root.distanceTo(end)).toBeCloseTo(expectedDistance, 8); expect(root.distanceTo(middle)).toBeCloseTo(2, 8); expect(middle.distanceTo(end)).toBeCloseTo(1, 8);
      if (target[0] > 0) expect(end.x).toBeCloseTo(expectedDistance, 8);
    }
    const folded = solve(fixture(), [0, 0, 0], [0, 0, 3]); expect(position(folded.worlds, "end").length()).toBeLessThan(1e-8);
  });
  it("handles reversed targets, coincident poles and parallel poles deterministically", () => {
    for (const target of [[0, -1, 0], [0, 1, 0], [0, 0, 0]] as Vec3[]) for (const pole of [[0, 0, 0], [0, 3, 0], [0, -3, 0]] as Vec3[]) {
      const a = solve(fixture(), target, pole), b = solve(fixture(), target, pole);
      expect(position(a.worlds, "end").distanceTo(new Vector3(...target))).toBeLessThan(1e-7);
      for (const id of ["root", "middle", "end"]) { expect(a.poses.get(id)!.rotation.every(Number.isFinite)).toBe(true); expect(a.poses.get(id)).toEqual(b.poses.get(id)); }
    }
  });
  it("supports arbitrary local bone axes and rotated, translated parent chains", () => {
    const doc = fixture([1, 0.2, -0.3], [-0.1, 0.8, 0.4]);
    doc.joints![0].parentId = "parent"; doc.joints![0].rotation = [25, -15, 40]; doc.joints![1].rotation = [-20, 35, 10];
    doc.joints!.push({ id: "parent", name: "Parent", parentId: null, position: [3, -2, 1], rotation: [35, 40, -20] });
    const root = position(jointWorldMatrices(doc), "root"), target = root.clone().add(new Vector3(0.4, 0.6, 0.8)), pole = root.clone().add(new Vector3(3, -1, 2));
    const result = solve(doc, target.toArray() as Vec3, pole.toArray() as Vec3);
    expect(position(result.worlds, "end").distanceTo(target)).toBeLessThan(1e-7);
    expect(result.poses.get("parent")!.rotation).toEqual([35, 40, -20]);
    expect(position(result.worlds, "middle").distanceTo(root)).toBeCloseTo(Math.hypot(1, 0.2, -0.3), 8);
  });
  it("keeps exact FK at zero blend and uses the existing local quaternion blend", () => {
    const doc = fixture(), fk = solve(doc, [1, 1, 0], [0, 0, 3], 0), full = solve(doc, [1, 1, 0], [0, 0, 3]), half = solve(doc, [1, 1, 0], [0, 0, 3], 0.5);
    expect(fk.poses).toEqual(evaluateSceneAnimation(doc, 0));
    for (const id of ["root", "middle"]) {
      const expected = quaternion(fk.poses.get(id)!).slerp(quaternion(full.poses.get(id)!), 0.5);
      expect(quaternion(half.poses.get(id)!).angleTo(expected)).toBeLessThan(1e-7);
    }
  });
  it("reaches varied targets from differently oriented FK hinges and retains the requested pole side", () => {
    for (let index = 1; index <= 48; index++) {
      const upper: Vec3 = [0.5 + Math.abs(Math.sin(index)), Math.cos(index * 0.7), Math.sin(index * 0.3)];
      const lower: Vec3 = [Math.cos(index * 0.4), 0.5 + Math.abs(Math.sin(index * 0.8)), Math.sin(index * 0.9)];
      const doc = fixture(upper, lower); doc.joints![0].rotation = [index * 13, index * -17, index * 29]; doc.joints![1].rotation = [index * -23, index * 19, index * 31];
      const a = Math.hypot(...upper), b = Math.hypot(...lower), distance = Math.abs(a - b) + 2 * Math.min(a, b) * (0.15 + 0.7 * Math.sin(index) ** 2);
      const direction = new Vector3(Math.cos(index), Math.sin(index), 0.4).normalize(), target = direction.clone().multiplyScalar(distance);
      const pole = new Vector3().crossVectors(direction, new Vector3(0, 0, 1)).multiplyScalar(3);
      const result = solve(doc, target.toArray() as Vec3, pole.toArray() as Vec3);
      expect(position(result.worlds, "end").distanceTo(target)).toBeLessThan(1e-7);
      expect(position(result.worlds, "middle").dot(pole)).toBeGreaterThan(0);
    }
  });
  it("skips collapsed animated segments safely and does not depend on previous evaluations", () => {
    const result = solve(fixture(), [1, 1, 0], [0, 0, 3]);
    const collapsed = evaluateSceneAnimation(result.doc, 0); collapsed.get("middle")!.position = [0, 0, 0];
    const before = structuredClone([...collapsed]); evaluateIK(result.doc, collapsed); expect([...collapsed]).toEqual(before);
    const again = evaluateSceneAnimation(result.doc, 0); evaluateIK(result.doc, again); expect(again).toEqual(result.poses);
  });
  it("derives current FK poles and matches both target and pole without changing the displayed bend", () => {
    const doc = fixture(); doc.joints![0].rotation = [15, 25, 30]; doc.joints![1].rotation = [0, 0, -70];
    const store = createSceneStore(doc), id = createIKHandle(store, "root", "end", [1, 0, 0], { solver: "two-bone" });
    const poses = evaluateSceneAnimation(doc, 0), before = jointWorldMatrices(doc, poses);
    const expectedPole = defaultPoleTarget(doc, "root", "end", poses); expect(expectedPole.every(Number.isFinite)).toBe(true);
    matchIKToFK(store, id, poses); expect(store.getState().document.ikHandles![0].poleTarget).toEqual(expectedPole);
    evaluateIK(store.getState().document, poses); const after = jointWorldMatrices(store.getState().document, poses);
    for (const jointId of ["root", "middle", "end"]) before.get(jointId)!.elements.forEach((value, index) => expect(after.get(jointId)!.elements[index]).toBeCloseTo(value, 7));
    expect(defaultPoleTarget(fixture(), "root", "end")).toEqual(defaultPoleTarget(fixture(), "root", "end"));
  });
  it("retains match-FK-to-IK keying, full turns and a single history step", () => {
    const doc = fixture(); doc.joints![0].rotation = [0, 0, 720];
    const result = solve(doc, [1, 1, 0], [0, 0, 3]); result.store.temporal.getState().clear();
    matchFKToIK(result.store, result.id, 5.5, result.poses);
    const after = result.store.getState().document, poses = evaluateSceneAnimation(after, 5.5);
    expect(after.ikHandles![0].blend).toBe(0); expect(after.animation!.tracks).toHaveLength(9); expect(result.store.temporal.getState().pastStates).toHaveLength(1);
    expect(Math.abs(poses.get("root")!.rotation[2] - 720)).toBeLessThanOrEqual(180);
    const world = jointWorldMatrices(after, poses); expect(position(world, "end").distanceTo(position(result.worlds, "end"))).toBeLessThan(1e-7);
    result.store.temporal.getState().undo(); expect(result.store.getState().document).toBe(result.doc);
  });
  it("validates solver settings, preserves legacy CCD and serializes new handles", async () => {
    const store = createSceneStore(fixture()), id = createIKHandle(store, "root", "end", undefined, { solver: "two-bone", poleTarget: [0, 0, 2] });
    expect(store.getState().document.ikHandles![0]).toMatchObject({ solver: "two-bone", poleTarget: [0, 0, 2] });
    const before = store.getState().document;
    for (const patch of [{ solver: "unknown" }, { poleTarget: undefined }, { poleTarget: [Infinity, 0, 0] }, { poleTarget: [1000001, 0, 0] }]) expect(() => updateIKHandle(store, id, patch as any)).toThrow();
    expect(store.getState().document).toBe(before);
    const legacy = { ...before.ikHandles![0] }; delete legacy.solver; delete legacy.poleTarget; expect(() => validateIKHandles([legacy], before)).not.toThrow();
    const long = fixture(); long.joints!.push({ id: "tip", name: "Tip", parentId: "end", position: [0, 1, 0] });
    expect(() => createIKHandle(createSceneStore(long), "root", "tip", undefined, { solver: "two-bone" })).toThrow(/exactly three/);
    expect(() => createIKHandle(createSceneStore(fixture()), "root", "middle", undefined, { solver: "two-bone" })).toThrow(/exactly three/);
    store.temporal.getState().undo(); expect(store.getState().document.ikHandles).toBeUndefined(); store.temporal.getState().redo();
    const editor = { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: 0.01, far: 1000 }, time: 0 };
    expect((await decodeProject(await encodeProject(store.getState().document, new Map(), editor))).scene).toEqual(store.getState().document);
  });
});
