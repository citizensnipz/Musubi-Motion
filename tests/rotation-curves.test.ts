import { describe, expect, it } from "vitest";
import { Euler, Quaternion } from "three";
import { defaultAnimation, evaluateChannels, type AnimationTrack, type CurveKey } from "../src/animation.ts";
import { filterEulerRotations, setRotationInterpolation } from "../src/rotation-curves.ts";
import { addSplat, emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";

const key = (time: number, value: number, patch: Partial<CurveKey> = {}): CurveKey => ({ id: crypto.randomUUID(), time, value, interpolation: "linear", tangentMode: "auto", ...patch });
function fixture(values: number[][] = [[170, -170], [0, 0], [0, 0]]) {
  const doc = emptyScene(); doc.joints = [{ id: "joint", name: "Joint", parentId: null, position: [0, 0, 0] }];
  doc.animation = { ...defaultAnimation(), tracks: values.map((axis, i) => ({ id: `rotation-${i}`, targetId: "joint", channel: ["rotation.x", "rotation.y", "rotation.z"][i] as AnimationTrack["channel"], keys: axis.map((value, index) => key(index * 10, value)) })) };
  return createSceneStore(doc);
}
const values = (store: ReturnType<typeof fixture>) => store.getState().document.animation!.tracks.map(track => track.keys.map(key => key.value));
const quat = (angles: number[]) => new Quaternion().setFromEuler(new Euler(...angles.map(value => value * Math.PI / 180) as [number, number, number], "XYZ"));

describe("explicit rotation curve workflows", () => {
  it("keeps authored turns during ordinary evaluation and changes them only on request", () => {
    const store = fixture([[0, 720], [0, 0], [0, 0]]);
    expect(evaluateChannels(store.getState().document, "joint", 5).rotation[0]).toBe(360);
    expect(filterEulerRotations(store, ["joint"])).toBe(1);
    expect(values(store)[0]).toEqual([0, 0]);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(values(store)[0]).toEqual([0, 720]);
    store.temporal.getState().redo(); expect(values(store)[0]).toEqual([0, 0]);
  });
  it("unwraps sparse fractional-time channels without adding keys or changing the first revolution", () => {
    const store = fixture([[530, -170, -160]]), doc = store.getState().document;
    doc.animation!.tracks = [doc.animation!.tracks[0]]; doc.animation!.tracks[0].keys[1].time = 0.25;
    const ids = doc.animation!.tracks[0].keys.map(key => key.id);
    filterEulerRotations(store, ["joint"], "channels");
    expect(values(store)).toEqual([[530, 550, 560]]);
    expect(store.getState().document.animation!.tracks[0].keys.map(key => key.id)).toEqual(ids);
    expect(store.getState().document.animation!.tracks[0].keys[1].time).toBe(0.25);
  });
  it("chooses the nearby coupled XYZ branch and preserves every keyed orientation", () => {
    const store = fixture([[10, -170], [89, 89], [20, -160]]), original = values(store);
    filterEulerRotations(store, ["joint"]);
    expect(values(store)).toEqual([[10, 10], [89, 91], [20, 20]]);
    for (let index = 0; index < 2; index++) expect(Math.abs(quat(original.map(axis => axis[index])).dot(quat(values(store).map(axis => axis[index]))))).toBeCloseTo(1, 12);
  });
  it("transforms fixed middle-axis derivatives on an alternate branch and retains weights", () => {
    const store = fixture([[10, -170], [89, 89], [20, -160]]);
    const source = store.getState().document.animation!.tracks[1].keys[1];
    Object.assign(source, { tangentMode: "fixed", inSlope: 2, outSlope: -3, inWeight: 0.7, outWeight: 0.2, broken: true });
    filterEulerRotations(store, ["joint"]);
    expect(store.getState().document.animation!.tracks[1].keys[1]).toEqual({ ...source, value: 91, inSlope: -2, outSlope: 3 });
  });
  it("rejects unsynchronized XYZ filtering atomically and supports channel unwrap instead", () => {
    const store = fixture(), before = store.getState().document; before.animation!.tracks[1].keys[1].time = 11;
    expect(() => filterEulerRotations(store, ["joint"])).toThrow(/matching/);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(0);
    filterEulerRotations(store, ["joint"], "channels"); expect(values(store)[0]).toEqual([170, 190]);
  });
  it("does not change other targets, SDK curves or non-rotation tracks", () => {
    const store = fixture(); const doc = store.getState().document;
    doc.joints!.push({ id: "other", name: "Other", parentId: null, position: [0, 0, 0] });
    const position: AnimationTrack = { id: "position", targetId: "joint", channel: "position.x", keys: [key(0, 1)] };
    doc.animation!.tracks.push(position);
    doc.drivenKeys = [{ id: "sdk", driver: { targetId: "joint", channel: "position.x" }, driven: { targetId: "other", channel: "rotation.x" }, keys: [key(0, 720)] }];
    filterEulerRotations(store, ["joint"]);
    expect(store.getState().document.drivenKeys).toBe(doc.drivenKeys);
    expect(store.getState().document.animation!.tracks.at(-1)).toBe(position);
  });
  it("changes interpolation in one history entry while retaining values and tangent metadata", () => {
    const store = fixture([[0, 720], [0, 0], [0, 0]]), before = structuredClone(store.getState().document.animation!.tracks);
    setRotationInterpolation(store, ["joint"], "step");
    expect(evaluateChannels(store.getState().document, "joint", 5).rotation[0]).toBe(0);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    setRotationInterpolation(store, ["joint"], "step"); expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document.animation!.tracks).toEqual(before);
    setRotationInterpolation(store, ["joint"], "bezier"); expect(values(store)[0]).toEqual([0, 720]);
  });
  it("skips no-op cleanup and rejects invalid scope/modes without history", () => {
    const store = fixture([[10, 20], [0, 0], [0, 0]]);
    expect(filterEulerRotations(store, ["joint"])).toBe(0);
    expect(() => filterEulerRotations(store, ["missing"])).toThrow(/missing/);
    expect(() => filterEulerRotations(store, ["joint"], "bad" as never)).toThrow(/mode/);
    expect(() => setRotationInterpolation(store, ["joint"], "bad" as never)).toThrow(/interpolation/);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });
  it("round-trips filtered values and interpolation through MSB", async () => {
    const store = fixture(); filterEulerRotations(store, ["joint"]); setRotationInterpolation(store, ["joint"], "bezier");
    const document = store.getState().document;
    const bytes = await encodeProject(document, new Map(), { camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: 0.01, far: 1000 }, time: 0 });
    expect((await decodeProject(bytes)).scene).toEqual(document);
  });
  it("handles object and joint scopes together without touching authored base rotations", () => {
    const store = fixture(), doc = store.getState().document;
    const next = addSplat(doc, { id: "asset", kind: "procedural", generator: "knot-v1" }, "Object", [0, 0, 0], "object", "shape").document;
    next.animation = { ...doc.animation!, tracks: [...doc.animation!.tracks, ...doc.animation!.tracks.map(track => ({ ...track, id: `object-${track.id}`, targetId: "object", keys: track.keys.map(key => ({ ...key, id: `object-${key.id}` })) }))] };
    const target = createSceneStore(next);
    expect(filterEulerRotations(target, ["object", "joint", "object"])).toBe(2);
    expect(target.getState().document.nodes).toBe(next.nodes);
    expect(target.getState().document.joints).toBe(next.joints);
    expect(target.temporal.getState().pastStates).toHaveLength(1);
  });
  it("does not partly filter earlier targets when a later target has mismatched axes", () => {
    const store = fixture(), doc = store.getState().document;
    doc.joints!.push({ id: "other", name: "Other", parentId: null, position: [0, 0, 0] });
    doc.animation!.tracks.push({ id: "other-x", targetId: "other", channel: "rotation.x", keys: [key(0, 170), key(10, -170)] });
    expect(() => filterEulerRotations(store, ["joint", "other"])).toThrow(/matching/);
    expect(store.getState().document).toBe(doc);
    expect(values(store)[0]).toEqual([170, -170]);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });
  it("preserves keyed orientations across many turns and singularity-adjacent branches, and is idempotent", () => {
    const input = Array.from({ length: 3 }, (_, axis) => Array.from({ length: 160 }, (_, index) =>
      axis === 1 ? 89.99 + index * 0.001 : Math.sin(index * 0.23 + axis) * 4000));
    const store = fixture(input); filterEulerRotations(store, ["joint"]);
    const filtered = values(store);
    for (let index = 0; index < 160; index++) expect(Math.abs(quat(input.map(axis => axis[index])).dot(quat(filtered.map(axis => axis[index]))))).toBeCloseTo(1, 10);
    expect(filterEulerRotations(store, ["joint"])).toBe(0);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
  });
});
