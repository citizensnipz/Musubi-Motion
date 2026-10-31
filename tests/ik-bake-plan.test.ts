import { describe, expect, it } from "vitest";
import { defaultAnimation, POSE_ANIMATION_CHANNELS, type AnimationChannel, type AnimationTrack } from "../src/animation.ts";
import { planIKBake, type IKBakeSettings } from "../src/ik-bake-plan.ts";
import { emptyScene, type SceneDocument } from "../src/scene-document.ts";

function fixture(): SceneDocument {
  return { ...emptyScene(), joints: [
    { id: "root", name: "Root", parentId: null, position: [0, 0, 0] },
    { id: "middle", name: "Middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "End", parentId: "middle", position: [0, 1, 0] },
  ], ikHandles: [{ id: "ik", name: "Arm", rootId: "root", endId: "end", target: [1, 1, 0], enabled: true, blend: 1, iterations: 64 }] };
}
function settings(patch: Partial<IKBakeSettings> = {}): IKBakeSettings {
  return { start: 0, end: 2, step: 1, preserveOutsideKeys: true, minimizeRotation: true, ...patch };
}
function track(targetId: string, channel: AnimationChannel, times: number[]): AnimationTrack {
  const id = `${targetId}_${channel.replace(".", "_")}`;
  return { id, targetId, channel, keys: times.map((time, index) => ({ id: `${id}_${index}`, time, value: 0, interpolation: "linear", tangentMode: "auto" })) };
}
function addObject(doc: SceneDocument, id = "object") {
  doc.nodes[id] = { id, name: id, type: "transform", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
  doc.rootIds.push(id);
}

describe("IK bake samples", () => {
  it("includes the exact end after a shorter final interval and counts every chain rotation channel", () => {
    const doc = fixture(), options = settings({ start: -1.5, end: 1, step: 0.75 });
    expect(planIKBake(doc, "ik", options)).toEqual({ frames: [-1.5, -0.75, 0, 0.75, 1], chainIds: ["root", "middle", "end"], keysWritten: 45, resultKeyCount: 45 });
  });

  it("snaps endpoint roundoff without adding a nearly duplicate final sample", () => {
    expect(planIKBake(fixture(), "ik", settings({ end: 0.9, step: 0.3 })).frames).toEqual([0, 0.3, 0.6, 0.9]);
    expect(planIKBake(fixture(), "ik", settings({ start: 100_000, end: 100_000.9, step: 0.3 })).frames).toEqual([100_000, 100_000.3, 100_000.6, 100_000.9]);
  });

  it("does not collapse meaningful small steps at large offsets or tiny times", () => {
    const start = 999_999, step = 1e-9, end = start + 4.5e-9;
    const frames = planIKBake(fixture(), "ik", settings({ start, end, step })).frames;
    expect(frames).toEqual([start, start + step, start + 2 * step, start + 3 * step, start + 4 * step, end]);
    expect(frames.every((frame, index) => !index || frame > frames[index - 1])).toBe(true);
    const tiny = planIKBake(fixture(), "ik", settings({ start: 0, end: 3.5e-30, step: 1e-30 })).frames;
    expect(tiny).toEqual([0, 1e-30, 2e-30, 3.0000000000000003e-30, 3.5e-30]);
  });

  it("allows a single frame, out-of-playback-range bounds and a step larger than the interval", () => {
    const doc = fixture(); doc.animation = defaultAnimation();
    expect(planIKBake(doc, "ik", settings({ start: -12.5, end: -12.5 })).frames).toEqual([-12.5]);
    expect(planIKBake(doc, "ik", settings({ start: -1e6, end: 1e6, step: 1e6 })).frames).toEqual([-1e6, 0, 1e6]);
    expect(planIKBake(doc, "ik", settings({ start: 2, end: 3, step: Number.MAX_VALUE })).frames).toEqual([2, 3]);
  });

  it.each([
    { start: NaN }, { end: Infinity }, { start: -1e6 - 1 }, { end: 1e6 + 1 },
    { start: 3, end: 2 }, { step: 0 }, { step: -1 }, { step: Infinity }, { step: NaN },
    { preserveOutsideKeys: 1 }, { minimizeRotation: "yes" },
  ])("rejects invalid settings %j", patch => {
    expect(() => planIKBake(fixture(), "ik", settings(patch as Partial<IKBakeSettings>))).toThrow();
  });

  it("rejects a step that cannot advance representable frame time", () => {
    expect(() => planIKBake(fixture(), "ik", settings({ start: 999_999, end: 1e6, step: 1e-12 }))).toThrow(/smaller than frame precision/);
    // The first sample advances, but the next rounds back onto that sample.
    expect(() => planIKBake(fixture(), "ik", settings({ start: 999_999, end: 1e6, step: Number.EPSILON * 1e6 * 0.3 }))).toThrow(/smaller than frame precision/);
  });

  it("accepts exactly 10,001 samples and rejects any required extra endpoint", () => {
    const allowed = planIKBake(fixture(), "ik", settings({ end: 10_000 }));
    expect(allowed.frames).toHaveLength(10_001); expect(allowed.frames.at(-1)).toBe(10_000);
    expect(() => planIKBake(fixture(), "ik", settings({ end: 10_000.5 }))).toThrow(/10,001 samples/);
  });

  it("checks estimated whole-scene pose work independently of key count", () => {
    const doc = fixture();
    for (let index = 0; index < 197; index++) addObject(doc, `object_${index}`);
    expect(planIKBake(doc, "ik", settings({ end: 9999 })).frames).toHaveLength(10_000);
    addObject(doc, "one_more");
    expect(() => planIKBake(doc, "ik", settings({ end: 9999 }))).toThrow(/2,000,000 estimated pose evaluations/);
  });
});

describe("IK bake ownership and budgets", () => {
  it("keeps only outside rotation keys when requested and never removes unrelated channels or blend curves", () => {
    const doc = fixture();
    doc.animation = { ...defaultAnimation(), tracks: [
      track("root", "rotation.x", [-2, 0, 0.25, 1, 1.25, 2, 4]),
      track("end", "rotation.z", [-1, 2.5]), track("root", "position.x", [-5, 0, 1, 5]), track("ik", "ik.blend", [0, 1, 2]),
    ] };
    const preserved = planIKBake(doc, "ik", settings());
    expect(preserved.keysWritten).toBe(27);
    expect(preserved.resultKeyCount).toBe(27 + 4 + 4 + 3);
    expect(planIKBake(doc, "ik", settings({ preserveOutsideKeys: false })).resultKeyCount).toBe(27 + 4 + 3);
    expect(planIKBake(doc, "ik", settings({ minimizeRotation: false }))).toEqual(preserved);
  });

  it("counts final replacement keys rather than adding to the old whole-curve count", () => {
    const doc = fixture(), times = Array.from({ length: 100_000 }, (_, index) => index);
    doc.animation = { ...defaultAnimation(), tracks: [track("root", "rotation.x", times)] };
    expect(planIKBake(doc, "ik", settings({ start: 0, end: 0, preserveOutsideKeys: false })).resultKeyCount).toBe(9);
    expect(() => planIKBake(doc, "ik", settings({ start: 0, end: 0 }))).toThrow(/100,000 animation keys/);
    const unrelated = track("root", "position.x", times.slice(0, 99_991));
    doc.animation.tracks = [unrelated];
    expect(planIKBake(doc, "ik", settings({ end: 0 })).resultKeyCount).toBe(100_000);
    unrelated.keys.push({ ...unrelated.keys.at(-1)!, id: "extra", time: 99_991 });
    expect(() => planIKBake(doc, "ik", settings({ end: 0, preserveOutsideKeys: false }))).toThrow(/100,000 animation keys/);
  });

  it("budgets newly created tracks and reuses all existing chain rotation tracks", () => {
    const doc = fixture(), tracks: AnimationTrack[] = [];
    for (let index = 0; index < 10_000; index++) {
      const id = `object_${index}`; addObject(doc, id);
      for (const channel of POSE_ANIMATION_CHANNELS) tracks.push(track(id, channel, []));
    }
    doc.animation = { ...defaultAnimation(), tracks };
    expect(() => planIKBake(doc, "ik", settings({ end: 0 }))).toThrow(/100,000 animation tracks/);
    doc.animation.tracks = tracks.slice(0, 99_991);
    expect(planIKBake(doc, "ik", settings({ end: 0 })).resultKeyCount).toBe(9);
    for (const id of ["root", "middle", "end"]) for (const channel of ["rotation.x", "rotation.y", "rotation.z"] as const)
      doc.animation.tracks.push(track(id, channel, []));
    expect(doc.animation.tracks).toHaveLength(100_000);
    expect(planIKBake(doc, "ik", settings({ end: 0 })).resultKeyCount).toBe(9);
  });

  it("allows disabled and zero-blend handles and SDK drivers, but rejects SDK-owned rotation outputs", () => {
    const doc = fixture(); addObject(doc);
    Object.assign(doc.ikHandles![0], { enabled: false, blend: 0 });
    doc.drivenKeys = [{ id: "sdk", driver: { targetId: "root", channel: "rotation.x" }, driven: { targetId: "object", channel: "position.x" }, keys: track("object", "position.x", [0]).keys }];
    expect(planIKBake(doc, "ik", settings()).chainIds).toEqual(["root", "middle", "end"]);
    doc.drivenKeys = [{ ...doc.drivenKeys[0], driver: { targetId: "object", channel: "position.x" }, driven: { targetId: "end", channel: "rotation.z" } }];
    expect(() => planIKBake(doc, "ik", settings())).toThrow(/owned by Set Driven Keys/);
    doc.drivenKeys[0].driven = { targetId: "root", channel: "position.x" };
    expect(() => planIKBake(doc, "ik", settings())).not.toThrow();
  });

  it.each(["orient", "aim", "parent"] as const)("rejects active %s ownership on any chain joint but allows disabled constraints", type => {
    const doc = fixture(); addObject(doc);
    doc.constraints = [{ id: "constraint", name: "Rotation owner", type, sourceId: "object", targetId: "end", enabled: true, maintainOffset: false,
      offset: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }];
    expect(() => planIKBake(doc, "ik", settings())).toThrow(/active Orient, Aim or Parent/);
    doc.constraints[0].enabled = false;
    expect(() => planIKBake(doc, "ik", settings())).not.toThrow();
    doc.constraints[0] = { ...doc.constraints[0], type: "point", enabled: true };
    expect(() => planIKBake(doc, "ik", settings())).not.toThrow();
  });

  it("rejects missing handles and invalid chains without changing inputs, and returns independent arrays", () => {
    const doc = fixture(), options = settings(), before = JSON.stringify(doc), optionCopy = structuredClone(options);
    expect(() => planIKBake(doc, "missing", options)).toThrow(/existing IK handle/);
    const invalid = { ...doc, ikHandles: [{ ...doc.ikHandles![0], rootId: "end", endId: "root" }] };
    expect(() => planIKBake(invalid, "ik", options)).toThrow(/descendant/);
    const planned = planIKBake(doc, "ik", options); planned.frames.push(99); planned.chainIds.pop();
    expect(planIKBake(doc, "ik", options).frames).toEqual([0, 1, 2]);
    expect(planIKBake(doc, "ik", options).chainIds).toEqual(["root", "middle", "end"]);
    expect(JSON.stringify(doc)).toBe(before); expect(options).toEqual(optionCopy);
  });
});
