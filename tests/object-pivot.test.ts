import { expect, it } from "vitest";
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import { objectLocalMatrix, objectGeometryPosition, objectPivotPosition, channelsFromPivotProxy, relocateObjectPivot } from "../src/object-pivot.ts";
import { defaultAnimation, evaluateSceneAnimation } from "../src/animation.ts";
import { constraintWorldMatrices, createConstraint, evaluateConstraints } from "../src/constraints.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { emptyScene, type TransformNode, type TransformChannels, type Vec3 } from "../src/scene-document.ts";

function node(id = "object"): TransformNode {
  return { id, type: "transform", name: id, parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
}
function nearMatrix(actual: Matrix4, expected: Matrix4) { actual.elements.forEach((v, i) => expect(v).toBeCloseTo(expected.elements[i], 9)); }
function q(rotation: Vec3) { return new Quaternion().setFromEuler(new Euler(...rotation.map(MathUtils.degToRad) as Vec3)); }

it("retains legacy TRS matrices when pivot metadata is absent", () => {
  const object = { ...node(), position: [4, 2, 3] as Vec3, rotation: [20, 45, 90] as Vec3, scale: [2, 3, 4] as Vec3 };
  nearMatrix(objectLocalMatrix(object, object), new Matrix4().compose(new Vector3(...object.position), q(object.rotation), new Vector3(...object.scale)));
});

it("relocates an evaluated pivot without moving geometry or descendants under a transformed parent", () => {
  const object = { ...node(), pivot: [1, 2, 3] as Vec3, pivotCompensation: [2, 0, -1] as Vec3 };
  const pose: TransformChannels = { position: [6, -2, 5], rotation: [15, 70, -35], scale: [2, 3, .5] };
  const parent = new Matrix4().compose(new Vector3(4, 5, 6), q([30, 10, 80]), new Vector3(2, 3, 4));
  const child = new Matrix4().makeTranslation(3, 2, 1), before = objectLocalMatrix(object, pose);
  const edited = relocateObjectPivot(object, pose, [-3, 4, 2]);
  nearMatrix(objectLocalMatrix(edited, pose), before);
  nearMatrix(parent.clone().multiply(objectLocalMatrix(edited, pose)).multiply(child), parent.clone().multiply(before).multiply(child));
  expect(edited.position).toBe(object.position); expect(object.pivot).toEqual([1, 2, 3]);
  expect(objectGeometryPosition(edited, pose).distanceTo(new Vector3().setFromMatrixPosition(before))).toBeLessThan(1e-9);
});

it("converts a pivot proxy's parent-local transform back into authored channels", () => {
  const object = { ...node(), pivot: [2, -1, 3] as Vec3, pivotCompensation: [4, 0, 1] as Vec3 };
  const pose: TransformChannels = { position: [7, 2, 1], rotation: [25, 15, 80], scale: [2, 3, 4] };
  const proxy = { position: objectPivotPosition(object, pose).toArray() as Vec3, rotation: pose.rotation, scale: pose.scale };
  expect(channelsFromPivotProxy(object, proxy)).toEqual(pose);
  const moved = channelsFromPivotProxy(object, { ...proxy, position: [14, 4, 6] });
  expect(moved.position).toEqual([8, 5, 2]);
});

it("evaluates existing animated rotation around the authored pivot and keeps pivot edits undoable", () => {
  const object = node(), doc = emptyScene(); doc.nodes.object = object; doc.rootIds = [object.id];
  doc.animation = { ...defaultAnimation(), end: 10, tracks: [{ id: "turn", targetId: object.id, channel: "rotation.z", keys: [
    { id: "start", time: 0, value: 0, interpolation: "linear", tangentMode: "auto" },
    { id: "end", time: 10, value: 90, interpolation: "linear", tangentMode: "auto" },
  ] }] };
  const store = createSceneStore(doc), edited = relocateObjectPivot(object, object, [1, 0, 0]);
  store.setState({ document: { ...doc, nodes: { ...doc.nodes, object: edited } }, editLabel: "Move object pivot" });
  const next = store.getState().document, poses = evaluateSceneAnimation(next, 10), world = constraintWorldMatrices(next, poses).get(object.id)!;
  const origin = new Vector3().setFromMatrixPosition(world);
  expect(origin.x).toBeCloseTo(1); expect(origin.y).toBeCloseTo(-1);
  expect(new Vector3(1, 0, 0).applyMatrix4(world).distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
  expect(next.animation).toBe(doc.animation);
  store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
  store.temporal.getState().redo(); expect(store.getState().document).toBe(next);
});

it("point and parent constraints solve geometry origins with pivots after rotation is applied", () => {
  for (const type of ["point", "parent"] as const) {
    const doc = emptyScene(), source = { ...node("source"), position: [5, 7, 9] as Vec3, rotation: [10, 20, 45] as Vec3 };
    const target = { ...node("target"), pivot: [3, -2, 1] as Vec3, pivotCompensation: [1, 0, -2] as Vec3, rotation: [30, 40, 50] as Vec3, scale: [2, 3, 4] as Vec3 };
    doc.nodes = { source, target }; doc.rootIds = [source.id, target.id];
    const store = createSceneStore(doc); createConstraint(store, type, source.id, target.id, false);
    const next = store.getState().document, poses = evaluateSceneAnimation(next, 0); evaluateConstraints(next, poses);
    const world = constraintWorldMatrices(next, poses);
    expect(new Vector3().setFromMatrixPosition(world.get(target.id)!).distanceTo(new Vector3(...source.position))).toBeLessThan(1e-8);
    if (type === "parent") {
      const actual = new Quaternion(); world.get(target.id)!.decompose(new Vector3(), actual, new Vector3());
      expect(Math.abs(actual.dot(q(source.rotation)))).toBeCloseTo(1, 9);
    }
  }
});

it("aims around the pivot anchor while preserving that anchor", () => {
  const doc = emptyScene(), source = { ...node("source"), position: [5, 3, 0] as Vec3 }, target = { ...node("target"), pivot: [1, 0, 0] as Vec3 };
  doc.nodes = { source, target }; doc.rootIds = [source.id, target.id];
  const store = createSceneStore(doc); createConstraint(store, "aim", source.id, target.id, false, undefined, { aimAxis: "+X" });
  const next = store.getState().document, poses = evaluateSceneAnimation(next, 0); evaluateConstraints(next, poses);
  const world = constraintWorldMatrices(next, poses).get(target.id)!, pivot = new Vector3(...target.pivot).applyMatrix4(world);
  expect(pivot.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
  const axis = new Vector3(1, 0, 0).transformDirection(world), desired = new Vector3(...source.position).sub(pivot).normalize();
  expect(axis.dot(desired)).toBeCloseTo(1, 9);
});

it("rejects invalid pivot coordinates before changing the node", () => {
  const object = node(); expect(() => relocateObjectPivot(object, object, [NaN, 0, 0])).toThrow(/finite/);
  expect(object.pivot).toBeUndefined();
});
