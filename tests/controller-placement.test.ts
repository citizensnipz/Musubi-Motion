import { describe, expect, it } from "vitest";
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import { evaluateSceneAnimation } from "../src/animation.ts";
import { createController } from "../src/controller-curves.ts";
import { controllerPlacement } from "../src/controller-placement.ts";
import { constraintWorldMatrices } from "../src/constraints.ts";
import { emptyScene, type TransformNode, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture() {
  const store = createSceneStore(emptyScene());
  const parent = createController(store, "circle", { position: [3, 2, 1], rotation: [0, 0, 90], scale: [2, 2, 2] });
  const child = createController(store, "square", { position: [1, 0, 0], rotation: [20, 0, 0] });
  const doc = structuredClone(store.getState().document);
  doc.nodes[child].parentId = parent; doc.rootIds = doc.rootIds.filter(id => id !== child);
  return { doc, parent, child };
}

describe("controller placement from displayed world transforms", () => {
  it("preserves evaluated world position, orientation and scale under a transformed parent", () => {
    const { doc, child } = fixture(), poses = evaluateSceneAnimation(doc, 0);
    poses.get(child)!.position = [2, 0, 0];
    const placement = controllerPlacement(doc, poses, child);
    const actual = new Matrix4().compose(new Vector3(...placement.position), new Quaternion().setFromEuler(new Euler(...placement.rotation.map(MathUtils.degToRad) as Vec3, "XYZ")), new Vector3(...placement.scale));
    const expected = constraintWorldMatrices(doc, poses).get(child)!;
    actual.elements.forEach((value, index) => expect(value).toBeCloseTo(expected.elements[index], 8));
    placement.position.forEach((value, index) => expect(value).toBeCloseTo([3, 6, 1][index], 8));
  });
  it("rejects shear and unrepresentable tiny root scale instead of moving the new control", () => {
    const { doc, parent, child } = fixture();
    (doc.nodes[parent] as TransformNode).scale = [2, 1, 1];
    (doc.nodes[child] as TransformNode).rotation = [0, 0, 45];
    expect(() => controllerPlacement(doc, evaluateSceneAnimation(doc, 0), child)).toThrow(/shear/);
    (doc.nodes[parent] as TransformNode).scale = [0.001, 0.001, 0.001];
    (doc.nodes[child] as TransformNode).scale = [0.1, 0.1, 0.1];
    expect(() => controllerPlacement(doc, evaluateSceneAnimation(doc, 0), child)).toThrow(/scale/);
  });
  it("places at evaluated joints and rejects missing scene IDs", () => {
    const doc = emptyScene(); doc.joints = [{ id: "root", name: "Root", parentId: null, position: [0, 0, 0] }];
    const poses = evaluateSceneAnimation(doc, 0); poses.get("root")!.position = [4, 5, 6];
    expect(controllerPlacement(doc, poses, "root").position).toEqual([4, 5, 6]);
    expect(() => controllerPlacement(doc, poses, "missing")).toThrow(/Select/);
  });
});
