import { describe, expect, it } from "vitest";
import { addSplat, emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { defaultAnimation, evaluateCurve, type CurveKey } from "../src/animation.ts";
import { upsertDrivenRelationship, type DrivenKeyRelationship } from "../src/driven-keys.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import {
  copyDrivenCurveKeys, deleteDrivenCurveKeys, drivenCurveTracks, insertDrivenCurveKey,
  moveDrivenCurveKeys, pasteDrivenCurveKeys, patchDrivenCurveKeys, replaceDrivenTracks, scaleDrivenCurveKeys,
} from "../src/driven-curve-edit.ts";

const key = (id: string, time: number, value: number, patch: Partial<CurveKey> = {}): CurveKey => ({
  id, time, value, interpolation: "linear", tangentMode: "auto", ...patch,
});
function fixture(channel: DrivenKeyRelationship["driven"]["channel"] = "position.y") {
  let doc = emptyScene();
  for (const id of ["a", "b", "c"]) doc = addSplat(doc, { id: `asset-${id}`, kind: "procedural", generator: "knot-v1" }, id, [0, 0, 0], id, `shape-${id}`).document;
  doc.animation = { ...defaultAnimation(), tracks: [{ id: "time", targetId: "a", channel: "position.x", keys: [key("time-key", 0, 0), key("time-end", 24, 1)] }] };
  doc.drivenKeys = [{ id: "sdk", driver: { targetId: "a", channel: "position.x" }, driven: { targetId: "b", channel },
    keys: [key("left", -.5, .2), key("right", .5, .8)] }];
  return createSceneStore(doc);
}
const curve = (store: ReturnType<typeof fixture>) => store.getState().document.drivenKeys![0];

describe("driven curve editing commands", () => {
  it("moves fractional coordinates and values in one undo step without altering time animation", () => {
    const store = fixture(), before = store.getState().document;
    moveDrivenCurveKeys(store, ["left", "right"], .125, .25);
    expect(curve(store).keys.map(k => [k.time, k.value])).toEqual([[-.375, .45], [.625, 1.05]]);
    expect(store.getState().document.animation).toBe(before.animation);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(curve(store).keys[0].time).toBe(-.375);
  });

  it("inserts fractional weighted Bezier keys while preserving the entire curve", () => {
    const store = fixture();
    upsertDrivenRelationship(store, { ...curve(store), keys: [
      key("left", -.5, .2, { interpolation: "bezier", tangentMode: "fixed", outSlope: 2, outWeight: .6 }),
      key("right", .5, .8, { interpolation: "bezier", tangentMode: "fixed", inSlope: -.4, inWeight: .2 }),
    ] });
    const original = structuredClone(curve(store).keys), animation = store.getState().document.animation;
    const count = store.temporal.getState().pastStates.length, id = insertDrivenCurveKey(store, "sdk", .125);
    expect(curve(store).keys.find(k => k.id === id)!.time).toBe(.125);
    for (let i = 0; i <= 1000; i++) expect(evaluateCurve(curve(store).keys, -.75 + i * .0015)).toBeCloseTo(evaluateCurve(original, -.75 + i * .0015)!, 8);
    expect(store.getState().document.animation).toBe(animation);
    expect(store.temporal.getState().pastStates).toHaveLength(count + 1);
    expect(insertDrivenCurveKey(store, "sdk", .125)).toBe(id);
    expect(store.temporal.getState().pastStates).toHaveLength(count + 1);
  });

  it("keeps explicitly linear SDK visibility continuous during insertion", () => {
    const store = fixture("visibility");
    const id = insertDrivenCurveKey(store, "sdk", -.25);
    expect(curve(store).keys.find(k => k.id === id)!.value).toBeCloseTo(.35);
    expect(evaluateCurve(curve(store).keys, 0)).toBeCloseTo(.5);
  });

  it("scales fractional driver coordinates and fixed tangent slopes without snapping", () => {
    const store = fixture();
    patchDrivenCurveKeys(store, ["left", "right"], { interpolation: "bezier", tangentMode: "fixed", inSlope: 1, outSlope: 2, broken: true });
    const original = structuredClone(curve(store).keys);
    scaleDrivenCurveKeys(store, ["left", "right"], .25);
    expect(curve(store).keys.map(k => k.time)).toEqual([-.5, -.25]);
    expect(curve(store).keys[0].outSlope).toBe(8);
    expect(curve(store).keys[1].inSlope).toBe(4);
    for (let i = 0; i <= 100; i++) expect(evaluateCurve(curve(store).keys, -.5 + i * .0025)).toBeCloseTo(evaluateCurve(original, -.5 + i * .01)!, 9);
  });

  it("rejects collisions and invalid coordinates atomically", () => {
    const store = fixture(), before = store.getState().document;
    for (const action of [
      () => moveDrivenCurveKeys(store, ["left"], 1),
      () => patchDrivenCurveKeys(store, ["left"], { time: .5 }),
      () => moveDrivenCurveKeys(store, ["left"], Infinity),
      () => insertDrivenCurveKey(store, "sdk", 1e6 + 1),
      () => scaleDrivenCurveKeys(store, ["right"], 0),
    ]) {
      expect(action).toThrow(); expect(store.getState().document).toBe(before);
      expect(store.temporal.getState().pastStates).toHaveLength(0);
    }
  });

  it.each(["scale.x", "visibility"] as const)("validates %s output bounds before committing", channel => {
    const store = fixture(channel), before = store.getState().document;
    for (const value of channel === "visibility" ? [-.01, 1.01] : [0, -.01]) {
      expect(() => patchDrivenCurveKeys(store, ["left"], { value })).toThrow();
      expect(store.getState().document).toBe(before);
    }
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("does not retarget display adapters and validates all replacement curves atomically", () => {
    const store = fixture(), before = store.getState().document, track = drivenCurveTracks(before)[0];
    expect(track).toEqual({ id: "sdk", targetId: "b", channel: "position.y", keys: curve(store).keys });
    expect(() => replaceDrivenTracks(store, [{ ...track, targetId: "c" }])).toThrow(/cannot change/);
    expect(() => replaceDrivenTracks(store, [track, track])).toThrow(/Duplicate/);
    expect(() => replaceDrivenTracks(store, [{ ...track, id: "gone" }])).toThrow(/no longer exists/);
    expect(store.getState().document).toBe(before);
    replaceDrivenTracks(store, [{ ...track, keys: track.keys.map(k => ({ ...k, outWeight: .25, broken: true })) }]);
    expect(curve(store).keys[0].outWeight).toBe(.25);
    expect(store.getState().document.animation).toBe(before.animation);
  });

  it("copies independent records, pastes fractional coordinates with new IDs and replaces coordinate collisions", () => {
    const store = fixture(), clipboard = copyDrivenCurveKeys(store.getState().document, ["left", "right"]);
    expect(clipboard.origin).toBe(-.5);
    expect(clipboard.relationships[0]).not.toBe(curve(store));
    const ids = pasteDrivenCurveKeys(store, clipboard, .5);
    expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain("left"); expect(ids).not.toContain("right");
    expect(curve(store).keys.map(k => k.time)).toEqual([-.5, .5, 1.5]);
    expect(curve(store).driver).toEqual(clipboard.relationships[0].driver);
    expect(curve(store).driven).toEqual(clipboard.relationships[0].driven);
    expect(curve(store).keys.find(k => k.time === .5)!.id).toBe(ids[0]);
    store.temporal.getState().undo(); expect(curve(store).keys.map(k => k.id)).toEqual(["left", "right"]);
  });

  it("allows explicit single-curve paste while preserving destination properties", () => {
    const store = fixture(), clipboard = copyDrivenCurveKeys(store.getState().document, ["left"]);
    const destination: DrivenKeyRelationship = { id: "other", driver: { targetId: "c", channel: "rotation.x" }, driven: { targetId: "b", channel: "rotation.z" }, keys: [key("other-key", 0, 0)] };
    upsertDrivenRelationship(store, destination);
    const ids = pasteDrivenCurveKeys(store, clipboard, .125, "other");
    const result = store.getState().document.drivenKeys![1];
    expect(result.driver).toEqual(destination.driver); expect(result.driven).toEqual(destination.driven);
    expect(result.keys.find(k => k.id === ids[0])).toMatchObject({ time: .125, value: .2 });
    expect(curve(store).keys.map(k => k.id)).toEqual(["left", "right"]);
  });

  it("rejects clipboard ownership conflicts, cycles, missing targets and range overflow atomically", () => {
    const store = fixture(), original = copyDrivenCurveKeys(store.getState().document, ["left", "right"]);
    const before = store.getState().document;
    for (const mutate of [
      (c: typeof original) => { c.relationships[0].driver.targetId = "c"; },
      (c: typeof original) => { c.relationships[0].driven = { targetId: "a", channel: "position.x" }; },
      (c: typeof original) => { c.relationships[0].driven.targetId = "missing"; },
    ]) {
      const copy = structuredClone(original); mutate(copy);
      expect(() => pasteDrivenCurveKeys(store, copy, .125)).toThrow();
      expect(store.getState().document).toBe(before);
    }
    expect(() => pasteDrivenCurveKeys(store, original, 1e6)).toThrow();
    expect(store.getState().document).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("deletes the last SDK key as a relationship and restores it via undo and clipboard", () => {
    const store = fixture(), clipboard = copyDrivenCurveKeys(store.getState().document, ["left", "right"]);
    deleteDrivenCurveKeys(store, ["left", "right"]); expect(store.getState().document.drivenKeys).toEqual([]);
    store.temporal.getState().undo(); expect(curve(store).id).toBe("sdk");
    store.temporal.getState().redo();
    pasteDrivenCurveKeys(store, clipboard, -.375);
    expect(curve(store).id).not.toBe("sdk");
    expect(curve(store).keys.map(k => k.time)).toEqual([-.375, .625]);
    expect(curve(store).driver).toEqual(clipboard.relationships[0].driver);
  });

  it("rejects a late multi-relationship paste failure without committing the earlier curve", () => {
    const store = fixture(), clipboard = copyDrivenCurveKeys(store.getState().document, ["left"]);
    clipboard.relationships.push({ id: "invalid-output", driver: { targetId: "a", channel: "position.x" },
      driven: { targetId: "c", channel: "visibility" }, keys: [key("invalid-key", -.5, 2)] });
    const before = store.getState().document;
    expect(() => pasteDrivenCurveKeys(store, clipboard, .125)).toThrow(/Visibility/);
    expect(store.getState().document).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("ignores no-ops and does not mix time-key IDs with SDK key selection", () => {
    const store = fixture(), before = store.getState().document;
    moveDrivenCurveKeys(store, ["time-key"], .125);
    patchDrivenCurveKeys(store, ["time-key"], { value: 90 });
    deleteDrivenCurveKeys(store, ["time-key"]);
    scaleDrivenCurveKeys(store, ["left", "right"], 1);
    replaceDrivenTracks(store, drivenCurveTracks(before));
    expect(store.getState().document).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("round-trips edited SDK tangents and fractional coordinates in msb without synthetic time curves", async () => {
    const store = fixture();
    patchDrivenCurveKeys(store, ["left", "right"], { interpolation: "bezier", tangentMode: "fixed", inSlope: .2, outSlope: .3, inWeight: .25, outWeight: .4, broken: true });
    insertDrivenCurveKey(store, "sdk", .125);
    moveDrivenCurveKeys(store, ["right"], .125);
    const doc = store.getState().document;
    const packed = await encodeProject(doc, new Map(), { camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: .5 });
    const opened = await decodeProject(packed);
    expect(opened.scene.drivenKeys).toEqual(doc.drivenKeys);
    expect(opened.scene.animation).toEqual(doc.animation);
    expect(opened.scene.animation!.tracks).toHaveLength(1);
  });
});
