import { describe, expect, it } from "vitest";
import { Line, Matrix4, Scene, Vector3 } from "three";
import { defaultAnimation, evaluateSceneAnimation, type AnimationChannel, type AnimationTrack } from "../src/animation.ts";
import { constraintWorldMatrices, createConstraint } from "../src/constraints.ts";
import { evaluateDrivenKeys } from "../src/driven-keys.ts";
import { evaluateRigStages, getIKTargetPoints, type IKTargetPoints } from "../src/ik.ts";
import { createIKTargets } from "../src/ik-targets.ts";
import { createParticlePoseSampler } from "../src/particle-pose-sampler.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { deleteSceneItems, emptyScene, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

const editor = { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 45, near: 0.01, far: 1000 }, time: 12.5 / 24 };

function track(targetId: string, channel: AnimationChannel, a: number, b: number): AnimationTrack {
  const id = `${targetId}_${channel.replace(".", "_")}`;
  return { id, targetId, channel, keys: [
    { id: `${id}_a`, time: 0, value: a, interpolation: "linear", tangentMode: "auto" },
    { id: `${id}_b`, time: 24, value: b, interpolation: "linear", tangentMode: "auto" },
  ] };
}

function fixture(): SceneDocument {
  const doc = emptyScene();
  for (const [id, parentId, position] of [
    ["controls", null, [0, 0, 0]], ["control", "controls", [1, 1, 0]],
    ["pole", "controls", [0, 1, 2]], ["driver", null, [0, 0, 0]], ["emitter", null, [0, 0, 0]],
  ] as [string, string | null, Vec3][]) {
    doc.nodes[id] = { id, name: id, type: "transform", parentId, position, rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
    if (parentId === null) doc.rootIds.push(id);
  }
  for (const parentId of ["controls", "control", "pole", "driver", "emitter"]) {
    const id = `${parentId}Shape`;
    doc.nodes[id] = { id, name: id, type: "curveShape", parentId, degree: 1, points: [[-0.1, 0, 0, 1], [0.1, 0, 0, 1]], knots: [0, 0, 1, 1], closed: false, color: "#e4b84b" };
  }
  doc.joints = [
    { id: "ancestor", name: "ancestor", parentId: null, position: [0, 0, 0] },
    { id: "root", name: "root", parentId: "ancestor", position: [0, 0, 0] },
    { id: "middle", name: "middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "end", parentId: "middle", position: [0, 1, 0] },
  ];
  doc.ikHandles = [{ id: "ik", name: "Arm", rootId: "root", endId: "end", enabled: true, iterations: 64, blend: 1,
    solver: "two-bone", target: [0.5, 1.5, 0], poleTarget: [0, 0, 3],
    targetControl: { objectId: "control", offset: [0.25, 0, 0] }, poleControl: { objectId: "pole", offset: [-0.5, 0, 0] } }];
  doc.animation = { ...defaultAnimation(), tracks: [
    track("driver", "position.x", 0, 4), track("driver", "rotation.z", 0, 90), track("control", "position.x", 1, 1.25),
  ] };
  const store = createSceneStore(doc);
  createConstraint(store, "point", "driver", "controls", false);
  createConstraint(store, "point", "driver", "ancestor", false);
  createConstraint(store, "orient", "driver", "control", false);
  createConstraint(store, "point", "end", "emitter", false);
  return store.getState().document;
}

function viewportPoses(doc: SceneDocument, frame: number) {
  const poses = evaluateSceneAnimation(doc, frame);
  evaluateDrivenKeys(doc, poses);
  evaluateRigStages(doc, poses);
  return poses;
}
function currentPoints(doc: SceneDocument, frame = 12.5) { return getIKTargetPoints(doc, viewportPoses(doc, frame)); }
function position(world: ReadonlyMap<string, Matrix4>, id: string) { return new Vector3().setFromMatrixPosition(world.get(id)!); }

describe("deleting linked IK controls", () => {
  it("freezes only a deleted target binding at its supplied evaluated point, with independent arrays", () => {
    const doc = fixture(), points = currentPoints(doc), expected = [...points.get("ik")!.target];
    const next = deleteSceneItems(doc, ["control"], points), handle = next.ikHandles![0];
    expect(handle.targetControl).toBeUndefined();
    expect(handle.poleControl).toEqual(doc.ikHandles![0].poleControl);
    expect(handle.poleTarget).toEqual(doc.ikHandles![0].poleTarget);
    expect(handle.target).toEqual(expected);
    expect(handle.target).not.toBe(points.get("ik")!.target);
    points.get("ik")!.target[0] = 999;
    expect(handle.target).toEqual(expected);
    expect(doc.ikHandles![0].target).toEqual([0.5, 1.5, 0]);
    expect(next.nodes.control).toBeUndefined(); expect(next.nodes.controlShape).toBeUndefined();
    expect(next.animation!.tracks.some(item => item.targetId === "control")).toBe(false);
    expect(() => validateScene(next)).not.toThrow();
  });

  it("freezes a deleted pole independently and preserves the surviving target binding", () => {
    const doc = fixture(), points = currentPoints(doc), expected = [...points.get("ik")!.poleTarget!];
    const next = deleteSceneItems(doc, ["pole"], points), handle = next.ikHandles![0];
    expect(handle.poleControl).toBeUndefined();
    expect(handle.targetControl).toEqual(doc.ikHandles![0].targetControl);
    expect(handle.target).toEqual(doc.ikHandles![0].target);
    expect(handle.poleTarget).toEqual(expected);
    expect(handle.poleTarget).not.toBe(points.get("ik")!.poleTarget);
    handle.poleTarget![1] += 1;
    expect(points.get("ik")!.poleTarget).toEqual(expected);
    expect(doc.ikHandles![0].poleTarget).toEqual([0, 0, 3]);
    expect(() => validateScene(next)).not.toThrow();
  });

  it("deleting a shared control ancestor unlinks both controls, survives archive roundtrip, and undoes atomically", async () => {
    const doc = fixture(), store = createSceneStore(doc), points = currentPoints(doc);
    const next = deleteSceneItems(doc, ["controls"], points), handle = next.ikHandles![0];
    expect(handle.targetControl).toBeUndefined(); expect(handle.poleControl).toBeUndefined();
    expect(handle.target).toEqual(points.get("ik")!.target);
    expect(handle.poleTarget).toEqual(points.get("ik")!.poleTarget);
    expect(handle.target).not.toBe(points.get("ik")!.target);
    expect(handle.poleTarget).not.toBe(points.get("ik")!.poleTarget);
    for (const id of ["controls", "controlsShape", "control", "controlShape", "pole", "poleShape"]) expect(next.nodes[id]).toBeUndefined();
    store.setState({ document: next, editLabel: "Delete selection" });
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    const opened = await decodeProject(await encodeProject(next, new Map(), editor));
    expect(opened.scene.ikHandles).toEqual(next.ikHandles);
    expect(currentPoints(opened.scene).get("ik")).toEqual(points.get("ik"));
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    const restored = await decodeProject(await encodeProject(store.getState().document, new Map(), editor));
    expect(restored.scene.ikHandles![0].targetControl).toEqual(doc.ikHandles![0].targetControl);
    expect(restored.scene.ikHandles![0].poleControl).toEqual(doc.ikHandles![0].poleControl);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(next);
  });

  it("uses copied literal fallbacks without an evaluated point map or when evaluated points are unsafe", () => {
    const doc = fixture();
    const bad = new Map<string, IKTargetPoints>([["ik", { target: [NaN, 2, 3], poleTarget: [0, 0, 1e6 + 1] }]]);
    for (const points of [undefined, new Map<string, IKTargetPoints>(), bad]) {
      const handle = deleteSceneItems(doc, ["controls"], points).ikHandles![0];
      expect(handle.target).toEqual(doc.ikHandles![0].target);
      expect(handle.poleTarget).toEqual(doc.ikHandles![0].poleTarget);
      expect(handle.target).not.toBe(doc.ikHandles![0].target);
      expect(handle.poleTarget).not.toBe(doc.ikHandles![0].poleTarget);
      expect(handle.targetControl).toBeUndefined(); expect(handle.poleControl).toBeUndefined();
    }
  });

  it("still removes the handle when its joint chain is deleted", () => {
    const doc = fixture(), next = deleteSceneItems(doc, ["root"], currentPoints(doc));
    expect(next.ikHandles).toEqual([]);
    expect(next.joints!.map(joint => joint.id)).toEqual(["ancestor"]);
    expect(next.nodes.control).toBe(doc.nodes.control);
    expect(next.constraints!.some(constraint => constraint.sourceId === "end")).toBe(false);
    expect(() => validateScene(next)).not.toThrow();
  });
});

describe("linked IK viewport markers", () => {
  it("uses final evaluated control points and keeps marker identities across fractional frames", () => {
    const doc = fixture(), world = new Scene(), markers = createIKTargets(world);
    let firstTarget: ReturnType<typeof markers.getObject>, firstPole: ReturnType<typeof markers.getObject>;
    for (const frame of [3.25, 18.75, 1.125]) {
      const poses = viewportPoses(doc, frame), expected = getIKTargetPoints(doc, poses).get("ik")!;
      markers.sync(doc, poses);
      const target = markers.getObject("ik")!, pole = markers.getObject("ik", "pole")!;
      firstTarget ??= target; firstPole ??= pole;
      expect(target).toBe(firstTarget); expect(pole).toBe(firstPole);
      expect(target.position.toArray()).toEqual(expected.target);
      expect(pole.position.toArray()).toEqual(expected.poleTarget);
      world.traverse(object => {
        if (!(object instanceof Line) || object.userData.ikHandleLink !== "ik") return;
        const points = object.geometry.getAttribute("position");
        const desired = object.userData.ikControlKind === "pole" ? expected.poleTarget! : expected.target;
        for (let axis = 0; axis < 3; axis++) expect(points.array[axis]).toBeCloseTo(desired[axis], 6);
      });
    }
    markers.dispose(); expect(world.children).toHaveLength(0);
  });

  it("falls back to stored target and pole points after resolution failure and recovers on the next valid pose", () => {
    const doc = fixture(), world = new Scene(), markers = createIKTargets(world), good = viewportPoses(doc, 12.5);
    markers.sync(doc, good);
    const target = markers.getObject("ik")!, pole = markers.getObject("ik", "pole")!;
    const bad = new Map(good); bad.set("control", { ...good.get("control")!, position: [NaN, 0, 0] });
    expect(() => getIKTargetPoints(doc, bad)).toThrow(/finite/);
    expect(() => markers.sync(doc, bad)).not.toThrow();
    expect(target.position.toArray()).toEqual(doc.ikHandles![0].target);
    expect(pole.position.toArray()).toEqual(doc.ikHandles![0].poleTarget);
    markers.sync(doc, good);
    expect(markers.getObject("ik")).toBe(target); expect(markers.getObject("ik", "pole")).toBe(pole);
    expect(target.position.toArray()).toEqual(getIKTargetPoints(doc, good).get("ik")!.target);
    markers.dispose();
  });
});

describe("historical sampling of constrained linked IK", () => {
  it("matches the viewport stack at fractional frames in nonmonotonic order and caches exact repeated frames", () => {
    const doc = fixture(), before = JSON.stringify(doc), sampler = createParticlePoseSampler(doc);
    const retained = new Map<number, ReadonlyMap<string, Matrix4>>();
    for (const frame of [18.75, 1.125, 24, 0, 12.5, 18.75, 4.25, 1.125]) {
      const actual = sampler.worldAt(frame), expected = constraintWorldMatrices(doc, viewportPoses(doc, frame));
      for (const [id, matrix] of expected) expect(actual.get(id)!.elements).toEqual(matrix.elements);
      if (retained.has(frame)) expect(actual).toBe(retained.get(frame));
      retained.set(frame, actual);
      expect(sampler.worldAt(frame)).toBe(actual);
      const target = new Vector3(frame / 6 + 1.25 + frame / 96, 1, 0);
      expect(position(actual, "root").distanceTo(new Vector3(frame / 6, 0, 0))).toBeLessThan(1e-9);
      expect(position(actual, "end").distanceTo(target)).toBeLessThan(1e-8);
      expect(position(actual, "emitter").distanceTo(target)).toBeLessThan(1e-8);
    }
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("does not cache a failed historical linked-control evaluation or disturb an earlier valid frame", () => {
    const original = fixture(), doc = { ...original, animation: { ...original.animation!, tracks: [track("control", "position.x", 1, 1e6 + 1)] } };
    const sampler = createParticlePoseSampler(doc), good = sampler.worldAt(0);
    expect(() => sampler.worldAt(24)).toThrow(/evaluated IK control target/);
    expect(() => sampler.worldAt(24)).toThrow(/evaluated IK control target/);
    expect(sampler.worldAt(0)).toBe(good);
    expect(position(good, "end").distanceTo(new Vector3(1.25, 1, 0))).toBeLessThan(1e-8);
  });
});
