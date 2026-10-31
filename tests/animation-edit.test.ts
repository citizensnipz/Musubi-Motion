import { describe, expect, it } from "vitest";
import { mergeJointPose, prepareJointAnimationEdit, unwrapEuler } from "../src/animation-edit.ts";
import { defaultAnimation, evaluateChannels, type AnimationPose, type CurveKey } from "../src/animation.ts";
import { emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import type { Joint } from "../src/skeleton.ts";
import { Euler, MathUtils, Quaternion } from "three";

const before: Joint = { id: "joint", name: "joint", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0] };
const displayed = (): AnimationPose => ({ position: [5, 2, 3], rotation: [0, 350, 0], scale: [1, 1, 1], visibility: 0 });
const key = (id: string, time: number, value: number): CurveKey => ({ id, time, value, interpolation: "linear", tangentMode: "auto" });

describe("animation edit preparation", () => {
  it("unwraps gizmo angles to the nearest displayed revolution", () => {
    expect(unwrapEuler([10, -170, 0], [350, 170, 720])).toEqual([370, 190, 720]);
    expect(unwrapEuler([350, 170, -10], [10, -170, -350])).toEqual([-10, -190, -370]);
    expect(() => unwrapEuler([NaN, 0, 0], [0, 0, 0])).toThrow(/finite/);
  });

  it("chooses the nearest equivalent XYZ branch when quaternion extraction folds the Y angle", () => {
    expect(unwrapEuler([-180, 70, -180], [0, 100, 0])).toEqual([0, 110, 0]);
    const folded: [number, number, number] = [-160, 70, -150];
    const continuous = unwrapEuler(folded, [20, 100, 30]);
    expect(continuous).toEqual([20, 110, 30]);
    const quaternion = (angles: number[]) => new Quaternion().setFromEuler(new Euler(...angles.map(MathUtils.degToRad) as [number, number, number], "XYZ"));
    expect(Math.abs(quaternion(folded).dot(quaternion(continuous)))).toBeCloseTo(1, 10);
  });

  it("preserves animated translation and visibility during rotation-only FK edits", () => {
    const current = displayed();
    const after: Joint = { ...before, rotation: [0, 10, 0] };
    const result = mergeJointPose(before, after, current, "rotation", true);
    expect(result).toEqual({ ...current, rotation: [0, 370, 0] });
    expect(current).toEqual(displayed());
    expect(after.rotation).toEqual([0, 10, 0]);
  });

  it("merges a legacy position field into the evaluated pose without resetting other animated axes", () => {
    expect(mergeJointPose(before, { ...before, position: [4, 0, 0] }, displayed(), "position"))
      .toEqual({ ...displayed(), position: [4, 2, 3] });
  });

  it("keeps intentional numeric full spins instead of unwrapping them", () => {
    const after: Joint = { ...before, position: [5, 2, 3], rotation: [720, -1080, 0] };
    expect(mergeJointPose(before, after, displayed(), "transform").rotation).toEqual([720, -1080, 0]);
    const doc = { ...emptyScene(), joints: [before] };
    const result = prepareJointAnimationEdit(doc, [after], "Transform joint", 0, false, displayed);
    expect(result.document.joints![0].rotation).toEqual([720, -1080, 0]);
    expect(result.overrides.get("joint")!.rotation).toEqual([720, -1080, 0]);
  });

  it("prepares rotation and auto keys together without keying unchanged animated translation", () => {
    const doc = { ...emptyScene(), joints: [before], animation: { ...defaultAnimation(), tracks: [
      { id: "position-track", targetId: "joint", channel: "position.x" as const, keys: [key("p0", 0, 0), key("p10", 10, 10)] },
      { id: "rotation-track", targetId: "joint", channel: "rotation.y" as const, keys: [key("r0", 0, 300), key("r10", 10, 400)] },
    ] } };
    const current = (id: string) => evaluateChannels(doc, id, 5);
    const result = prepareJointAnimationEdit(doc, [{ ...before, rotation: [0, 10, 0] }], "Rotate selected joints", 5, true, current);
    expect(result.overrides.get("joint")!.position).toEqual([5, 0, 0]);
    expect(result.document.joints![0].position).toEqual([0, 0, 0]);
    expect(result.document.joints![0].rotation).toEqual([0, 370, 0]);
    expect(result.document.animation!.tracks[0]).toBe(doc.animation.tracks[0]);
    expect(result.document.animation!.tracks[1].keys).toHaveLength(3);
    expect(evaluateChannels(result.document, "joint", 5).rotation[1]).toBe(370);
    const store = createSceneStore(doc);
    store.setState({ document: result.document, editLabel: "Rotate selected joints" });
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(result.document);
  });

  it("does not create animation tracks for unkeyed joints or pose overrides for hierarchy edits", () => {
    const doc = { ...emptyScene(), joints: [before] };
    const after: Joint = { ...before, rotation: [0, 10, 0] };
    const auto = prepareJointAnimationEdit(doc, [after], "Rotate selected joints", 5, true, displayed);
    expect(auto.document.animation).toBeUndefined();
    const hierarchy = prepareJointAnimationEdit(doc, [{ ...before, name: "renamed" }], "Rename joint", 5, true, displayed);
    expect(hierarchy.overrides.size).toBe(0); expect(hierarchy.document.animation).toBeUndefined();
    expect(hierarchy.document.joints![0].name).toBe("renamed");
  });
});
