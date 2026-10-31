import { describe, expect, it } from "vitest";
import { addSplat, emptyScene, type SceneDocument } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import {
  baseChannels, copyKeys, defaultAnimation, deleteKeys, evaluateChannels, evaluateCurve,
  evaluateSceneAnimation, keyChannels, moveKeys, pasteKeys, patchKeys, readChannel, replaceTracks,
  scaleKeys, setAnimationSettings, setKeys, tangentSlope, upsertTrack, validateAnimation, validateCurveKeys,
  withTangent, writeChannel, type AnimationTrack, type CurveKey,
} from "../src/animation.ts";

const key = (time: number, value: number, patch: Partial<CurveKey> = {}): CurveKey => ({
  id: crypto.randomUUID(), time, value, interpolation: "bezier", tangentMode: "auto", ...patch,
});
function fixture() {
  return addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "animated", [0, 0, 0], "object", "shape").document;
}
const track = (keys: CurveKey[], patch: Partial<AnimationTrack> = {}): AnimationTrack => ({ id: crypto.randomUUID(), targetId: "object", channel: "position.x", keys, ...patch });

describe("animation evaluation", () => {
  it("holds endpoints and handles empty, single-key, exact and fractional samples", () => {
    expect(evaluateCurve([], 0)).toBeUndefined();
    expect(evaluateCurve([key(10, 3)], 100)).toBe(3);
    const keys = [key(-5, 1, { interpolation: "linear" }), key(5, 11)];
    expect(evaluateCurve(keys, -100)).toBe(1);
    expect(evaluateCurve(keys, 0.5)).toBeCloseTo(6.5);
    expect(evaluateCurve(keys, 5)).toBe(11);
    expect(evaluateCurve(keys, 100)).toBe(11);
    expect(() => evaluateCurve(keys, NaN)).toThrow();
  });
  it("switches stepped keys at the exact key boundary", () => {
    const keys = [key(0, 0, { interpolation: "step" }), key(10, 10, { interpolation: "step" }), key(20, 20)];
    expect(evaluateCurve(keys, 9.999)).toBe(0);
    expect(evaluateCurve(keys, 10)).toBe(10);
    expect(evaluateCurve(keys, 19.999)).toBe(10);
  });
  it("evaluates unweighted Bezier with independent slopes", () => {
    const keys = [key(0, 0, { tangentMode: "fixed", outSlope: 2 }), key(10, 10, { tangentMode: "fixed", inSlope: 0 })];
    expect(evaluateCurve(keys, 5)).toBeCloseTo(7.5, 10);
    const broken = [key(0, 0, { tangentMode: "fixed", outSlope: 0 }), key(10, 10, { tangentMode: "fixed", inSlope: 0, outSlope: -2, broken: true }), key(20, 0, { tangentMode: "fixed", inSlope: 0 })];
    expect(evaluateCurve(broken, 5)).toBeCloseTo(5);
    expect(evaluateCurve(broken, 15)).toBeCloseTo(2.5);
  });
  it("inverts weighted Bezier time accurately, including crossing handle coordinates", () => {
    const keys = [key(0, 0, { tangentMode: "fixed", outSlope: 0, outWeight: 0.8 }), key(10, 10, { tangentMode: "fixed", inSlope: 0, inWeight: 0.1 })];
    // u=.5 produces x=.7625 and y=.5 with these cubic controls.
    expect(evaluateCurve(keys, 7.625)).toBeCloseTo(5, 8);
    const crossed = [key(0, 0, { tangentMode: "flat", outWeight: 1 }), key(10, 10, { tangentMode: "flat", inWeight: 1 })];
    expect(evaluateCurve(crossed, 5)).toBeCloseTo(5, 4);
    expect(evaluateCurve(crossed, 2)).toBeLessThan(5);
  });
  it("supports auto, clamped, spline and flat tangent presets", () => {
    const keys = [key(0, 0), key(1, 4), key(4, 2)];
    expect(tangentSlope(keys, 1, "out")).toBe(0);
    expect(tangentSlope(keys.map(k => ({ ...k, tangentMode: "spline" })), 1, "out")).toBe(0.5);
    const plateau = [key(0, 1), key(1, 1, { tangentMode: "clamped" }), key(2, 3)];
    expect(tangentSlope(plateau, 1, "in")).toBe(0);
    expect(tangentSlope([key(0, 0, { tangentMode: "flat" }), key(1, 1)], 0, "out")).toBe(0);
    const monotone = [key(0, 0), key(1, 1), key(5, 1.1)];
    for (let t = 0; t <= 5; t += 0.025) {
      const value = evaluateCurve(monotone, t)!;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1.1);
    }
  });
  it("preserves the untouched effective slope when breaking a preset tangent", () => {
    const keys = [key(0, 0), key(10, 10, { broken: true }), key(20, 20)];
    const broken = withTangent(keys, 1, "out", 3, 0.6);
    expect(broken).toMatchObject({ tangentMode: "fixed", inSlope: 1, outSlope: 3, outWeight: 0.6 });
    expect(broken.inWeight).toBeUndefined();
    const linked = withTangent(keys.map(k => ({ ...k, broken: false })), 1, "in", 2, 0.25);
    expect(linked).toMatchObject({ inSlope: 2, outSlope: 2, inWeight: 0.25 });
    expect(keys[1].tangentMode).toBe("auto");
    expect(() => withTangent(keys, 1, "in", NaN)).toThrow();
    expect(() => withTangent(keys, 1, "in", 1, 2)).toThrow();
  });
  it("keeps authored data immutable, preserves full Euler rotations, and clamps scale", () => {
    const doc = fixture();
    doc.animation = { ...defaultAnimation(), tracks: [
      track([key(0, 0, { interpolation: "linear" }), key(10, 720)], { channel: "rotation.y" }),
      track([key(0, -2)], { channel: "scale.x" }),
    ] };
    const pose = evaluateChannels(doc, "object", 5);
    expect(pose.rotation).toEqual([0, 360, 0]);
    expect(pose.scale).toEqual([0.001, 1, 1]);
    expect(baseChannels(doc, "object").rotation).toEqual([0, 0, 0]);
    pose.position[0] = 99;
    expect(baseChannels(doc, "object").position[0]).toBe(0);
  });
  it("evaluates visibility as a stepped Boolean and supports joint channels", () => {
    const doc = fixture();
    doc.joints = [{ id: "joint", name: "joint", parentId: null, position: [0, 1, 0] }];
    doc.animation = { ...defaultAnimation(), tracks: [
      track([key(0, 0), key(10, 1)], { channel: "visibility" }),
      track([key(0, 0, { interpolation: "linear" }), key(10, 90)], { targetId: "joint", channel: "rotation.z" }),
    ] };
    expect(evaluateChannels(doc, "object", 9.9).visibility).toBe(0);
    expect(evaluateChannels(doc, "object", 10).visibility).toBe(1);
    const poses = evaluateSceneAnimation(doc, 5);
    expect(poses.get("joint")!.rotation[2]).toBe(45);
    expect(poses.get("joint")!.position).toEqual([0, 1, 0]);
    expect(poses.get("object")).toEqual(evaluateChannels(doc, "object", 5));
    expect(readChannel(writeChannel(poses.get("object")!, "position.y", 7), "position.y")).toBe(7);
  });
});

describe("animation commands and document integrity", () => {
  it("sets all transform channels together and retains existing key identity", () => {
    const store = createSceneStore(fixture());
    setKeys(store, ["object"], 0);
    const animation = store.getState().document.animation!;
    expect(animation.tracks).toHaveLength(9);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    setKeys(store, ["object"], 0);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    setKeys(store, ["object"], 10, new Map([["object", { position: [4, 2, 1], rotation: [0, 0, 0], scale: [1, 1, 1] }]]));
    expect(evaluateChannels(store.getState().document, "object", 5).position[0]).toBeCloseTo(2);
    expect(store.getState().document.animation!.tracks[0].keys[0].id).toBe(animation.tracks[0].keys[0].id);
    store.temporal.getState().undo();
    expect(store.getState().document.animation).toBe(animation);
    store.temporal.getState().redo();
    expect(evaluateChannels(store.getState().document, "object", 10).position[0]).toBe(4);
  });
  it("auto-keys only changed channels with existing curves and preserves one undo transaction", () => {
    const store = createSceneStore(fixture());
    setKeys(store, ["object"], 0, undefined, ["position.x", "position.y"]);
    const doc = store.getState().document, pose = evaluateChannels(doc, "object", 10);
    pose.position[0] = 5;
    const next = keyChannels(doc, "object", pose, 10);
    expect(next.animation!.tracks[0].keys).toHaveLength(2);
    expect(next.animation!.tracks[1].keys).toHaveLength(1);
    expect(doc.animation!.tracks[0].keys).toHaveLength(1);
    expect(keyChannels(fixture(), "object", pose, 10)).toEqual(fixture());
  });
  it("moves selections across channels atomically and rejects collisions", () => {
    const store = createSceneStore(fixture());
    const a = track([key(0, 0), key(10, 10)]), b = track([key(0, 2)], { channel: "position.y" });
    replaceTracks(store, [a, b]);
    moveKeys(store, [a.keys[0].id, b.keys[0].id], 5, 1);
    expect(store.getState().document.animation!.tracks.map(t => t.keys[0].time)).toEqual([5, 5]);
    const before = store.getState().document;
    expect(() => moveKeys(store, [a.keys[0].id], 5)).toThrow(/duplicate key time/);
    expect(store.getState().document).toBe(before);
    store.temporal.getState().undo();
    expect(store.getState().document.animation!.tracks[0].keys[0].time).toBe(0);
  });
  it("copies and pastes relative timing with new IDs, replacing existing destination times", () => {
    const store = createSceneStore(fixture()), source = track([key(2, 3), key(6, 5)]);
    upsertTrack(store, source);
    const clipboard = copyKeys(store.getState().document, source.keys.map(k => k.id));
    const pasted = pasteKeys(store, clipboard, 6);
    expect(pasted).toHaveLength(2);
    expect(pasted.some(id => source.keys.some(k => k.id === id))).toBe(false);
    expect(store.getState().document.animation!.tracks[0].keys.map(k => [k.time, k.value])).toEqual([[2, 3], [6, 3], [10, 5]]);
    clipboard.tracks[0].keys[0].value = 999;
    expect(store.getState().document.animation!.tracks[0].keys[1].value).toBe(3);
    deleteKeys(store, pasted);
    expect(store.getState().document.animation!.tracks[0].keys).toHaveLength(1);
    deleteKeys(store, [source.keys[0].id]);
    expect(store.getState().document.animation!.tracks).toHaveLength(0);
  });
  it("scales snapped key timing and fixed tangents atomically while preserving curve shape", () => {
    const store = createSceneStore(fixture());
    const curve = track([key(2, 1, { tangentMode: "fixed", outSlope: 2, outWeight: 0.6 }), key(12, 11, { tangentMode: "fixed", inSlope: 0.5 })]);
    upsertTrack(store, curve);
    scaleKeys(store, curve.keys.map(k => k.id), 2);
    const scaled = store.getState().document.animation!.tracks[0].keys;
    expect(scaled.map(k => k.time)).toEqual([2, 22]);
    expect(scaled[0].outSlope).toBe(1);
    expect(scaled[1].inSlope).toBe(0.25);
    expect(evaluateCurve(scaled, 12)).toBeCloseTo(evaluateCurve(curve.keys, 7)!, 8);
    store.temporal.getState().undo();
    const before = store.getState().document;
    expect(() => scaleKeys(store, curve.keys.map(k => k.id), 0.001)).toThrow();
    expect(() => scaleKeys(store, curve.keys.map(k => k.id), -1)).toThrow();
    expect(store.getState().document).toBe(before);
  });
  it("edits tangents, settings and multiple targets through validated undoable commands", () => {
    const store = createSceneStore(fixture()), curve = track([key(0, 0), key(10, 10)]);
    upsertTrack(store, curve);
    patchKeys(store, [curve.keys[0].id], { tangentMode: "fixed", outSlope: 3, outWeight: 0.5, broken: true });
    expect(store.getState().document.animation!.tracks[0].keys[0]).toMatchObject({ outSlope: 3, outWeight: 0.5 });
    setAnimationSettings(store, { fps: 60, start: -20, end: 120, loop: false });
    expect(store.getState().document.animation).toMatchObject({ fps: 60, start: -20, end: 120, loop: false });
    const doc = store.getState().document;
    expect(() => setAnimationSettings(store, { end: -21 })).toThrow();
    expect(() => patchKeys(store, [curve.keys[0].id], { value: NaN })).toThrow();
    expect(store.getState().document).toBe(doc);
  });
  it("skips SDK outputs when keying all channels and rejects explicit conflicting tracks", () => {
    const doc = fixture();
    doc.drivenKeys = [{ id: "driven", driver: { targetId: "object", channel: "position.x" }, driven: { targetId: "object", channel: "rotation.x" }, keys: [key(0, 0)] }];
    const store = createSceneStore(doc);
    setKeys(store, ["object"], 0);
    expect(store.getState().document.animation!.tracks.some(t => t.channel === "rotation.x")).toBe(false);
    expect(() => upsertTrack(store, track([key(0, 0)], { channel: "rotation.x" }))).toThrow(/both time keys/);
  });
  it("rejects malformed archive values, duplicates, missing targets and unsupported joint scales", () => {
    const doc = fixture(), curve = track([key(0, 0), key(10, 10)]), animation = { ...defaultAnimation(), tracks: [curve] };
    expect(() => validateAnimation(animation, doc)).not.toThrow();
    for (const bad of [null, {}, { ...animation, fps: Infinity }, { ...animation, fps: 0 }, { ...animation, loop: 1 },
      { ...animation, tracks: [curve, { ...curve, id: "duplicate-channel" }] },
      { ...animation, tracks: [{ ...curve, targetId: "missing" }] },
      { ...animation, tracks: [{ ...curve, keys: [curve.keys[1], curve.keys[0]] }] },
      { ...animation, tracks: [{ ...curve, keys: [curve.keys[0], { ...curve.keys[1], id: curve.keys[0].id }] }] },
    ]) expect(() => validateAnimation(bad, doc)).toThrow();
    expect(() => validateCurveKeys([key(0, 0, { outWeight: -1 })])).toThrow();
    expect(() => validateCurveKeys([key(0, 0, { inSlope: Infinity })])).toThrow();
    doc.joints = [{ id: "joint", name: "joint", parentId: null, position: [0, 0, 0] }];
    expect(() => validateAnimation({ ...animation, tracks: [{ ...curve, targetId: "joint", channel: "scale.x" }] }, doc)).toThrow(/Joint scale/);
  });
  it("evaluates a representative thousand-channel scene deterministically", () => {
    const doc: SceneDocument = emptyScene();
    doc.animation = defaultAnimation();
    for (let i = 0; i < 1000; i++) {
      const id = `object${i}`;
      doc.nodes[id] = { id, type: "transform", name: id, parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
      doc.animation.tracks.push(track([key(0, 0), key(100, 100)], { targetId: id }));
    }
    const started = performance.now();
    for (let i = 0; i < 100; i++) expect(evaluateSceneAnimation(doc, i).get("object999")!.position[0]).toBeCloseTo(i);
    console.info(`Animation benchmark: 1000 tracks × 100 evaluations in ${(performance.now() - started).toFixed(1)} ms`);
    expect(doc.nodes.object999.position).toEqual([0, 0, 0]);
  });
});
