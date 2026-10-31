import { describe, expect, it } from "vitest";
import { defaultAnimation, evaluateSceneAnimation, upsertTrack, type AnimationTrack, type CurveKey } from "../src/animation.ts";
import { constraintWorldMatrices, createConstraint } from "../src/constraints.ts";
import { createController } from "../src/controller-curves.ts";
import { evaluateDrivenKeys, setDrivenKey } from "../src/driven-keys.ts";
import { evaluateRigStages } from "../src/ik.ts";
import { bakeIKToFK, type IKBakeProgress, type IKBakeSettings } from "../src/ik-bake.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { emptyScene, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

const key = (id: string, time: number, value: number): CurveKey => ({ id, time, value, interpolation: "linear", tangentMode: "auto" });
const settings = (patch: Partial<IKBakeSettings> = {}): IKBakeSettings => ({ start: 0, end: 4, step: 1, preserveOutsideKeys: true, minimizeRotation: true, ...patch });
function fixture(animated = true) {
  const doc: SceneDocument = { ...emptyScene(), joints: [
    { id: "root", name: "Root", parentId: null, position: [0, 0, 0] },
    { id: "middle", name: "Middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "End", parentId: "middle", position: [0, 1, 0], rotation: [0, 0, 20] },
  ], ikHandles: [{ id: "ik", name: "Arm", rootId: "root", endId: "end", target: [1, 1, 0],
    poleTarget: [0, 0, 3], solver: "two-bone", enabled: true, blend: 1, iterations: 64 }],
    ...(animated ? { animation: { ...defaultAnimation(), tracks: [{ id: "blend", targetId: "ik", channel: "ik.blend", keys: [key("blend0", 0, 0), key("blend4", 4, 1)] }] } } : {}),
  };
  return createSceneStore(doc);
}
function evaluated(doc: SceneDocument, frame: number) {
  const poses = evaluateSceneAnimation(doc, frame); evaluateDrivenKeys(doc, poses);
  evaluateRigStages(doc, poses, false, frame); return poses;
}
function expectWorlds(before: SceneDocument, after: SceneDocument, frames: number[]) {
  for (const frame of frames) {
    const a = constraintWorldMatrices(before, evaluated(before, frame)), b = constraintWorldMatrices(after, evaluated(after, frame));
    for (const [id, matrix] of a) matrix.elements.forEach((value, index) => expect(b.get(id)!.elements[index]).toBeCloseTo(value, 7));
  }
}

describe("atomic sampled IK-to-FK bake", () => {
  it("bakes mixed blend samples into linear rotation keys and disables the handle in one undo step", async () => {
    const store = fixture(), original = store.getState().document, snapshot = JSON.stringify(original), events: IKBakeProgress[] = [];
    const result = await bakeIKToFK(store, "ik", settings(), { onProgress: progress => events.push(progress) });
    const baked = store.getState().document;
    expect(result).toEqual({ samples: 5, keysWritten: 45, start: 0, end: 4 });
    expect(baked.ikHandles![0]).toEqual({ ...original.ikHandles![0], enabled: false });
    expect(baked.animation!.tracks[0]).toBe(original.animation!.tracks[0]);
    const rotations = baked.animation!.tracks.filter(track => track.channel.startsWith("rotation."));
    expect(rotations).toHaveLength(9);
    for (const track of rotations) {
      expect(track.keys.map(key => key.time)).toEqual([0, 1, 2, 3, 4]);
      expect(track.keys.every(key => key.interpolation === "linear")).toBe(true);
    }
    expectWorlds(original, baked, [0, 1, 2, 3, 4]);
    expect(JSON.stringify(original)).toBe(snapshot);
    for (const phase of ["sampling", "verifying"]) expect(events.filter(event => event.phase === phase).map(event => event.completed)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(original);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(baked);
  });

  it("includes an exact fractional end when the sampling step does not divide the range", async () => {
    const store = fixture(), before = store.getState().document;
    const result = await bakeIKToFK(store, "ik", settings({ start: .25, end: 2, step: .6 }));
    expect(result).toEqual({ samples: 4, keysWritten: 36, start: .25, end: 2 });
    const times = store.getState().document.animation!.tracks.find(track => track.channel === "rotation.x")!.keys.map(key => key.time);
    expect(times).toEqual([.25, .85, 1.45, 2]); expectWorlds(before, store.getState().document, times);
  });

  it("keeps exact outside key records and reuses IDs at matching sampled times", async () => {
    const store = fixture(), outside: CurveKey = { ...key("outside", -2, 700), interpolation: "bezier", tangentMode: "fixed", inSlope: .2, outSlope: .4, inWeight: .1, outWeight: .6, broken: true };
    upsertTrack(store, { id: "turns", targetId: "root", channel: "rotation.z", keys: [outside, key("at0", 0, 720), key("at1", 1, 725), key("at2", 2, 730), key("after", 5, 740)] });
    const before = store.getState().document, old = before.animation!.tracks.find(track => track.id === "turns")!;
    await bakeIKToFK(store, "ik", settings({ start: .5, end: 1.5, step: .5 }));
    const track = store.getState().document.animation!.tracks.find(track => track.id === "turns")!;
    for (const time of [-2, 0, 2, 5]) expect(track.keys.find(key => key.time === time)).toBe(old.keys.find(key => key.time === time));
    expect(track.keys.find(key => key.time === 1)!.id).toBe("at1");
    expect(track.keys.find(key => key.time === 1)!.interpolation).toBe("linear");
    expect(track.keys.find(key => key.time === .5)!.value).toBeGreaterThan(600);
    expectWorlds(before, store.getState().document, [.5, 1, 1.5]);
  });

  it("removes outside chain-rotation keys only when requested and retains unrelated tracks", async () => {
    const store = fixture();
    upsertTrack(store, { id: "rotation", targetId: "root", channel: "rotation.y", keys: [key("past", -10, 0), key("future", 10, 20)] });
    upsertTrack(store, { id: "position", targetId: "end", channel: "position.y", keys: [key("length", -10, 1)] });
    const before = store.getState().document, unrelated = before.animation!.tracks.find(track => track.id === "position");
    await bakeIKToFK(store, "ik", settings({ start: 1, end: 2, preserveOutsideKeys: false }));
    const after = store.getState().document;
    expect(after.animation!.tracks.find(track => track.id === "position")).toBe(unrelated);
    expect(after.animation!.tracks.find(track => track.id === "rotation")!.keys.map(key => key.time)).toEqual([1, 2]);
    expectWorlds(before, after, [1, 2]);
  });

  it("anchors minimized Euler rotations to prepared FK and keeps successive samples continuous", async () => {
    const store = fixture(false);
    upsertTrack(store, { id: "full-turn", targetId: "root", channel: "rotation.z", keys: [key("spin0", 0, 720), key("spin4", 4, 740)] });
    const before = store.getState().document;
    await bakeIKToFK(store, "ik", settings());
    const rotation = store.getState().document.animation!.tracks.find(track => track.id === "full-turn")!;
    expect(rotation.keys[0].value).toBeGreaterThan(540);
    rotation.keys.slice(1).forEach((key, index) => expect(Math.abs(key.value - rotation.keys[index].value)).toBeLessThanOrEqual(180));
    expectWorlds(before, store.getState().document, [0, 1, 2, 3, 4]);
  });

  it("writes raw evaluator Euler output when rotation minimization is disabled", async () => {
    const store = fixture(false);
    upsertTrack(store, { id: "turn", targetId: "root", channel: "rotation.z", keys: [key("turn0", 0, 720)] });
    const original = store.getState().document, expected = evaluated(original, 0).get("root")!.rotation[2];
    await bakeIKToFK(store, "ik", settings({ start: 0, end: 0, minimizeRotation: false }));
    const actual = store.getState().document.animation!.tracks.find(track => track.id === "turn")!.keys[0].value;
    expect(actual).toBe(expected); expect(Math.abs(actual)).toBeLessThanOrEqual(180);
  });

  it.each(["position.x", "visibility"] as const)("rejects downstream SDK %s changes despite equivalent baked chain worlds", async channel => {
    const store = fixture(false), watcher = createController(store, "circle");
    const rotation = evaluated(store.getState().document, 0).get("root")!.rotation;
    const axis = rotation.findIndex(value => Math.abs(value) > 1), driver = { targetId: "root", channel: `rotation.${"xyz"[axis]}` as "rotation.x" | "rotation.y" | "rotation.z" };
    setDrivenKey(store, driver, { targetId: watcher, channel }, 0, 0);
    setDrivenKey(store, driver, { targetId: watcher, channel }, rotation[axis] / 2, channel === "visibility" ? 1 : 5);
    const before = store.getState().document, count = store.temporal.getState().pastStates.length;
    await expect(bakeIKToFK(store, "ik", settings())).rejects.toThrow(/driven-key or constraint dependencies/);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(count);
  });

  it("cancels before starting and after the final verification callback without committing", async () => {
    for (const preAborted of [true, false]) {
      const store = fixture(), original = store.getState().document, abort = new AbortController();
      if (preAborted) abort.abort();
      await expect(bakeIKToFK(store, "ik", settings(), { signal: abort.signal, onProgress: progress => {
        if (progress.phase === "verifying" && progress.completed === progress.total) abort.abort();
      } })).rejects.toMatchObject({ name: "AbortError" });
      expect(store.getState().document).toBe(original); expect(store.temporal.getState().pastStates).toHaveLength(0);
    }
  });

  it("checks cancellation after yielding between chunks", async () => {
    const store = fixture(), original = store.getState().document, abort = new AbortController(); let yields = 0;
    await expect(bakeIKToFK(store, "ik", settings({ end: 64 }), { signal: abort.signal, yieldTask: async () => { yields++; abort.abort(); } })).rejects.toMatchObject({ name: "AbortError" });
    expect(yields).toBeGreaterThan(0); expect(store.getState().document).toBe(original); expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("rejects a stale document changed by a progress callback while retaining that external edit", async () => {
    const store = fixture(), original = store.getState().document, changed = { ...original, rootIds: [...original.rootIds] };
    await expect(bakeIKToFK(store, "ik", settings(), { onProgress: progress => {
      if (progress.phase === "sampling" && progress.completed === 1) store.setState({ document: changed, editLabel: "Concurrent edit" });
    } })).rejects.toThrow(/scene changed/);
    expect(store.getState().document).toBe(changed); expect(store.temporal.getState().pastStates).toHaveLength(1);
    expect(store.getState().document.ikHandles![0].enabled).toBe(true);
  });

  it("rejects invalid settings and rotation ownership before any history mutation", async () => {
    const store = fixture(), before = store.getState().document;
    for (const options of [settings({ step: 0 }), settings({ end: -1 }), settings({ start: NaN }), settings({ end: 10001, step: 1 })]) await expect(bakeIKToFK(store, "ik", options)).rejects.toThrow();
    await expect(bakeIKToFK(store, "missing", settings())).rejects.toThrow();
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(0);
    const controller = createController(store, "circle"); createConstraint(store, "orient", controller, "root", false);
    const constrained = store.getState().document, count = store.temporal.getState().pastStates.length;
    await expect(bakeIKToFK(store, "ik", settings())).rejects.toThrow(/rotation constraint|orient|ownership/i);
    expect(store.getState().document).toBe(constrained); expect(store.temporal.getState().pastStates).toHaveLength(count);
  });

  it("supports disabled or fully FK handles and leaves authored turns intact in raw mode", async () => {
    const store = fixture(false), doc = store.getState().document;
    store.setState({ document: { ...doc, ikHandles: [{ ...doc.ikHandles![0], enabled: false }] } });
    upsertTrack(store, { id: "turns", targetId: "root", channel: "rotation.z", keys: [key("turn0", 0, 720), key("turn4", 4, 800)] });
    const before = store.getState().document;
    await bakeIKToFK(store, "ik", settings({ minimizeRotation: false }));
    const track = store.getState().document.animation!.tracks.find(track => track.id === "turns")!;
    expect(track.keys.map(key => key.value)).toEqual([720, 740, 760, 780, 800]);
    expectWorlds(before, store.getState().document, [0, 1, 2, 3, 4]);
  });

  it("preserves sampled poses without claiming fidelity between samples across a source discontinuity", async () => {
    const store = fixture(false), doc = store.getState().document;
    store.setState({ document: { ...doc, ikHandles: [{ ...doc.ikHandles![0], enabled: false }] } });
    upsertTrack(store, { id: "stepped-turn", targetId: "root", channel: "rotation.z", keys: [
      { ...key("step0", 0, 0), interpolation: "step" }, key("step1", 1, 90),
    ] });
    const before = store.getState().document;
    await bakeIKToFK(store, "ik", settings({ start: 0, end: 1 }));
    const after = store.getState().document;
    expectWorlds(before, after, [0, 1]);
    const source = constraintWorldMatrices(before, evaluated(before, .5)).get("end")!;
    const baked = constraintWorldMatrices(after, evaluated(after, .5)).get("end")!;
    expect(Math.abs(source.elements[12] - baked.elements[12])).toBeGreaterThan(1);
    expect(after.animation!.tracks.find(track => track.id === "stepped-turn")!.keys.every(key => key.interpolation === "linear")).toBe(true);
  });

  it("persists baked samples, disabled handle and untouched blend curve through archive readback", async () => {
    const store = fixture(); await bakeIKToFK(store, "ik", settings());
    const baked = store.getState().document;
    const opened = await decodeProject(await encodeProject(baked, new Map(), { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: .01, far: 1000 }, time: 0 }));
    expect(opened.scene.animation).toEqual(baked.animation); expect(opened.scene.ikHandles).toEqual(baked.ikHandles);
    expectWorlds(baked, opened.scene, [0, 1, 2, 3, 4]);
  });
});
