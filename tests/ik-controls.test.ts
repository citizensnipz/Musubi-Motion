import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { evaluateSceneAnimation, setKeys, type AnimationPose } from "../src/animation.ts";
import { createConstraint } from "../src/constraints.ts";
import { findControllerShape } from "../src/controller-curves.ts";
import { evaluateDrivenKeys, setDrivenKey } from "../src/driven-keys.ts";
import { createIKHandle, defaultPoleTarget, evaluateRigStages, getIKTargetPoints, updateIKHandle } from "../src/ik.ts";
import { createIKControl, matchIKControlsToFKAndKey, setIKControl } from "../src/ik-controls.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { emptyScene, type SceneDocument, type TransformNode, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function transform(id: string, position: Vec3 = [0, 0, 0], parentId: string | null = null): TransformNode {
  return { id, name: id, type: "transform", parentId, position, rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
}
function fixture(nodes: TransformNode[] = [transform("control", [3, 4, 0]), transform("source", [5, 2, 1])]) {
  const doc: SceneDocument = { ...emptyScene(), nodes: Object.fromEntries(nodes.map(node => [node.id, node])), joints: [
    { id: "root", name: "root", parentId: null, position: [0, 0, 0] },
    { id: "middle", name: "middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "end", parentId: "middle", position: [0, 1, 0] },
  ] };
  const store = createSceneStore(doc), id = createIKHandle(store, "root", "end", [1, 1, 0], { solver: "two-bone", poleTarget: [0, 1, 2] });
  return { store, id };
}
function poses(doc: SceneDocument, frame = 0, fk = false): Map<string, AnimationPose> {
  const result = evaluateSceneAnimation(doc, frame); evaluateDrivenKeys(doc, result);
  const stages = evaluateRigStages(doc, result, fk); return fk ? stages.fkPoses! : result;
}
function points(doc: SceneDocument, frame = 0) { return getIKTargetPoints(doc, poses(doc, frame)).get(doc.ikHandles![0].id)!; }
function close(actual: Vec3, expected: Vec3) { expect(new Vector3(...actual).distanceTo(new Vector3(...expected))).toBeLessThan(1e-7); }

describe("IK control commands", () => {
  it("binds with or without world offsets and unlink freezes the supplied current pose", () => {
    const { store, id } = fixture();
    setIKControl(store, id, "target", "control", true);
    expect(store.getState().document.ikHandles![0].targetControl).toEqual({ objectId: "control", offset: [-2, -3, 0] });
    close(points(store.getState().document).target, [1, 1, 0]);
    setIKControl(store, id, "target", "control", false);
    close(points(store.getState().document).target, [3, 4, 0]);
    const current = poses(store.getState().document); current.set("control", { ...current.get("control")!, position: [7, 8, 9] });
    const snapshot = structuredClone(current), before = store.getState().document;
    setIKControl(store, id, "target", undefined, false, current);
    expect(store.getState().document.ikHandles![0].targetControl).toBeUndefined();
    expect(store.getState().document.ikHandles![0].target).toEqual([7, 8, 9]);
    expect(current).toEqual(snapshot);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(points(store.getState().document).target).toEqual([7, 8, 9]);
  });

  it("uses final constrained control positions for default binding and unlinking", () => {
    const { store, id } = fixture(); createConstraint(store, "point", "source", "control", false);
    setIKControl(store, id, "target", "control", true);
    expect(store.getState().document.ikHandles![0].targetControl!.offset).toEqual([-4, -1, -1]);
    close(points(store.getState().document).target, [1, 1, 0]);
    setIKControl(store, id, "target", "control", false);
    setIKControl(store, id, "target", undefined, false);
    expect(store.getState().document.ikHandles![0].target).toEqual([5, 2, 1]);
  });

  it("refreshes literal fallbacks when rebinding or creating after an animated control move", () => {
    const { store, id } = fixture(); setIKControl(store, id, "target", "control", false);
    const keyed = poses(store.getState().document); keyed.set("control", { ...keyed.get("control")!, position: [7, 8, 9] });
    setKeys(store, ["control"], 12, keyed, ["position.x", "position.y", "position.z"]);
    setIKControl(store, id, "target", "source", true, poses(store.getState().document, 12));
    expect(store.getState().document.ikHandles![0]).toMatchObject({ target: [7, 8, 9], targetControl: { objectId: "source", offset: [2, 6, 8] } });
    setIKControl(store, id, "target", "control", false, poses(store.getState().document, 12));
    expect(store.getState().document.ikHandles![0].target).toEqual([7, 8, 9]);
    const moved = poses(store.getState().document, 12); moved.set("control", { ...moved.get("control")!, position: [8, 9, 10] });
    createIKControl(store, id, "target", moved);
    expect(store.getState().document.ikHandles![0].target).toEqual([8, 9, 10]);
  });

  it("creates editable circle and arrow controls and links each with exactly one undo", () => {
    const { store, id } = fixture();
    for (const kind of ["target", "pole"] as const) {
      const before = store.getState().document, history = store.temporal.getState().pastStates.length;
      const expected = kind === "target" ? points(before).target : points(before).poleTarget!;
      const control = createIKControl(store, id, kind), after = store.getState().document;
      expect(after.nodes[control]).toMatchObject({ type: "transform", position: expected, parentId: null });
      expect(findControllerShape(after, control)?.degree).toBe(kind === "target" ? 2 : 1);
      expect(after.ikHandles![0][kind === "target" ? "targetControl" : "poleControl"]).toEqual({ objectId: control, offset: [0, 0, 0] });
      expect(store.temporal.getState().pastStates).toHaveLength(history + 1);
      store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
      store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
    }
  });

  it("keys local positions through a rotated scaled parent at the exact fractional frame", () => {
    const parent = { ...transform("parent", [3, 0, 0]), rotation: [0, 0, 90] as Vec3, scale: [2, 2, 2] as Vec3 };
    const { store, id } = fixture([parent, transform("control", [0, 0, 0], "parent")]);
    setIKControl(store, id, "target", "control", false);
    const before = store.getState().document, history = store.temporal.getState().pastStates.length;
    matchIKControlsToFKAndKey(store, id, 12.5);
    const after = store.getState().document, animation = after.animation!;
    expect(animation.tracks).toHaveLength(3);
    expect(animation.tracks.every(track => track.targetId === "control" && track.keys[0].time === 12.5)).toBe(true);
    close(evaluateSceneAnimation(after, 12.5).get("control")!.position, [1, 1.5, 0]);
    close(points(after, 12.5).target, [0, 2, 0]);
    expect(after.nodes.control).toBe(before.nodes.control);
    expect(after.joints).toBe(before.joints);
    expect(after.ikHandles![0].target).toEqual(before.ikHandles![0].target);
    expect(store.temporal.getState().pastStates).toHaveLength(history + 1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
    const again = store.getState().document;
    matchIKControlsToFKAndKey(store, id, 12.5); expect(store.getState().document).toBe(again);
  });

  it("retains offsets and updates an unlinked pole in the same transaction", () => {
    const { store, id } = fixture(); setIKControl(store, id, "target", "control", true);
    const before = store.getState().document, expectedPole = defaultPoleTarget(before, "root", "end", poses(before, 0, true));
    matchIKControlsToFKAndKey(store, id, 5);
    const after = store.getState().document;
    expect(after.ikHandles![0].targetControl).toEqual(before.ikHandles![0].targetControl);
    close(evaluateSceneAnimation(after, 5).get("control")!.position, [2, 5, 0]);
    close(points(after, 5).target, [0, 2, 0]); close(after.ikHandles![0].poleTarget!, expectedPole);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
  });

  it("permits large composed world origins when local keys, offsets, and resolved targets remain valid", () => {
    const setup = fixture([transform("parent", [1e6, 0, 0]), transform("control", [1e6, 0, 0], "parent")]);
    const doc = setup.store.getState().document, store = createSceneStore({ ...doc,
      joints: doc.joints!.map(joint => joint.id === "root" ? { ...joint, position: [1e6, 0, 0] as Vec3 } : joint),
      ikHandles: doc.ikHandles!.map(handle => ({ ...handle, solver: "ccd" as const, target: [1e6, 1, 0] as Vec3 })),
    });
    setIKControl(store, setup.id, "target", "control", true);
    expect(store.getState().document.ikHandles![0].targetControl!.offset).toEqual([-1e6, 1, 0]);
    matchIKControlsToFKAndKey(store, setup.id, 1);
    close(evaluateSceneAnimation(store.getState().document, 1).get("control")!.position, [1e6, 1, 0]);
    close(points(store.getState().document, 1).target, [1e6, 2, 0]);
  });

  it("matches parent and child controls against their jointly updated positions", () => {
    const { store, id } = fixture([transform("control", [3, 4, 0]), transform("pole", [1, 2, 3], "control")]);
    setIKControl(store, id, "target", "control", false); setIKControl(store, id, "pole", "pole", false);
    const before = store.getState().document, expectedPole = defaultPoleTarget(before, "root", "end", poses(before, 0, true));
    matchIKControlsToFKAndKey(store, id, 6);
    const after = store.getState().document;
    expect(after.animation!.tracks).toHaveLength(6);
    close(points(after, 6).target, [0, 2, 0]); close(points(after, 6).poleTarget!, expectedPole);
    close(evaluateSceneAnimation(after, 6).get("pole")!.position, [expectedPole[0], expectedPole[1] - 2, expectedPole[2]]);
  });

  it("rejects incompatible shared control requests but accepts compatible offsets", () => {
    const { store, id } = fixture();
    setIKControl(store, id, "target", "control", false); setIKControl(store, id, "pole", "control", false);
    const before = store.getState().document, history = store.temporal.getState().pastStates.length;
    expect(() => matchIKControlsToFKAndKey(store, id, 4)).toThrow(/same control.*incompatible/i);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(history);
    const expectedPole = defaultPoleTarget(before, "root", "end", poses(before, 0, true));
    updateIKHandle(store, id, { poleControl: { objectId: "control", offset: [expectedPole[0], expectedPole[1] - 2, expectedPole[2]] } });
    matchIKControlsToFKAndKey(store, id, 4);
    const after = store.getState().document;
    expect(after.animation!.tracks).toHaveLength(3); close(points(after, 4).target, [0, 2, 0]); close(points(after, 4).poleTarget!, expectedPole);
  });

  it.each(["SDK", "point", "parent"] as const)("rejects %s position ownership without touching keys or history", owner => {
    const { store, id } = fixture();
    if (owner === "SDK") setDrivenKey(store, { targetId: "source", channel: "position.x" }, { targetId: "control", channel: "position.x" }, 0, 3);
    else createConstraint(store, owner, "source", "control", true);
    setIKControl(store, id, "target", "control", true);
    const before = store.getState().document, history = store.temporal.getState().pastStates.length;
    expect(() => matchIKControlsToFKAndKey(store, id, 10)).toThrow(/owned by/);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(history);
  });

  it("rejects a stale unkeyed parent preview before committing a partial match", () => {
    const { store, id } = fixture([transform("parent"), transform("control", [1, 1, 0], "parent")]);
    setIKControl(store, id, "target", "control", false);
    const before = store.getState().document, preview = poses(before, 0, true);
    preview.set("parent", { ...preview.get("parent")!, position: [5, 0, 0] });
    expect(() => matchIKControlsToFKAndKey(store, id, 0, preview)).toThrow(/unkeyed parent preview/);
    expect(store.getState().document).toBe(before);
  });

  it.each(["position.x", "rotation.y"] as const)("rejects downstream SDK changing FK %s even when the control reaches its requested point", channel => {
    const { store, id } = fixture([transform("control", [1, 1, 0])]);
    const driver = { targetId: "control", channel: "position.x" as const }, driven = { targetId: "root", channel };
    setDrivenKey(store, driver, driven, 0, 0); setDrivenKey(store, driver, driven, 2, channel === "position.x" ? 4 : 90);
    setIKControl(store, id, "target", "control", false);
    const before = store.getState().document, history = store.temporal.getState().pastStates.length;
    expect(() => matchIKControlsToFKAndKey(store, id, 0)).toThrow(/change the prepared FK chain.*Set Driven Key/);
    expect(store.getState().document).toBe(before); expect(store.getState().document.animation).toBeUndefined();
    expect(store.temporal.getState().pastStates).toHaveLength(history);
  });

  it("allows downstream SDK when its response leaves the prepared FK chain unchanged", () => {
    const { store, id } = fixture([transform("control", [1, 1, 0]), transform("source")]);
    const driver = { targetId: "control", channel: "position.x" as const };
    for (const value of [0, 2]) setDrivenKey(store, driver, { targetId: "root", channel: "position.x" }, value, 3);
    setDrivenKey(store, driver, { targetId: "source", channel: "rotation.y" }, 0, 0);
    setDrivenKey(store, driver, { targetId: "source", channel: "rotation.y" }, 4, 90);
    setIKControl(store, id, "target", "control", false);
    matchIKControlsToFKAndKey(store, id, 0);
    const after = store.getState().document;
    expect(after.animation!.tracks).toHaveLength(3); close(points(after).target, [3, 2, 0]);
    expect(poses(after, 0, true).get("root")!.position[0]).toBe(3);
    expect(poses(after, 0, true).get("source")!.rotation[1]).toBeCloseTo(67.5);
  });

  it("rejects invalid binding, noninvertible transforms, and invalid frames atomically", () => {
    const { store, id } = fixture(), before = store.getState().document, history = store.temporal.getState().pastStates.length;
    expect(() => setIKControl(store, id, "target", "missing", true)).toThrow(/transform/);
    expect(() => createIKControl(store, "missing", "target")).toThrow(/existing IK/);
    const zero = poses(before); zero.set("control", { ...zero.get("control")!, scale: [0, 1, 1] });
    expect(() => setIKControl(store, id, "target", "control", true, zero)).toThrow(/invertible/);
    for (const frame of [NaN, Infinity, 1e6 + 1]) expect(() => matchIKControlsToFKAndKey(store, id, frame)).toThrow(/frame/);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(history);
  });

  it("round-trips linked curve controls, offsets, and position keys in a native archive", async () => {
    const { store, id } = fixture([]); createIKControl(store, id, "target"); createIKControl(store, id, "pole");
    matchIKControlsToFKAndKey(store, id, 7);
    const doc = store.getState().document, bytes = await encodeProject(doc, new Map(), {
      camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 7,
    });
    const reopened = (await decodeProject(bytes)).scene;
    expect(reopened.ikHandles).toEqual(doc.ikHandles); expect(reopened.animation).toEqual(doc.animation);
    expect(findControllerShape(reopened, doc.ikHandles![0].targetControl!.objectId)).toEqual(findControllerShape(doc, doc.ikHandles![0].targetControl!.objectId));
    close(points(reopened, 7).target, [0, 2, 0]); close(points(reopened, 7).poleTarget!, points(doc, 7).poleTarget!);
  });
});
