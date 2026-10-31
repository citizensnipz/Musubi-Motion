import { describe, expect, it } from "vitest";
import { ANIMATION_CHANNELS, POSE_ANIMATION_CHANNELS, channelsForTarget, copyKeys, defaultAnimation, deleteKeys, evaluateChannels, evaluateCurve, evaluateIKBlend,
  evaluateSceneAnimation, insertKey, keyChannels, moveKeys, pasteKeys, patchKeys, readChannel, scaleKeys, setIKBlendKey, setKeys, upsertTrack, validateAnimation, writeChannel,
  type AnimationTrack, type CurveKey } from "../src/animation.ts";
import { createController } from "../src/controller-curves.ts";
import { createIKHandle, updateIKHandle } from "../src/ik.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { emptyScene, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture() {
  const store = createSceneStore({ ...emptyScene(), joints: [
    { id: "root", name: "Root", parentId: null, position: [0, 0, 0] },
    { id: "middle", name: "Middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "End", parentId: "middle", position: [0, 1, 0] },
    { id: "root2", name: "Root2", parentId: null, position: [3, 0, 0] },
    { id: "middle2", name: "Middle2", parentId: "root2", position: [0, 1, 0] },
    { id: "end2", name: "End2", parentId: "middle2", position: [0, 1, 0] },
  ] });
  const control = createController(store, "circle"), id = createIKHandle(store, "root", "end"), other = createIKHandle(store, "root2", "end2");
  updateIKHandle(store, id, { blend: .35 });
  return { store, id, other, control };
}
function curve(targetId: string, interpolation: CurveKey["interpolation"] = "linear"): AnimationTrack {
  return { id: "blend-track", targetId, channel: "ik.blend", keys: [
    { id: "a", time: 0, value: .2, interpolation, tangentMode: "auto" },
    { id: "b", time: 10, value: .8, interpolation, tangentMode: "auto" },
  ] };
}

describe("IK blend animation channels", () => {
  it("exposes target-specific channels without adding blend to transform poses", () => {
    const { store, control, id } = fixture(), doc = store.getState().document;
    expect(POSE_ANIMATION_CHANNELS).toHaveLength(10); expect(ANIMATION_CHANNELS).toHaveLength(11);
    expect(channelsForTarget(doc, control)).toEqual(POSE_ANIMATION_CHANNELS);
    expect(channelsForTarget(doc, "root")).toEqual(POSE_ANIMATION_CHANNELS.filter(channel => !channel.startsWith("scale.")));
    expect(channelsForTarget(doc, id)).toEqual(["ik.blend"]);
    expect(() => channelsForTarget(doc, "missing")).toThrow(/missing/);
    const pose = evaluateChannels(doc, control, 0), before = structuredClone(pose);
    expect(() => readChannel(pose, "ik.blend")).toThrow(/pose channel/);
    expect(() => writeChannel(pose, "ik.blend", .5)).toThrow(/pose channel/);
    expect(pose).toEqual(before);
    expect(() => evaluateChannels(doc, id, 0)).toThrow(/missing/);
  });

  it("preserves literal fallback for legacy and empty curves, independently of enable state", () => {
    const { store, id } = fixture();
    expect(evaluateIKBlend(store.getState().document, id, 123)).toBe(.35);
    upsertTrack(store, { ...curve(id), keys: [] }); updateIKHandle(store, id, { enabled: false });
    expect(evaluateIKBlend(store.getState().document, id, -99.25)).toBe(.35);
    for (const frame of [NaN, Infinity, -Infinity]) expect(() => evaluateIKBlend(store.getState().document, id, frame)).toThrow(/finite/);
    expect(() => evaluateIKBlend(store.getState().document, "missing", 0)).toThrow(/missing/);
  });

  it("evaluates linear and stepped blend keys with endpoint hold and fractional frames", () => {
    const { store, id } = fixture(); upsertTrack(store, curve(id));
    expect(evaluateIKBlend(store.getState().document, id, 2.5)).toBeCloseTo(.35, 12);
    expect(evaluateIKBlend(store.getState().document, id, -1)).toBe(.2);
    expect(evaluateIKBlend(store.getState().document, id, 11)).toBe(.8);
    upsertTrack(store, curve(id, "step"));
    expect(evaluateIKBlend(store.getState().document, id, 9.999)).toBe(.2);
    expect(evaluateIKBlend(store.getState().document, id, 10)).toBe(.8);
    const poses = evaluateSceneAnimation(store.getState().document, 5);
    expect(poses.has(id)).toBe(false); expect(poses.get("root")!.rotation).toEqual([0, 0, 0]);
  });

  it("keeps raw weighted Bezier overshoot while clamping only the effective blend", () => {
    const { store, id } = fixture();
    for (const sign of [1, -1]) {
      const track = curve(id, "bezier");
      track.keys[0] = { ...track.keys[0], tangentMode: "fixed", outSlope: sign, outWeight: .45 };
      track.keys[1] = { ...track.keys[1], tangentMode: "fixed", inSlope: -sign, inWeight: .3 };
      upsertTrack(store, track);
      const raw = evaluateCurve(track.keys, 5)!;
      expect(sign > 0 ? raw > 1 : raw < 0).toBe(true);
      expect(evaluateIKBlend(store.getState().document, id, 5)).toBe(sign > 0 ? 1 : 0);
      expect(store.getState().document.animation!.tracks[0].keys).toEqual(track.keys);
    }
  });

  it("rejects wrong target families and out-of-range key values atomically", () => {
    const { store, id, control } = fixture(), before = store.getState().document, history = store.temporal.getState().pastStates.length;
    for (const track of [curve(control), curve("root"), curve("missing"), { ...curve(id), channel: "position.x" },
      ...[-.01, 1.01, NaN, Infinity].map(value => ({ ...curve(id), keys: [{ ...curve(id).keys[0], value }] }))]) {
      expect(() => upsertTrack(store, track as AnimationTrack)).toThrow();
    }
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(history);
  });

  it("rejects handle IDs colliding with any scene node or joint even without blend tracks", () => {
    const { store, id, control } = fixture(), doc = store.getState().document;
    const shape = Object.values(doc.nodes).find(node => node.parentId === control)!;
    for (const collision of [control, shape.id, "root"]) {
      const candidate = { ...doc, ikHandles: doc.ikHandles!.map(handle => handle.id === id ? { ...handle, id: collision } : handle) };
      expect(() => validateAnimation(defaultAnimation(), candidate)).toThrow(/distinct/);
    }
  });

  it("keys explicit scalar values with undo/redo, no-op history, and stable replacement tangents", () => {
    const { store, id } = fixture(), before = store.getState().document, count = store.temporal.getState().pastStates.length;
    setIKBlendKey(store, id, 3.5, .6);
    const after = store.getState().document, key = after.animation!.tracks[0].keys[0];
    expect(key).toMatchObject({ time: 3.5, value: .6, interpolation: "bezier", tangentMode: "auto" });
    expect(after.ikHandles!.find(handle => handle.id === id)!.blend).toBe(.35);
    setIKBlendKey(store, id, 3.5, .6); expect(store.getState().document).toBe(after);
    expect(store.temporal.getState().pastStates).toHaveLength(count + 1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
    patchKeys(store, [key.id], { interpolation: "step", tangentMode: "fixed", inSlope: 2, outSlope: -3, broken: true });
    const edited = store.getState().document.animation!.tracks[0].keys[0]; setIKBlendKey(store, id, 3.5, .9);
    expect(store.getState().document.animation!.tracks[0].keys[0]).toEqual({ ...edited, value: .9 });
  });

  it("supports mixed-target Set Key without inventing an IK transform pose", () => {
    const { store, id, control } = fixture(), pose = evaluateChannels(store.getState().document, control, 0);
    setKeys(store, [control, "root", id], 7, new Map([[control, { ...pose, position: [2, 3, 4] as Vec3 }], [id, pose]]));
    const tracks = store.getState().document.animation!.tracks;
    expect(tracks).toHaveLength(16); expect(tracks.some(track => track.channel === "visibility")).toBe(false);
    expect(tracks.find(track => track.targetId === id)!.keys[0].value).toBe(.35);
    expect(tracks.find(track => track.targetId === control && track.channel === "position.y")!.keys[0].value).toBe(3);
    const before = store.getState().document;
    expect(() => setKeys(store, [control, id], 8, undefined, ["position.x"])).toThrow(/not supported/);
    expect(store.getState().document).toBe(before);
    setKeys(store, [control], 7, undefined, ["visibility"]);
    expect(store.getState().document.animation!.tracks.some(track => track.channel === "visibility")).toBe(true);
  });

  it("provides scalar Auto Key updates while preserving existing-only and no-op semantics", () => {
    const { store, id, control } = fixture(), original = store.getState().document;
    expect(keyChannels(original, id, .7, 5)).toBe(original);
    const empty = { ...original, animation: { ...defaultAnimation(), tracks: [{ ...curve(id), keys: [] }] } };
    expect(keyChannels(empty, id, .7, 5)).toBe(empty);
    const keyed = keyChannels(original, id, .7, 5, false);
    expect(keyed.animation!.tracks[0]).toMatchObject({ targetId: id, channel: "ik.blend" });
    expect(keyChannels(keyed, id, .7, 5)).toBe(keyed);
    expect(keyChannels(keyed, id, .9, 5).animation!.tracks[0].keys[0].value).toBe(.9);
    expect(() => keyChannels(original, control, .3, 0, false)).toThrow(/transform channels/);
    expect(() => keyChannels(original, id, evaluateChannels(original, control, 0), 0)).toThrow(/numeric blend/);
    expect(() => keyChannels(original, id, 2, 0)).toThrow(/zero and one/);
    expect(store.getState().document).toBe(original);
  });

  it("copies and pastes blend curves between handles and rejects pose destinations atomically", () => {
    const { store, id, other, control } = fixture(); upsertTrack(store, curve(id));
    const clipboard = copyKeys(store.getState().document, ["a", "b"]), pasted = pasteKeys(store, clipboard, 20, other);
    const track = store.getState().document.animation!.tracks.find(track => track.targetId === other)!;
    expect(track.keys.map(key => [key.time, key.value])).toEqual([[20, .2], [30, .8]]);
    expect(pasted).toEqual(track.keys.map(key => key.id)); expect(pasted.some(id => ["a", "b"].includes(id))).toBe(false);
    const before = store.getState().document, count = store.temporal.getState().pastStates.length;
    expect(() => pasteKeys(store, clipboard, 40, control)).toThrow(/IK blend tracks/);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(count);
    clipboard.tracks[0].keys[0].value = .9; expect(track.keys[0].value).toBe(.2);
  });

  it("retimes, scales, edits tangents and deletes blend keys using shared commands", () => {
    const { store, id } = fixture(); upsertTrack(store, curve(id));
    moveKeys(store, ["a", "b"], 10); scaleKeys(store, ["a", "b"], 2);
    expect(store.getState().document.animation!.tracks[0].keys.map(key => key.time)).toEqual([10, 30]);
    patchKeys(store, ["a"], { interpolation: "bezier", tangentMode: "fixed", outSlope: 1, outWeight: .4 });
    expect(evaluateIKBlend(store.getState().document, id, 20)).toBe(1);
    const before = store.getState().document;
    expect(() => moveKeys(store, ["b"], 0, .3)).toThrow(/zero and one/); expect(store.getState().document).toBe(before);
    expect(() => moveKeys(store, ["a"], 20)).toThrow(/duplicate key time/); expect(store.getState().document).toBe(before);
    deleteKeys(store, ["a", "b"]); expect(evaluateIKBlend(store.getState().document, id, 20)).toBe(.35);
  });

  it("inserts into in-range weighted curves without changing their shape", () => {
    const { store, id } = fixture(), track = curve(id, "bezier");
    track.keys[0] = { ...track.keys[0], tangentMode: "fixed", outSlope: .025, outWeight: .2 };
    track.keys[1] = { ...track.keys[1], tangentMode: "fixed", inSlope: .035, inWeight: .45 };
    upsertTrack(store, track);
    const frames = Array.from({ length: 101 }, (_, index) => index / 10), expected = frames.map(frame => evaluateIKBlend(store.getState().document, id, frame));
    const inserted = insertKey(store, track.id, 4.25), after = store.getState().document;
    expect(insertKey(store, track.id, 4.25)).toBe(inserted); expect(store.getState().document).toBe(after);
    frames.forEach((frame, index) => expect(evaluateIKBlend(after, id, frame)).toBeCloseTo(expected[index], 10));
  });

  it("rejects shape-preserving insertion at raw overshoot rather than storing an invalid key", () => {
    const { store, id } = fixture(); upsertTrack(store, curve(id, "bezier"));
    patchKeys(store, ["a"], { tangentMode: "fixed", outSlope: 1 });
    const before = store.getState().document, count = store.temporal.getState().pastStates.length;
    expect(() => insertKey(store, "blend-track", 5)).toThrow(/zero and one/);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(count);
  });

  it("roundtrips blend tracks using the existing scene archive", async () => {
    const { store, id } = fixture(); setIKBlendKey(store, id, 0, 0); setIKBlendKey(store, id, 24, 1);
    const scene = store.getState().document;
    const opened = await decodeProject(await encodeProject(scene, new Map(), { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: .01, far: 1000 }, time: .5 }));
    expect(opened.scene.animation).toEqual(scene.animation); expect(evaluateIKBlend(opened.scene, id, 12)).toBeCloseTo(.5, 12);
  });
});
