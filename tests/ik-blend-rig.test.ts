import { describe, expect, it } from "vitest";
import { LineSegments, Scene } from "three";
import { defaultAnimation, evaluateIKBlend, evaluateSceneAnimation, type AnimationTrack } from "../src/animation.ts";
import { deleteIKHandle, evaluateIK, evaluateRigStages, jointWorldMatrices, matchFKToIK, validateIKHandles } from "../src/ik.ts";
import { createIKTargets } from "../src/ik-targets.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { emptyScene, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function blendTrack(id = "ik", start = 0, end = 1): AnimationTrack {
  return { id: `${id}_blend`, targetId: id, channel: "ik.blend", keys: [
    { id: `${id}_zero`, time: 0, value: start, interpolation: "linear", tangentMode: "auto" },
    { id: `${id}_last`, time: 24, value: end, interpolation: "linear", tangentMode: "auto" },
  ] };
}
function fixture(animated = true): SceneDocument {
  return { ...emptyScene(), joints: [
    { id: "root", name: "Root", parentId: null, position: [0, 0, 0] },
    { id: "middle", name: "Middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "End", parentId: "middle", position: [0, 1, 0] },
  ], ikHandles: [{ id: "ik", name: "Arm", rootId: "root", endId: "end", target: [1, 1, 0],
    poleTarget: [0, 0, 2], solver: "two-bone", enabled: true, blend: 1, iterations: 64 }],
  ...(animated ? { animation: { ...defaultAnimation(), tracks: [blendTrack()] } } : {}) };
}
function evaluate(doc: SceneDocument, frame: number) {
  const poses = evaluateSceneAnimation(doc, frame);
  evaluateRigStages(doc, poses, false, frame);
  return poses;
}
function expectSameWorld(doc: SceneDocument, a: ReturnType<typeof evaluate>, b: ReturnType<typeof evaluate>) {
  const first = jointWorldMatrices(doc, a), second = jointWorldMatrices(doc, b);
  for (const [id, matrix] of first) for (let index = 0; index < 16; index++)
    expect(second.get(id)!.elements[index]).toBeCloseTo(matrix.elements[index], 7);
}
const editor = { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 45, near: 0.01, far: 1000 }, time: 12.5 / 24 };

describe("animated IK blend solving", () => {
  it.each(["two-bone", "ccd"] as const)("matches the established static %s solver at fractional effective blends without mutation", solver => {
    const doc = fixture(); doc.ikHandles![0].solver = solver; doc.ikHandles![0].blend = 0.8;
    const before = JSON.stringify(doc);
    for (const frame of [12.5, 0, 24, 3.25, 12.5]) {
      const reference = { ...doc, animation: undefined, ikHandles: [{ ...doc.ikHandles![0], blend: frame / 24 }] };
      const expected = evaluate(reference, frame), actual = evaluateSceneAnimation(doc, frame);
      evaluateIK(doc, actual, frame);
      expect(actual).toEqual(expected);
      const staged = evaluateSceneAnimation(doc, frame), original = structuredClone(staged);
      const snapshots = evaluateRigStages(doc, staged, true, frame);
      expect(snapshots.fkPoses).toEqual(original);
      expect(snapshots.solvedPoses).toEqual(expected);
      expect(staged).toEqual(expected);
    }
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("preserves exact FK at a keyed zero despite static blend one, and respects disabled handles despite keyed one", () => {
    const doc = fixture(); doc.joints![0].rotation = [0, 0, 350];
    for (const [scene, frame] of [[doc, 0], [{ ...doc, ikHandles: [{ ...doc.ikHandles![0], enabled: false }] }, 24]] as const) {
      const poses = evaluateSceneAnimation(scene, frame), original = new Map(poses);
      evaluateIK(scene, poses, frame);
      expect(poses).toEqual(original);
      for (const [id, pose] of original) expect(poses.get(id)).toBe(pose);
    }
  });

  it("keeps static handles independent of frame and preserves the default frame-zero API", () => {
    const legacy = fixture(false); legacy.ikHandles![0].blend = 0.35;
    const implicit = evaluateSceneAnimation(legacy, 0); evaluateIK(legacy, implicit);
    expect(implicit).toEqual(evaluate(legacy, 12.5));
    expect(implicit).toEqual(evaluate(legacy, -20));
    const animated = fixture(), poses = evaluateSceneAnimation(animated, 0), original = new Map(poses);
    evaluateRigStages(animated, poses);
    expect(poses).toEqual(original);
    expect(evaluate(animated, 12.5)).not.toEqual(original);
  });

  it.each([NaN, Infinity, -Infinity])("rejects invalid evaluation frame %s before exposing any pose changes", frame => {
    for (const doc of [fixture(), emptyScene()]) {
      const poses = evaluateSceneAnimation(doc, 0), original = structuredClone(poses);
      expect(() => evaluateIK(doc, poses, frame)).toThrow(/frame.*finite/);
      expect(() => evaluateRigStages(doc, poses, true, frame)).toThrow(/frame.*finite/);
      expect(poses).toEqual(original);
    }
  });

  it("updates target and pole appearance from the current curve value without changing marker identities", () => {
    const doc = fixture(), before = JSON.stringify(doc), world = new Scene(), markers = createIKTargets(world);
    markers.sync(doc, evaluate(doc, 0));
    const target = markers.getObject("ik")!, pole = markers.getObject("ik", "pole")!;
    for (const frame of [12.5, 24, 0]) {
      markers.sync(doc, evaluate(doc, frame), frame);
      expect(markers.getObject("ik")).toBe(target); expect(markers.getObject("ik", "pole")).toBe(pole);
      for (const marker of [target, pole]) {
        expect(marker.userData.blend).toBeCloseTo(frame / 24, 12);
        expect(marker.name).toContain(`IK ${Math.round(frame / 24 * 100)}%`);
        const glyph = marker.children.find(child => child instanceof LineSegments) as LineSegments;
        expect(Array.isArray(glyph.material)).toBe(false);
        expect((glyph.material as import("three").LineBasicMaterial).opacity).toBeCloseTo(0.45 + 0.45 * frame / 24, 12);
      }
    }
    const disabled = { ...doc, ikHandles: [{ ...doc.ikHandles![0], enabled: false }] };
    markers.sync(disabled, evaluate(disabled, 24), 24);
    expect(target.name).toContain("disabled"); expect(target.userData.blend).toBe(1);
    const previous = target.position.clone();
    expect(() => markers.sync(doc, evaluate(doc, 0), NaN)).toThrow(/frame.*finite/);
    expect(target.position.equals(previous)).toBe(true);
    expect(JSON.stringify(doc)).toBe(before);
    markers.dispose(); expect(world.children).toHaveLength(0);
  });
});

describe("matching and deleting animated IK blend", () => {
  it("matches the fractional solved pose and keys animated blend zero in one undo without changing the static fallback", async () => {
    const doc = fixture(); doc.ikHandles![0].blend = 0;
    const frame = 12.5, before = evaluate(doc, frame), store = createSceneStore(doc);
    matchFKToIK(store, "ik", frame);
    const next = store.getState().document;
    expect(next.ikHandles![0].blend).toBe(0);
    expect(next.animation!.tracks.find(track => track.channel === "ik.blend")!.keys.map(key => [key.time, key.value])).toEqual([[0, 0], [12.5, 0], [24, 1]]);
    expect(evaluateIKBlend(next, "ik", frame)).toBe(0);
    expect(evaluateIKBlend(next, "ik", 24)).toBe(1);
    expectSameWorld(next, before, evaluate(next, frame));
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    const reopened = await decodeProject(await encodeProject(next, new Map(), editor));
    expect(reopened.scene.animation).toEqual(next.animation);
    expectSameWorld(reopened.scene, before, evaluate(reopened.scene, frame));
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(next);
  });

  it("replaces a blend key while retaining its curve metadata and leaves the static blend untouched", () => {
    const doc = fixture();
    const original = { id: "blend_switch", time: 12.5, value: 0.5, interpolation: "step" as const, tangentMode: "fixed" as const, inSlope: 0.2, outSlope: -0.1, inWeight: 0.3, outWeight: 0.7, broken: true };
    doc.animation!.tracks[0].keys.splice(1, 0, original);
    const before = evaluate(doc, 12.5), store = createSceneStore(doc);
    matchFKToIK(store, "ik", 12.5);
    const next = store.getState().document;
    expect(next.ikHandles![0].blend).toBe(1);
    expect(next.animation!.tracks.find(track => track.channel === "ik.blend")!.keys.find(key => key.id === original.id)).toEqual({ ...original, value: 0 });
    expectSameWorld(next, before, evaluate(next, 12.5));
    expect(doc.animation!.tracks[0].keys[1]).toBe(original);
  });

  it("keeps legacy matching static when no blend curve exists", () => {
    const doc = fixture(false), before = evaluate(doc, 9.25), store = createSceneStore(doc);
    matchFKToIK(store, "ik", 9.25);
    const next = store.getState().document;
    expect(next.ikHandles![0].blend).toBe(0);
    expect(next.animation!.tracks.some(track => track.channel === "ik.blend")).toBe(false);
    expectSameWorld(next, before, evaluate(next, 9.25));
    expect(store.temporal.getState().pastStates).toHaveLength(1);
  });

  it("rejects matching at effective zero or while disabled without adding rotation or blend keys", () => {
    for (const [doc, frame] of [[fixture(), 0], [{ ...fixture(), ikHandles: [{ ...fixture().ikHandles![0], enabled: false }] }, 24]] as const) {
      const store = createSceneStore(doc);
      expect(() => matchFKToIK(store, "ik", frame)).toThrow(/above zero/);
      expect(store.getState().document).toBe(doc);
      expect(store.temporal.getState().pastStates).toHaveLength(0);
    }
  });

  it("does not leak a staged blend switch when an unkeyed position preview makes matching fail", () => {
    const doc = fixture(), frame = 12.5, store = createSceneStore(doc), preview = evaluateSceneAnimation(doc, frame);
    preview.set("root", { ...preview.get("root")!, position: [4, 0, 0] });
    const stages = evaluateRigStages(doc, preview, true, frame);
    expect(() => matchFKToIK(store, "ik", frame, stages.solvedPoses, stages.fkPoses)).toThrow(/Matching rotation keys would change/);
    expect(store.getState().document).toBe(doc);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    expect(doc.animation!.tracks[0].keys.some(key => key.time === frame)).toBe(false);
  });

  it("deletes only the removed handle's blend tracks in the same undo, leaving other animation archive-valid", async () => {
    const doc = fixture();
    doc.joints!.push(
      { id: "root2", name: "Root2", parentId: null, position: [3, 0, 0] },
      { id: "end2", name: "End2", parentId: "root2", position: [0, 1, 0] },
    );
    doc.ikHandles!.push({ ...doc.ikHandles![0], id: "ik2", name: "Other", rootId: "root2", endId: "end2", solver: "ccd" });
    const rotation: AnimationTrack = { ...blendTrack("root"), id: "root_rotation", targetId: "root", channel: "rotation.z" };
    doc.animation!.tracks.push(blendTrack("ik2", 0.2, 0.8), rotation);
    const store = createSceneStore(doc); deleteIKHandle(store, "ik");
    const next = store.getState().document;
    expect(next.ikHandles!.map(handle => handle.id)).toEqual(["ik2"]);
    expect(next.animation!.tracks).toEqual([doc.animation!.tracks[1], rotation]);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    const reopened = await decodeProject(await encodeProject(next, new Map(), editor));
    expect(reopened.scene.animation).toEqual(next.animation);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(next);
    deleteIKHandle(store, "ik"); expect(store.temporal.getState().pastStates).toHaveLength(1);
  });

  it.each(["root", "control", "controlShape"])("rejects handle ID collisions with %s", id => {
    const doc = fixture(false);
    doc.nodes.control = { id: "control", name: "Control", type: "transform", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
    doc.nodes.controlShape = { id: "controlShape", name: "ControlShape", type: "curveShape", parentId: "control", degree: 1, points: [[0, 0, 0, 1], [1, 0, 0, 1]], knots: [0, 0, 1, 1], color: "#ffffff", closed: false };
    expect(() => validateIKHandles([{ ...doc.ikHandles![0], id }], doc)).toThrow(/distinct from object and joint IDs/);
  });
});
