import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import { defaultAnimation, evaluateIKBlend, evaluateSceneAnimation, keyChannels, type AnimationChannel, type AnimationTrack } from "../src/animation.ts";
import { constraintWorldMatrices, createConstraint } from "../src/constraints.ts";
import { evaluateDrivenKeys } from "../src/driven-keys.ts";
import { evaluateRigStages, getIKTargetPoints } from "../src/ik.ts";
import { createParticlePoseSampler } from "../src/particle-pose-sampler.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { deleteSceneItems, emptyScene, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function track(targetId: string, channel: AnimationChannel, a: number, b: number): AnimationTrack {
  const id = `${targetId}_${channel.replace(".", "_")}`;
  return { id, targetId, channel, keys: [
    { id: `${id}_a`, time: 0, value: a, interpolation: "linear", tangentMode: "auto" },
    { id: `${id}_b`, time: 24, value: b, interpolation: "linear", tangentMode: "auto" },
  ] };
}
function fixture(): SceneDocument {
  const doc = emptyScene();
  for (const [id, position] of [["control", [1, 1, 0]], ["emitter", [0, 0, 0]], ["driver", [0, 0, 0]]] as [string, Vec3][]) {
    doc.nodes[id] = { id, name: id, type: "transform", parentId: null, position, rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
    const shapeId = `${id}Shape`;
    doc.nodes[shapeId] = { id: shapeId, name: shapeId, type: "curveShape", parentId: id, degree: 1, points: [[0, 0, 0, 1], [0.1, 0, 0, 1]], knots: [0, 0, 1, 1], color: "#ffffff", closed: false };
    doc.rootIds.push(id);
  }
  doc.joints = [
    { id: "ancestor", name: "Ancestor", parentId: null, position: [0, 0, 0] },
    { id: "root", name: "Root", parentId: "ancestor", position: [0, 0, 0] },
    { id: "middle", name: "Middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "End", parentId: "middle", position: [0, 1, 0] },
    { id: "root2", name: "OtherRoot", parentId: null, position: [4, 0, 0] },
    { id: "end2", name: "OtherEnd", parentId: "root2", position: [0, 1, 0] },
  ];
  doc.ikHandles = [
    { id: "ik", name: "Arm", rootId: "root", endId: "end", target: [1, 1, 0], poleTarget: [0, 0, 2], solver: "two-bone", enabled: true, blend: 1, iterations: 64, targetControl: { objectId: "control", offset: [0, 0, 0] } },
    { id: "ik2", name: "OtherArm", rootId: "root2", endId: "end2", target: [4.5, 0.5, 0], solver: "ccd", enabled: true, blend: 0, iterations: 64 },
  ];
  doc.animation = { ...defaultAnimation(), tracks: [track("ik", "ik.blend", 0, 1), track("ik2", "ik.blend", 1, 0),
    track("root", "rotation.z", 0, 15), track("control", "position.x", 0.8, 1.2), track("driver", "position.z", 0, 3)] };
  const store = createSceneStore(doc); createConstraint(store, "point", "end", "emitter", false);
  return store.getState().document;
}
function viewport(doc: SceneDocument, frame: number) {
  const poses = evaluateSceneAnimation(doc, frame); evaluateDrivenKeys(doc, poses);
  evaluateRigStages(doc, poses, false, frame);
  return poses;
}
function world(doc: SceneDocument, frame: number) { return constraintWorldMatrices(doc, viewport(doc, frame)); }
function expectWorld(a: ReadonlyMap<string, Matrix4>, b: ReadonlyMap<string, Matrix4>) {
  for (const [id, matrix] of a) for (let i = 0; i < 16; i++) expect(b.get(id)!.elements[i]).toBeCloseTo(matrix.elements[i], 9);
}
const editor = { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 45, near: 0.01, far: 1000 }, time: 12.5 / 24 };

describe("IK blend scene deletion", () => {
  it("removes descendant-chain blend curves together with the handle, preserves unrelated tracks, and roundtrips undo and archives", async () => {
    const doc = fixture(), store = createSceneStore(doc), next = deleteSceneItems(doc, ["ancestor"]);
    const retained = doc.animation!.tracks.filter(item => !["ik", "root"].includes(item.targetId));
    expect(next.ikHandles!.map(handle => handle.id)).toEqual(["ik2"]);
    expect(next.animation!.tracks).toEqual(retained);
    expect(next.joints!.map(joint => joint.id)).toEqual(["root2", "end2"]);
    expect(next.nodes.control).toBe(doc.nodes.control);
    expect(next.constraints).toEqual([]);
    store.setState({ document: next, editLabel: "Delete selection" });
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    const opened = await decodeProject(await encodeProject(next, new Map(), editor));
    expect(opened.scene.animation).toEqual(next.animation);
    expect(opened.scene.ikHandles).toEqual(next.ikHandles);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    expect(() => validateScene(store.getState().document)).not.toThrow();
    store.temporal.getState().redo(); expect(store.getState().document).toBe(next);
    expect(doc.animation!.tracks.some(item => item.targetId === "ik")).toBe(true);
  });

  it("keeps the surviving handle's blend animation when deleting its linked control", async () => {
    const doc = fixture(), points = getIKTargetPoints(doc, viewport(doc, 12.5));
    const next = deleteSceneItems(doc, ["control"], points);
    expect(next.ikHandles).toHaveLength(2);
    expect(next.ikHandles![0].targetControl).toBeUndefined();
    expect(next.ikHandles![0].target).toEqual(points.get("ik")!.target);
    expect(next.animation!.tracks.filter(item => item.channel === "ik.blend")).toEqual(doc.animation!.tracks.filter(item => item.channel === "ik.blend"));
    expect(next.animation!.tracks.some(item => item.targetId === "control")).toBe(false);
    const opened = await decodeProject(await encodeProject(next, new Map(), editor));
    expect(evaluateIKBlend(opened.scene, "ik", 12.5)).toBeCloseTo(12.5 / 24, 12);
  });

  it("removes the whole handle's blend curve when only its end joint is selected for deletion", () => {
    const doc = fixture(), next = deleteSceneItems(doc, ["end"]);
    expect(next.joints!.some(joint => joint.id === "root")).toBe(true);
    expect(next.animation!.tracks.some(item => item.targetId === "root")).toBe(true);
    expect(next.animation!.tracks.some(item => item.targetId === "ik")).toBe(false);
    expect(next.ikHandles!.map(handle => handle.id)).toEqual(["ik2"]);
    expect(() => validateScene(next)).not.toThrow();
  });
});

describe("animated blend historical sampling", () => {
  it("agrees with viewport and equivalent static blends at fractional, nonmonotonic frames with exact cache reuse", () => {
    const doc = fixture(), before = JSON.stringify(doc), sampler = createParticlePoseSampler(doc);
    const retained = new Map<number, ReadonlyMap<string, Matrix4>>();
    for (const frame of [12.5, 0, 24, 7.125, 12.5, 0.125, 7.125]) {
      const result = sampler.worldAt(frame);
      expectWorld(result, world(doc, frame));
      const staticReference: SceneDocument = { ...doc,
        animation: { ...doc.animation!, tracks: doc.animation!.tracks.filter(item => item.channel !== "ik.blend") },
        ikHandles: doc.ikHandles!.map(handle => ({ ...handle, blend: handle.id === "ik" ? frame / 24 : 1 - frame / 24 })),
      };
      expectWorld(result, world(staticReference, frame));
      const end = new Vector3().setFromMatrixPosition(result.get("end")!);
      const emitter = new Vector3().setFromMatrixPosition(result.get("emitter")!);
      expect(emitter.distanceTo(end)).toBeLessThan(1e-10);
      if (frame === 0) expect(end.distanceTo(new Vector3(0, 2, 0))).toBeLessThan(1e-10);
      if (frame === 24) expect(end.distanceTo(new Vector3(1.2, 1, 0))).toBeLessThan(1e-8);
      if (retained.has(frame)) expect(result).toBe(retained.get(frame));
      retained.set(frame, result); expect(sampler.worldAt(frame)).toBe(result);
    }
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("transient main-equivalent blend previews", () => {
  it.each([true, false])("previews scalar blend without document or history changes (existing curve: %s)", animated => {
    const original = fixture();
    const doc = animated ? original : { ...original, animation: { ...original.animation!, tracks: original.animation!.tracks.filter(item => item.targetId !== "ik") } };
    const store = createSceneStore(doc), before = JSON.stringify(doc), frame = 6.25;
    const sampler = createParticlePoseSampler(doc), cached = sampler.worldAt(frame), baseline = world(doc, frame);
    for (const value of [0.2, 0.8, 0]) {
      const preview = keyChannels(doc, "ik", value, frame, false);
      expect(evaluateIKBlend(preview, "ik", frame)).toBe(value);
      const previewTrack = preview.animation!.tracks.find(item => item.targetId === "ik" && item.channel === "ik.blend")!;
      expect(previewTrack.keys.filter(key => key.time === frame)).toHaveLength(1);
      expect(previewTrack.keys).toHaveLength(animated ? 3 : 1);
      expect(preview.ikHandles).toBe(doc.ikHandles);
      const staticReference: SceneDocument = { ...doc,
        animation: { ...doc.animation!, tracks: doc.animation!.tracks.filter(item => item.targetId !== "ik") },
        ikHandles: doc.ikHandles!.map(handle => handle.id === "ik" ? { ...handle, blend: value } : handle),
      };
      expectWorld(world(preview, frame), world(staticReference, frame));
      expect(store.getState().document).toBe(doc);
      expect(store.temporal.getState().pastStates).toHaveLength(0);
      expect(sampler.worldAt(frame)).toBe(cached);
    }
    // Canceling is simply evaluating the authored document again.
    expectWorld(world(doc, frame), baseline);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("rejects invalid preview values without changing authored keys or undo state", () => {
    const doc = fixture(), store = createSceneStore(doc), before = JSON.stringify(doc);
    for (const value of [-0.1, 1.1, NaN, Infinity]) expect(() => keyChannels(doc, "ik", value, 12.5, false)).toThrow();
    expect(store.getState().document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });
});
