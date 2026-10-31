import { describe, expect, it } from "vitest";
import { baseChannels, defaultAnimation, evaluateChannels, type AnimationPose } from "../src/animation.ts";
import { clearPreferredAngles, keyPreferredAngles, preferredJointIds, setJointPreferredAngle, setPreferredAngles } from "../src/joint-preferred.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { emptyScene, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore, type SceneStore } from "../src/scene-store.ts";

function fixture(): SceneDocument {
  return { ...emptyScene(), joints: [
    { id: "root", name: "Root", parentId: null, position: [1, 0, 0], rotation: [10, 20, 30] },
    { id: "middle", name: "Middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "End", parentId: "middle", position: [0, 1, 0], rotation: [-4, 5, 6] },
  ], ikHandles: [{ id: "ik", name: "Arm", rootId: "root", endId: "end", target: [2, 1, 0],
    solver: "ccd", iterations: 32, blend: 0.7, enabled: true }] };
}
function pose(doc: SceneDocument, id: string, rotation: Vec3): AnimationPose {
  return { ...baseChannels(doc, id), rotation };
}
function expectAtomic(store: SceneStore, operation: () => void, message?: RegExp) {
  const before = store.getState().document, history = store.temporal.getState().pastStates.length;
  expect(operation).toThrow(message);
  expect(store.getState().document).toBe(before);
  expect(store.temporal.getState().pastStates).toHaveLength(history);
}

describe("joint preferred-angle commands", () => {
  it("collects a deterministic root-first subtree without relying on authored array order", () => {
    const doc = fixture();
    doc.joints!.push({ id: "a_branch", name: "Branch", parentId: "root", position: [1, 0, 0] });
    doc.joints!.reverse();
    expect(preferredJointIds(doc, "root", true)).toEqual(["root", "a_branch", "middle", "end"]);
    expect(preferredJointIds(doc, "middle", true)).toEqual(["middle", "end"]);
    expect(preferredJointIds(doc, "root", false)).toEqual(["root"]);
    expect(() => preferredJointIds(doc, "gone", true)).toThrow(/no longer exists/i);
    expect(() => preferredJointIds(doc, "root", undefined as unknown as boolean)).toThrow(/descendants/i);
  });

  it("rejects cyclic and missing-parent hierarchies before traversing", () => {
    const doc = fixture();
    doc.joints![0].parentId = "end";
    expect(() => preferredJointIds(doc, "root", true)).toThrow();
    doc.joints![0].parentId = "gone";
    expect(() => preferredJointIds(doc, "root", false)).toThrow();
  });

  it("captures authored rotations, including implicit zero, without posing or changing IK", () => {
    const doc = fixture(), original = structuredClone(doc), store = createSceneStore(doc);
    setPreferredAngles(store, ["root", "middle", "end"]);
    const next = store.getState().document;
    expect(next.joints!.map(joint => joint.preferredAngle)).toEqual([[10, 20, 30], [0, 0, 0], [-4, 5, 6]]);
    expect(next.joints!.map(joint => joint.rotation)).toEqual(doc.joints!.map(joint => joint.rotation));
    expect(next.ikHandles).toBe(doc.ikHandles);
    expect(next.animation).toBeUndefined();
    expect(doc).toEqual(original);
    expect(store.getState().editLabel).toBe("Capture preferred angles");
    expect(store.temporal.getState().pastStates).toHaveLength(1);
  });

  it("captures supplied prepared FK rotations with deep copies and one undo", () => {
    const doc = fixture(), store = createSceneStore(doc);
    const poses = new Map([["root", pose(doc, "root", [350, -20, 720])], ["middle", pose(doc, "middle", [1, 2, 3])]]);
    setPreferredAngles(store, ["root", "middle"], poses);
    const next = store.getState().document;
    poses.get("root")!.rotation[0] = -99;
    expect(next.joints![0].preferredAngle).toEqual([350, -20, 720]);
    expect(next.joints![0].preferredAngle).not.toBe(poses.get("root")!.rotation);
    expect(doc.joints![0].preferredAngle).toBeUndefined();
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(next);
  });

  it("edits and clears metadata without sharing input arrays or adding no-op history", () => {
    const store = createSceneStore(fixture()), angle: Vec3 = [4, 5, 6];
    setJointPreferredAngle(store, "root", angle);
    const edited = store.getState().document;
    expect(store.getState().editLabel).toBe("Edit preferred angle");
    angle[0] = 100;
    expect(edited.joints![0].preferredAngle).toEqual([4, 5, 6]);
    setJointPreferredAngle(store, "root", [4, 5, 6]);
    expect(store.getState().document).toBe(edited);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    clearPreferredAngles(store, ["root", "middle"]);
    const cleared = store.getState().document;
    expect(Object.hasOwn(cleared.joints![0], "preferredAngle")).toBe(false);
    expect(edited.joints![0].preferredAngle).toEqual([4, 5, 6]);
    expect(store.getState().editLabel).toBe("Clear preferred angles");
    clearPreferredAngles(store, ["root", "middle"]);
    expect(store.getState().document).toBe(cleared);
    expect(store.temporal.getState().pastStates).toHaveLength(2);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(edited);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(cleared);
  });

  it("does not add history when capturing unchanged preferences again", () => {
    const store = createSceneStore(fixture());
    setPreferredAngles(store, ["root", "middle"]);
    const captured = store.getState().document;
    setPreferredAngles(store, ["root", "middle"]);
    expect(store.getState().document).toBe(captured);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
  });

  it.each([NaN, Infinity, -Infinity, "3", undefined])("rejects a nonfinite or nonnumeric angle component %s", value => {
    const store = createSceneStore(fixture());
    expectAtomic(store, () => setJointPreferredAngle(store, "root", [0, value, 0] as Vec3), /finite/i);
  });

  it("rejects sparse angles and malformed complete capture batches atomically", () => {
    const doc = fixture(), store = createSceneStore(doc);
    expectAtomic(store, () => setJointPreferredAngle(store, "root", new Array(3) as Vec3), /finite/i);
    expectAtomic(store, () => setJointPreferredAngle(store, "root", [1, 2] as unknown as Vec3), /finite/i);
    const poses = new Map([["root", pose(doc, "root", [1, 2, 3])], ["middle", pose(doc, "middle", [0, NaN, 0])]]);
    expectAtomic(store, () => setPreferredAngles(store, ["root", "middle"], poses), /finite/i);
    poses.delete("middle");
    expectAtomic(store, () => setPreferredAngles(store, ["root", "middle"], poses), /prepared FK pose.*missing/i);
  });

  it("rejects missing, duplicate and empty joint batches before any command writes", () => {
    const store = createSceneStore(fixture());
    for (const ids of [["root", "gone"], ["root", "root"], [], new Array<string>(1)]) {
      expectAtomic(store, () => setPreferredAngles(store, ids));
      expectAtomic(store, () => clearPreferredAngles(store, ids));
      expectAtomic(store, () => keyPreferredAngles(store, ids, 0));
    }
    expectAtomic(store, () => setJointPreferredAngle(store, "gone", [0, 0, 0]), /no longer exists/i);
  });

  it("keys only stored XYZ rotations, preserving existing key metadata, other channels and IK", () => {
    const doc = fixture();
    doc.joints![0].preferredAngle = [350, -20, 720]; doc.joints![1].preferredAngle = [40, 50, 60];
    const existingKey = { id: "rz_key", time: 2.5, value: 20, interpolation: "bezier" as const,
      tangentMode: "fixed" as const, inSlope: 3, outSlope: -2, inWeight: 0.2, outWeight: 0.4, broken: true };
    doc.animation = { ...defaultAnimation(), fps: 30, start: -10, end: 90, loop: false, tracks: [
      { id: "rz", targetId: "root", channel: "rotation.z", keys: [existingKey] },
      { id: "px", targetId: "root", channel: "position.x", keys: [{ id: "px_key", time: 0, value: 99, interpolation: "linear", tangentMode: "auto" }] },
      { id: "blend", targetId: "ik", channel: "ik.blend", keys: [{ id: "blend_key", time: 0, value: 0.25, interpolation: "step", tangentMode: "auto" }] },
      { id: "visible", targetId: "middle", channel: "visibility", keys: [{ id: "visible_key", time: 0, value: 0, interpolation: "step", tangentMode: "auto" }] },
    ] };
    const store = createSceneStore(doc), original = structuredClone(doc);
    keyPreferredAngles(store, ["root", "middle"], 2.5);
    const next = store.getState().document;
    expect(evaluateChannels(next, "root", 2.5).rotation).toEqual([350, -20, 720]);
    expect(evaluateChannels(next, "middle", 2.5).rotation).toEqual([40, 50, 60]);
    expect(next.animation!.tracks.find(track => track.id === "rz")!.keys).toEqual([{ ...existingKey, value: 720 }]);
    expect(next.animation!.tracks.filter(track => ["px", "blend", "visible"].includes(track.id))).toEqual(doc.animation.tracks.slice(1));
    expect(next.animation).toMatchObject({ fps: 30, start: -10, end: 90, loop: false });
    expect(next.joints).toBe(doc.joints); expect(next.ikHandles).toBe(doc.ikHandles);
    expect(doc).toEqual(original);
    expect(store.getState().editLabel).toBe("Key preferred angles");
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    keyPreferredAngles(store, ["root", "middle"], 2.5);
    expect(store.getState().document).toBe(next);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(next);
  });

  it("requires preferences on every requested joint before keying", () => {
    const doc = fixture(); doc.joints![0].preferredAngle = [1, 2, 3];
    const store = createSceneStore(doc);
    expectAtomic(store, () => keyPreferredAngles(store, ["root", "middle"], 0), /every selected joint/i);
  });

  it("permits metadata on SDK-owned rotations but rejects the entire key batch", () => {
    const doc = fixture();
    doc.drivenKeys = [{ id: "sdk", driver: { targetId: "end", channel: "position.x" },
      driven: { targetId: "root", channel: "rotation.z" }, keys: [{ id: "sdk_key", time: 0, value: 20, interpolation: "linear", tangentMode: "auto" }] }];
    const store = createSceneStore(doc);
    setPreferredAngles(store, ["root", "middle"]);
    expectAtomic(store, () => keyPreferredAngles(store, ["middle", "root"], 0), /driven/i);
    expect(store.getState().document.animation).toBeUndefined();
  });

  it("accepts finite metadata beyond key limits but applies normal time and value limits when keying", () => {
    const store = createSceneStore(fixture());
    setJointPreferredAngle(store, "root", [1e100, -1e100, 0]);
    expect(store.getState().document.joints![0].preferredAngle).toEqual([1e100, -1e100, 0]);
    expectAtomic(store, () => keyPreferredAngles(store, ["root"], 0));
    setJointPreferredAngle(store, "root", [1, 2, 3]);
    for (const frame of [NaN, Infinity, -Infinity, 1e6 + 1, -1e6 - 1])
      expectAtomic(store, () => keyPreferredAngles(store, ["root"], frame), /frame/i);
  });

  it("round-trips preferences and their explicit rotation keys through an archive", async () => {
    const store = createSceneStore(fixture());
    setJointPreferredAngle(store, "root", [-15, 360, 27.5]);
    setPreferredAngles(store, ["middle", "end"]);
    keyPreferredAngles(store, ["root", "middle", "end"], -2.5);
    const doc = store.getState().document;
    expect(() => validateScene(doc)).not.toThrow();
    const opened = await decodeProject(await encodeProject(doc, new Map(), {
      camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 45, near: 0.01, far: 1000 }, time: 0,
    }));
    expect(opened.scene.joints).toEqual(doc.joints);
    expect(opened.scene.animation).toEqual(doc.animation);
    expect(opened.scene.ikHandles).toEqual(doc.ikHandles);
    expect(evaluateChannels(opened.scene, "root", -2.5).rotation).toEqual([-15, 360, 27.5]);
    store.temporal.getState().undo();
    expect(store.getState().document.animation).toBeUndefined();
    expect(store.getState().document.joints![0].preferredAngle).toEqual([-15, 360, 27.5]);
  });
});
