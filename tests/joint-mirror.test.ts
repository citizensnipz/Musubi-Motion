import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import { evaluateSceneAnimation, setKeys } from "../src/animation.ts";
import { addAnimationLayer, updateAnimationLayer } from "../src/animation-layers.ts";
import { createConstraint } from "../src/constraints.ts";
import { jointWorldMatrices } from "../src/ik.ts";
import { buildJointMirrorPairs, mirrorJointPose, mirrorJointSubtree, reflectJointMatrix, type MirrorAxis } from "../src/joint-mirror.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { emptyScene, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture(): SceneDocument {
  return { ...emptyScene(), joints: [
    { id: "parent", name: "Center", parentId: null, position: [.5, 1, 0], orientation: [10, 15, 20], rotation: [5, 0, -10] },
    { id: "left", name: "L_arm", parentId: "parent", position: [1, .5, 0], orientation: [15, 25, 35], rotation: [-10, 20, 30], preferredAngle: [20, 30, 40], showLocalAxes: true },
    { id: "middle", name: "L_elbow", parentId: "left", position: [1, .1, .2], orientation: [5, -20, 40], rotation: [30, -10, 10] },
    { id: "tip", name: "L_wrist", parentId: "middle", position: [.8, 0, .1], orientation: [-10, 30, 5] },
    { id: "finger", name: "L_finger", parentId: "middle", position: [.3, .2, -.1] },
  ] };
}
function compare(a: Matrix4, b: Matrix4) { a.elements.forEach((value, index) => expect(value).toBeCloseTo(b.elements[index], 8)); }
function paired() {
  const store = createSceneStore(fixture()); mirrorJointSubtree(store, "left", { axis: "X", search: "L_", replace: "R_" });
  return store;
}

describe("joint subtree mirroring", () => {
  it.each(["X", "Y", "Z"] as const)("reflects %s world positions/orientations with proper handedness and mapped hierarchy", axis => {
    const doc = fixture(), store = createSceneStore(doc), before = jointWorldMatrices(doc), original = JSON.stringify(doc);
    const map = mirrorJointSubtree(store, "left", { axis, search: "L_", replace: "R_" }), next = store.getState().document, worlds = jointWorldMatrices(next);
    expect(map.size).toBe(4); expect(new Set(map.values()).size).toBe(4);
    for (const [sourceId, targetId] of map) {
      expect(doc.joints!.some(joint => joint.id === targetId)).toBe(false);
      compare(worlds.get(targetId)!, reflectJointMatrix(before.get(sourceId)!, axis));
      expect(worlds.get(targetId)!.determinant()).toBeCloseTo(1, 10);
      const source = doc.joints!.find(j => j.id === sourceId)!, target = next.joints!.find(j => j.id === targetId)!;
      expect(target.name).toBe(source.name.replace("L_", "R_"));
      expect(target.parentId).toBe(map.get(source.parentId!) ?? null);
      if (map.has(source.parentId!)) expect(new Vector3(...target.position).length()).toBeCloseTo(new Vector3(...source.position).length(), 10);
    }
    expect(JSON.stringify(doc)).toBe(original); expect(store.temporal.getState().pastStates).toHaveLength(1);
    expect(next.joints!.find(j => j.id === map.get("left"))!.showLocalAxes).toBe(true);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(next);
  });

  it("does not clone animation, IK, constraints or skin bindings", () => {
    const doc = fixture(), store = createSceneStore(doc);
    setKeys(store, ["left"], 0, evaluateSceneAnimation(doc, 0), ["rotation.z"]);
    const before = store.getState().document;
    mirrorJointSubtree(store, "left", { axis: "X", search: "L_", replace: "R_" });
    const next = store.getState().document;
    expect(next.animation).toBe(before.animation); expect(next.ikHandles).toBe(before.ikHandles); expect(next.constraints).toBe(before.constraints);
    expect(next.nodes).toBe(before.nodes);
  });

  it("rejects invalid roots, axes, names and collisions atomically", () => {
    const store = createSceneStore(fixture()), before = store.getState().document;
    for (const action of [
      () => mirrorJointSubtree(store, "missing", { axis: "X", search: "L_", replace: "R_" }),
      () => mirrorJointSubtree(store, "left", { axis: "W" as MirrorAxis, search: "L_", replace: "R_" }),
      () => mirrorJointSubtree(store, "left", { axis: "X", search: "", replace: "R_" }),
      () => mirrorJointSubtree(store, "left", { axis: "X", search: "L_", replace: "L_" }),
      () => mirrorJointSubtree(store, "left", { axis: "X", search: "missing", replace: "R_" }),
    ]) { expect(action).toThrow(); expect(store.getState().document).toBe(before); }
    mirrorJointSubtree(store, "left", { axis: "X", search: "L_", replace: "R_" }); const copied = store.getState().document;
    expect(() => mirrorJointSubtree(store, "left", { axis: "X", search: "L_", replace: "R_" })).toThrow(/already exists/);
    expect(store.getState().document).toBe(copied); expect(store.temporal.getState().pastStates).toHaveLength(1);
  });

  it("round-trips mirrored hierarchy and frames through msb", async () => {
    const store = paired(), doc = store.getState().document;
    const data = await encodeProject(doc, new Map(), { camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0 });
    const opened = (await decodeProject(data)).scene; expect(opened.joints).toEqual(doc.joints);
    for (const [id, matrix] of jointWorldMatrices(doc)) compare(matrix, jointWorldMatrices(opened).get(id)!);
  });
});

describe("mirrored FK poses", () => {
  it("pairs by explicit name substitution and rejects ambiguous/missing names", () => {
    const store = paired(), doc = store.getState().document, pairs = buildJointMirrorPairs(doc, "left", "L_", "R_");
    expect(pairs.size).toBe(4);
    for (const [source, target] of pairs) expect(doc.joints!.find(j => j.id === target)!.name).toBe(doc.joints!.find(j => j.id === source)!.name.replace("L_", "R_"));
    expect(() => buildJointMirrorPairs(doc, "left", "L_", "missing_")).toThrow(/destination/);
    const ambiguous = { ...doc, joints: [...doc.joints!, { ...doc.joints!.find(j => j.id === pairs.get("left"))!, id: "duplicate" }] };
    expect(() => buildJointMirrorPairs(ambiguous, "left", "L_", "R_")).toThrow(/unambiguous/);
  });

  it.each(["X", "Y", "Z"] as const)("mirrors prepared %s FK worlds and resolves simultaneously mapped parents", axis => {
    const store = paired(), doc = store.getState().document, pairs = buildJointMirrorPairs(doc, "left", "L_", "R_"), poses = evaluateSceneAnimation(doc, 0);
    poses.get("left")!.rotation = [30, 40, 60]; poses.get("middle")!.rotation = [-20, 35, 70]; poses.get("tip")!.position = [.6, .2, .2];
    const before = jointWorldMatrices(doc, poses), count = store.temporal.getState().pastStates.length;
    // Deliberately reverse iteration order to exercise parent world staging.
    const reversed = new Map([...pairs].reverse());
    const applied = mirrorJointPose(store, reversed, axis, poses), candidate = new Map(poses);
    for (const [id, pose] of applied) candidate.set(id, pose);
    const worlds = jointWorldMatrices(store.getState().document, candidate);
    for (const [source, target] of pairs) compare(worlds.get(target)!, reflectJointMatrix(before.get(source)!, axis));
    for (const id of pairs.keys()) compare(worlds.get(id)!, before.get(id)!);
    expect(store.temporal.getState().pastStates).toHaveLength(count + 1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
  });

  it("compensates untouched, rotated destination parents", () => {
    const store = paired(), doc = store.getState().document, pairs = buildJointMirrorPairs(doc, "left", "L_", "R_"), target = pairs.get("middle")!;
    const poses = evaluateSceneAnimation(doc, 0); poses.get("middle")!.rotation = [50, 10, 15];
    poses.get(pairs.get("left")!)!.rotation = [20, 40, 15];
    const before = jointWorldMatrices(doc, poses), output = mirrorJointPose(store, new Map([["middle", target]]), "X", poses);
    for (const [id, pose] of output) poses.set(id, pose);
    compare(jointWorldMatrices(store.getState().document, poses).get(target)!, reflectJointMatrix(before.get("middle")!, "X"));
  });

  it("keys mirrored pose channels in one history entry, preserves unrelated curves, and round-trips", async () => {
    const store = paired(), doc = store.getState().document, pairs = buildJointMirrorPairs(doc, "left", "L_", "R_"), poses = evaluateSceneAnimation(doc, 0);
    poses.get("left")!.rotation = [10, 20, 75];
    const before = store.temporal.getState().pastStates.length;
    const result = mirrorJointPose(store, pairs, "X", poses, { frame: 12.5 }), next = store.getState().document;
    expect(next.animation!.tracks).toHaveLength(pairs.size * 6);
    for (const track of next.animation!.tracks) expect(track.keys[0].time).toBe(12.5);
    expect(next.joints).toBe(doc.joints);
    expect(store.temporal.getState().pastStates).toHaveLength(before + 1);
    const evaluated = evaluateSceneAnimation(next, 12.5);
    for (const [id, pose] of result) { expect(evaluated.get(id)!.position).toEqual(pose.position); expect(evaluated.get(id)!.rotation).toEqual(pose.rotation); }
    const data = await encodeProject(next, new Map(), { camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0 });
    expect((await decodeProject(data)).scene.animation).toEqual(next.animation);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(next);
  });

  it("rejects missing, duplicate, self-pairs and malformed FK poses atomically", () => {
    const store = paired(), doc = store.getState().document, poses = evaluateSceneAnimation(doc, 0), pairs = buildJointMirrorPairs(doc, "left", "L_", "R_"), target = pairs.get("left")!;
    for (const invalid of [new Map(), new Map([["left", "left"]]), new Map([["missing", target]]), new Map([["left", target], ["middle", target]])])
      expect(() => mirrorJointPose(store, invalid, "X", poses)).toThrow();
    const bad = new Map(poses); bad.set("left", { ...poses.get("left")!, rotation: [NaN, 0, 0] });
    expect(() => mirrorJointPose(store, pairs, "X", bad)).toThrow(/finite/);
    expect(() => mirrorJointPose(store, pairs, "X", new Map())).toThrow(/Evaluate every/);
    expect(() => mirrorJointPose(store, pairs, "X", poses, { frame: NaN })).toThrow();
    expect(store.getState().document).toBe(doc);
  });

  it("rejects static edits to animated destinations but permits normal keyed replacement", () => {
    const store = paired(), pairs = buildJointMirrorPairs(store.getState().document, "left", "L_", "R_"), target = pairs.get("left")!;
    setKeys(store, [target], 1, evaluateSceneAnimation(store.getState().document, 1), ["rotation.z"]);
    const doc = store.getState().document, poses = evaluateSceneAnimation(doc, 1);
    expect(() => mirrorJointPose(store, pairs, "X", poses)).toThrow(/animated/); expect(store.getState().document).toBe(doc);
    expect(() => mirrorJointPose(store, pairs, "X", poses, { frame: 1 })).not.toThrow();
  });

  it("rejects driven, constrained and IK destination ownership", () => {
    for (const kind of ["sdk", "constraint", "ik"] as const) {
      const store = paired(), pairs = buildJointMirrorPairs(store.getState().document, "left", "L_", "R_"), target = pairs.get("left")!;
      let doc = store.getState().document;
      if (kind === "sdk") doc = { ...doc, drivenKeys: [{ id: "sdk", driver: { targetId: "left", channel: "rotation.x" }, driven: { targetId: target, channel: "rotation.z" }, keys: [{ id: "key", time: 0, value: 0, interpolation: "linear", tangentMode: "auto" }] }] };
      if (kind === "ik") doc = { ...doc, ikHandles: [{ id: "ik", name: "Arm", rootId: target, endId: pairs.get("tip")!, enabled: true, blend: 1, iterations: 64, target: [-1, 2, 1] }] };
      store.setState({ document: doc });
      if (kind === "constraint") createConstraint(store, "orient", "left", target, true);
      const before = store.getState().document;
      expect(() => mirrorJointPose(store, pairs, "X", evaluateSceneAnimation(before, 0), { frame: 0 })).toThrow();
      expect(store.getState().document).toBe(before);
    }
  });

  it("rejects inherited constraint changes before committing a mirrored pose", () => {
    const store = paired(), pairs = buildJointMirrorPairs(store.getState().document, "left", "L_", "R_");
    createConstraint(store, "orient", "left", pairs.get("left")!, false);
    const doc = store.getState().document, before = store.temporal.getState().pastStates.length;
    expect(() => mirrorJointPose(store, new Map([["middle", pairs.get("middle")!]]), "X", evaluateSceneAnimation(doc, 0))).toThrow(/after rig evaluation/);
    expect(store.getState().document).toBe(doc); expect(store.temporal.getState().pastStates).toHaveLength(before);
  });

  it.each(["additive", "override"] as const)("keys the composed mirrored result into weighted %s animation layers", mode => {
    const store = paired(), pairs = buildJointMirrorPairs(store.getState().document, "left", "L_", "R_");
    const layerId = addAnimationLayer(store, "Mirror pose", mode); updateAnimationLayer(store, layerId, { weight: .4 });
    const doc = store.getState().document, poses = evaluateSceneAnimation(doc, 12); poses.get("left")!.rotation = [30, -10, 45];
    const inputWorld = jointWorldMatrices(doc, poses);
    mirrorJointPose(store, pairs, "X", poses, { frame: 12 });
    const next = store.getState().document, evaluated = evaluateSceneAnimation(next, 12), world = jointWorldMatrices(next, evaluated);
    for (const [source, target] of pairs) compare(world.get(target)!, reflectJointMatrix(inputWorld.get(source)!, "X"));
    expect(next.animation!.tracks.every(track => track.layerId === layerId)).toBe(true);
  });
});
