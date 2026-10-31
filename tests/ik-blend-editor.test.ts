import { describe, expect, it } from "vitest";
import { channelsForTarget, copyKeys, deleteKeys, evaluateSceneAnimation, moveKeys, pasteKeys, patchKeys, scaleKeys, setKeys } from "../src/animation.ts";
import { createController } from "../src/controller-curves.ts";
import { evaluateDrivenKeys, setDrivenKey, validateDrivenKeys, type DrivenProperty } from "../src/driven-keys.ts";
import { createIKHandle } from "../src/ik.ts";
import { emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture() {
  const store = createSceneStore({ ...emptyScene(), joints: [
    { id: "root", name: "Root", parentId: null, position: [0, 0, 0] },
    { id: "middle", name: "Middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "End", parentId: "middle", position: [0, 1, 0] },
  ] });
  const driver = createController(store, "circle"), driven = createController(store, "square");
  const handle = createIKHandle(store, "root", "end", [1, 1, 0]);
  return { store, driver, driven, handle };
}

describe("IK blend editor commands and SDK boundary", () => {
  it("supports Graph/Dope key editing, tangent metadata, retiming, and clipboard without changing pose tracks", () => {
    const { store, driver, handle } = fixture();
    setKeys(store, [driver], 0, undefined, ["position.x"]);
    const poseTrack = store.getState().document.animation!.tracks[0];
    expect(channelsForTarget(store.getState().document, handle)).toEqual(["ik.blend"]);
    setKeys(store, [handle], 0); setKeys(store, [handle], 10);
    let track = store.getState().document.animation!.tracks.find(item => item.targetId === handle)!;
    expect(track.channel).toBe("ik.blend");
    patchKeys(store, [track.keys[0].id], { value: .2, interpolation: "bezier", tangentMode: "fixed", inSlope: 0, outSlope: .15, outWeight: .4 });
    const ids = track.keys.map(key => key.id); moveKeys(store, ids, 3, 0); scaleKeys(store, ids, 2);
    track = store.getState().document.animation!.tracks.find(item => item.targetId === handle)!;
    expect(track.keys.map(key => key.time)).toEqual([3, 23]);
    const clipboard = copyKeys(store.getState().document, ids), pasted = pasteKeys(store, clipboard, 30);
    track = store.getState().document.animation!.tracks.find(item => item.targetId === handle)!;
    expect(track.keys.map(key => key.time)).toEqual([3, 23, 30, 50]);
    expect(track.keys[2]).toMatchObject({ value: .2, interpolation: "bezier", tangentMode: "fixed", outWeight: .4, outSlope: track.keys[0].outSlope });
    const beforeDelete = store.getState().document;
    deleteKeys(store, pasted); expect(store.getState().document.animation!.tracks.find(item => item.targetId === handle)!.keys).toHaveLength(2);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(beforeDelete);
    store.temporal.getState().redo(); expect(store.getState().document.animation!.tracks.find(item => item.targetId === driver)).toEqual(poseTrack);
    expect(store.getState().document.ikHandles![0].blend).toBe(1);
  });

  it("rejects mixed key edits outside blend bounds and incompatible clipboard destinations atomically", () => {
    const { store, driver, handle } = fixture();
    setKeys(store, [driver, handle], 0);
    const doc = store.getState().document, keys = doc.animation!.tracks.flatMap(track => track.keys.map(key => key.id));
    const blend = doc.animation!.tracks.find(track => track.channel === "ik.blend")!;
    const history = store.temporal.getState().pastStates.length;
    expect(() => moveKeys(store, keys, 2, .1)).toThrow(/blend/i);
    expect(() => pasteKeys(store, copyKeys(doc, blend.keys.map(key => key.id)), 10, driver)).toThrow();
    expect(() => setKeys(store, [driver], 5, undefined, ["ik.blend"])).toThrow(/not supported/);
    expect(store.getState().document).toBe(doc); expect(store.temporal.getState().pastStates).toHaveLength(history);
  });

  it.each(["driver", "driven"] as const)("rejects IK blend as an SDK %s on both objects and handles", side => {
    const { store, driver, driven, handle } = fixture();
    const before = store.getState().document, history = store.temporal.getState().pastStates.length;
    for (const targetId of [driver, handle]) {
      const bad = { targetId, channel: "ik.blend" } as unknown as DrivenProperty;
      const input: DrivenProperty = side === "driver" ? bad : { targetId: driver, channel: "position.x" };
      const output: DrivenProperty = side === "driven" ? bad : { targetId: driven, channel: "rotation.y" };
      expect(() => setDrivenKey(store, input, output, 0, .5)).toThrow(/pose channels only.*IK blend uses time keys/);
      expect(() => validateDrivenKeys([{ id: "bad-sdk", driver: input, driven: output, keys: [{ id: "bad-key", time: 0, value: .5, interpolation: "linear", tangentMode: "auto" }] }], before)).toThrow(/pose channels only/);
    }
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(history);
  });

  it("rejects pose properties on IK handles while preserving chained SDK beside time-keyed blend", () => {
    const { store, driver, driven, handle } = fixture();
    expect(() => setDrivenKey(store, { targetId: handle, channel: "position.x" }, { targetId: driven, channel: "rotation.y" }, 0, 1)).toThrow(/IK handle properties are not supported/);
    setKeys(store, [handle], 0);
    for (const [x, rotation] of [[0, 0], [2, 90]]) setDrivenKey(store, { targetId: driver, channel: "position.x" }, { targetId: driven, channel: "rotation.y" }, x, rotation);
    for (const [rotation, z] of [[0, 0], [90, 4]]) setDrivenKey(store, { targetId: driven, channel: "rotation.y" }, { targetId: "root", channel: "position.z" }, rotation, z);
    const doc = store.getState().document, poses = evaluateSceneAnimation(doc, 0);
    poses.set(driver, { ...poses.get(driver)!, position: [1, 0, 0] }); evaluateDrivenKeys(doc, poses);
    expect(poses.get(driven)!.rotation[1]).toBeCloseTo(45); expect(poses.get("root")!.position[2]).toBeCloseTo(2);
    expect(poses.has(handle)).toBe(false); expect(doc.animation!.tracks[0].targetId).toBe(handle);
  });
});
