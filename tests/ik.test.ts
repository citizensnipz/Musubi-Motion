import { describe, expect, it } from "vitest";
import { Quaternion, Euler, MathUtils, Vector3 } from "three";
import { evaluateSceneAnimation, type AnimationPose } from "../src/animation.ts";
import { createIKHandle, deleteIKHandle, evaluateIK, ikChain, jointWorldMatrices, matchIKToFK, updateIKHandle, validateIKHandles, type IKHandle } from "../src/ik.ts";
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
