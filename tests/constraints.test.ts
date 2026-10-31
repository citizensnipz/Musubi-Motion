import { describe, expect, it } from "vitest";
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import { evaluateSceneAnimation, type AnimationPose } from "../src/animation.ts";
import { constraintWorldMatrices, createConstraint, deleteConstraint, evaluateConstraints, updateConstraint, validateConstraints, type Constraint } from "../src/constraints.ts";
import { emptyScene, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture(): SceneDocument {
  const doc = emptyScene();
  for (const id of ["source", "target", "parent", "other"]) {
    doc.nodes[id] = { id, type: "transform", name: id, parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
    doc.rootIds.push(id);
  }
  return doc;
}
function position(matrix: Matrix4) { return new Vector3().setFromMatrixPosition(matrix); }
function rotation(matrix: Matrix4) { const quaternion = new Quaternion(); matrix.decompose(new Vector3(), quaternion, new Vector3()); return quaternion.normalize(); }
function scale(matrix: Matrix4) { const vector = new Vector3(); matrix.decompose(new Vector3(), new Quaternion(), vector); return vector; }
function world(doc: SceneDocument, poses: Map<string, AnimationPose>, id = "target") { return constraintWorldMatrices(doc, poses).get(id)!; }
function q(degrees: Vec3) { return new Quaternion().setFromEuler(new Euler(...degrees.map(MathUtils.degToRad) as Vec3)); }

describe("constraint evaluation", () => {
  it("point-constrains world translation under translated, rotated and scaled parents", () => {
    const doc = fixture(); doc.nodes.target.parentId = "parent";
    const poses = evaluateSceneAnimation(doc, 0);
    poses.get("parent")!.position = [4, 2, -1]; poses.get("parent")!.rotation = [10, 20, 90]; poses.get("parent")!.scale = [2, 3, 4];
    poses.get("source")!.position = [1, 3, 5];
    const store = createSceneStore(doc); createConstraint(store, "point", "source", "target", false, poses);
    const before = structuredClone(poses.get("target"));
    evaluateConstraints(store.getState().document, poses);
    expect(position(world(store.getState().document, poses)).distanceTo(new Vector3(1, 3, 5))).toBeLessThan(1e-8);
    expect(poses.get("target")!.rotation).toEqual(before!.rotation);
    expect(poses.get("target")!.scale).toEqual(before!.scale);
  });
  it("point maintain-offset preserves a world-space displacement as the source rotates", () => {
    const doc = fixture(), poses = evaluateSceneAnimation(doc, 0);
    poses.get("source")!.position = [1, 0, 0]; poses.get("target")!.position = [3, 2, 0];
    const store = createSceneStore(doc); createConstraint(store, "point", "source", "target", true, poses);
    evaluateConstraints(store.getState().document, poses);
    expect(poses.get("target")!.position).toEqual([3, 2, 0]);
    poses.get("source")!.position = [4, 1, 0]; poses.get("source")!.rotation = [0, 0, 90];
    evaluateConstraints(store.getState().document, poses);
    expect(poses.get("target")!.position).toEqual([6, 3, 0]);
  });
  it("orient-constrains with a stable quaternion offset and compensates parent rotation", () => {
    const doc = fixture(); doc.nodes.target.parentId = "parent";
    const poses = evaluateSceneAnimation(doc, 0);
    poses.get("parent")!.rotation = [0, 20, 30]; poses.get("parent")!.scale = [2, 2, 2];
    poses.get("source")!.rotation = [10, 20, 40]; poses.get("target")!.rotation = [0, 0, 30];
    const original = rotation(world(doc, poses)), sourceOriginal = rotation(world(doc, poses, "source"));
    const offset = sourceOriginal.clone().invert().multiply(original);
    const store = createSceneStore(doc); createConstraint(store, "orient", "source", "target", true, poses);
    evaluateConstraints(store.getState().document, poses);
    expect(rotation(world(store.getState().document, poses)).angleTo(original)).toBeLessThan(1e-7);
    poses.get("source")!.rotation = [20, -30, 80]; evaluateConstraints(store.getState().document, poses);
    expect(rotation(world(store.getState().document, poses)).angleTo(q([20, -30, 80]).multiply(offset))).toBeLessThan(1e-7);
  });
  it("parent-constrains position and rotation while retaining target scale", () => {
    const doc = fixture(), poses = evaluateSceneAnimation(doc, 0);
    poses.get("target")!.position = [2, 0, 0]; poses.get("target")!.rotation = [0, 0, 30]; poses.get("target")!.scale = [3, 4, 5];
    const store = createSceneStore(doc); createConstraint(store, "parent", "source", "target", true, poses);
    const offset = structuredClone(store.getState().document.constraints![0].offset);
    poses.get("source")!.rotation = [0, 0, 90]; poses.get("source")!.scale = [2, 2, 2]; poses.get("source")!.position = [1, 0, 0];
    evaluateConstraints(store.getState().document, poses);
    expect(new Vector3(...poses.get("target")!.position).distanceTo(new Vector3(1, 4, 0))).toBeLessThan(1e-8);
    expect(q(poses.get("target")!.rotation).angleTo(q([0, 0, 120]))).toBeLessThan(1e-7);
    expect(poses.get("target")!.scale).toEqual([3, 4, 5]);
    expect(store.getState().document.constraints![0].offset).toEqual(offset);
  });
  it("preserves relative parent transforms when both source and driven have parents", () => {
    const doc = fixture(); doc.nodes.target.parentId = "parent"; doc.nodes.source.parentId = "other";
    const poses = evaluateSceneAnimation(doc, 0);
    poses.get("parent")!.position = [10, 2, 0]; poses.get("parent")!.rotation = [0, 0, 60]; poses.get("parent")!.scale = [2, 2, 2];
    poses.get("other")!.position = [-3, 0, 1]; poses.get("other")!.rotation = [0, 45, 0];
    poses.get("source")!.position = [1, 1, 0]; poses.get("target")!.position = [2, 0, 1]; poses.get("target")!.rotation = [20, 0, 0];
    const beforePosition = position(world(doc, poses)), beforeRotation = rotation(world(doc, poses));
    const store = createSceneStore(doc); createConstraint(store, "parent", "source", "target", true, poses); evaluateConstraints(store.getState().document, poses);
    expect(position(world(store.getState().document, poses)).distanceTo(beforePosition)).toBeLessThan(1e-8);
    expect(rotation(world(store.getState().document, poses)).angleTo(beforeRotation)).toBeLessThan(1e-7);
  });
  it("scale maintain-offset preserves ratios and compensates target parent scale", () => {
    const doc = fixture(); doc.nodes.target.parentId = "parent";
    const poses = evaluateSceneAnimation(doc, 0);
    poses.get("parent")!.scale = [2, 2, 2]; poses.get("source")!.scale = [2, 3, 4]; poses.get("target")!.scale = [1, 2, 3];
    const store = createSceneStore(doc); createConstraint(store, "scale", "source", "target", true, poses);
    evaluateConstraints(store.getState().document, poses); expect(poses.get("target")!.scale).toEqual([1, 2, 3]);
    poses.get("source")!.scale = [4, 6, 8]; evaluateConstraints(store.getState().document, poses);
    expect(scale(world(store.getState().document, poses)).toArray()).toEqual([4, 8, 12]);
  });
  it("evaluates chained constraints and hierarchical descendants independent of array order", () => {
    const doc = fixture(); doc.nodes.other.parentId = "target";
    const store = createSceneStore(doc);
    createConstraint(store, "point", "source", "target", false);
    createConstraint(store, "point", "other", "parent", false);
    const saved = store.getState().document, reversed = { ...saved, constraints: [...saved.constraints!].reverse() };
    const evaluate = (scene: SceneDocument) => {
      const poses = evaluateSceneAnimation(scene, 0); poses.get("source")!.position = [5, 1, 0]; poses.get("other")!.position = [2, 0, 0];
      evaluateConstraints(scene, poses); return poses;
    };
    const a = evaluate(saved), b = evaluate(reversed);
    expect(a.get("parent")!.position).toEqual([7, 1, 0]); expect(b).toEqual(a);
    expect(saved.nodes.target.position).toEqual([0, 0, 0]);
  });
  it("supports objects driving joints and joints driving objects, and disabling restores animation", () => {
    const doc = fixture(); doc.joints = [{ id: "joint", name: "joint", parentId: null, position: [0, 0, 0] }];
    const store = createSceneStore(doc);
    const id = createConstraint(store, "orient", "source", "joint", false);
    createConstraint(store, "orient", "joint", "target", false);
    const poses = evaluateSceneAnimation(store.getState().document, 0); poses.get("source")!.rotation = [0, 0, 45];
    evaluateConstraints(store.getState().document, poses);
    expect(poses.get("target")!.rotation[2]).toBeCloseTo(45);
    updateConstraint(store, id, { enabled: false });
    const disabled = evaluateSceneAnimation(store.getState().document, 0); disabled.get("source")!.rotation = [0, 0, 45];
    evaluateConstraints(store.getState().document, disabled); expect(disabled.get("joint")!.rotation).toEqual([0, 0, 0]);
  });
});

describe("constraint integrity and history", () => {
  it("rejects nonuniform driven parents for orient, parent and scale creation", () => {
    for (const type of ["orient", "parent", "scale"] as const) {
      const doc = fixture(); doc.nodes.target.parentId = "parent";
      const poses = evaluateSceneAnimation(doc, 0); poses.get("parent")!.scale = [2, 1, 1];
      const store = createSceneStore(doc);
      expect(() => createConstraint(store, type, "source", "target", false, poses)).toThrow(/uniformly scaled driven parent/);
      expect(store.getState().document).toBe(doc);
      poses.get("parent")!.scale = [2, 2, 2];
      expect(() => createConstraint(store, type, "source", "target", false, poses)).not.toThrow();
    }
  });
  it("rejects sheared source transforms while allowing ordinary nonuniform source scale", () => {
    const doc = fixture(); doc.nodes.source.parentId = "parent";
    const poses = evaluateSceneAnimation(doc, 0); poses.get("parent")!.scale = [2, 1, 1]; poses.get("source")!.rotation = [0, 0, 45];
    const store = createSceneStore(doc);
    expect(() => createConstraint(store, "orient", "source", "target", false, poses)).toThrow(/source contains shear/);
    poses.get("source")!.rotation = [0, 0, 0];
    expect(() => createConstraint(store, "orient", "source", "target", false, poses)).not.toThrow();
    poses.get("source")!.rotation = [0, 0, 45];
    expect(() => evaluateConstraints(store.getState().document, poses)).toThrow(/source contains shear/);
  });
  it("revalidates authored affine compatibility and allows disabling an unsupported constraint", () => {
    const doc = fixture(); doc.nodes.target.parentId = "parent";
    const store = createSceneStore(doc); const id = createConstraint(store, "orient", "source", "target", false);
    const unsupported = structuredClone(store.getState().document);
    if (unsupported.nodes.parent.type === "transform") unsupported.nodes.parent.scale = [2, 1, 1];
    expect(() => validateConstraints(unsupported.constraints, unsupported)).toThrow(/uniformly scaled driven parent/);
    const repair = createSceneStore(unsupported);
    expect(() => updateConstraint(repair, id, { enabled: false })).not.toThrow();
    expect(() => validateConstraints(repair.getState().document.constraints, repair.getState().document)).not.toThrow();
  });
  it("rejects animated unsupported parent scales without partially updating any poses", () => {
    const doc = fixture(); doc.nodes.target.parentId = "parent";
    const store = createSceneStore(doc);
    createConstraint(store, "point", "source", "other", false);
    createConstraint(store, "orient", "source", "target", false);
    const scene = store.getState().document, poses = evaluateSceneAnimation(scene, 0);
    poses.get("source")!.position = [5, 0, 0]; poses.get("parent")!.scale = [2, 1, 1];
    const original = structuredClone(poses);
    expect(() => evaluateConstraints(scene, poses)).toThrow(/Unsupported pose.*uniformly scaled/);
    expect(poses).toEqual(original);
    poses.get("parent")!.scale = [2, 2, 2];
    expect(() => evaluateConstraints(scene, poses)).not.toThrow();
    expect(poses.get("other")!.position).toEqual([5, 0, 0]);
  });
  it("keeps point constraints valid under sheared invertible parents and sources", () => {
    const doc = fixture(); doc.nodes.source.parentId = "other"; doc.nodes.parent.parentId = "other"; doc.nodes.target.parentId = "parent";
    const poses = evaluateSceneAnimation(doc, 0);
    poses.get("other")!.scale = [2, 1, 1]; poses.get("parent")!.rotation = [0, 0, 45]; poses.get("source")!.rotation = [0, 0, 45]; poses.get("source")!.position = [2, 3, 0];
    const store = createSceneStore(doc); createConstraint(store, "point", "source", "target", false, poses);
    evaluateConstraints(store.getState().document, poses);
    expect(position(world(store.getState().document, poses)).distanceTo(position(world(store.getState().document, poses, "source")))).toBeLessThan(1e-8);
    const singular = evaluateSceneAnimation(store.getState().document, 0); singular.get("parent")!.scale = [0, 1, 1];
    expect(() => evaluateConstraints(store.getState().document, singular)).toThrow(/singular transform/);
  });
  it("uses relative scale tolerance instead of assuming unit-sized parents", () => {
    for (const magnitude of [0.00001, 100000]) {
      const doc = fixture(); doc.nodes.target.parentId = "parent";
      const poses = evaluateSceneAnimation(doc, 0); poses.get("parent")!.scale = [magnitude, magnitude * (1 + 1e-8), magnitude];
      const store = createSceneStore(doc);
      expect(() => createConstraint(store, "orient", "source", "target", false, poses)).not.toThrow();
    }
  });
  it("rejects self, direct, and hierarchy-mediated cycles atomically", () => {
    const store = createSceneStore(fixture());
    expect(() => createConstraint(store, "point", "source", "source", false)).toThrow();
    createConstraint(store, "point", "source", "target", false);
    const doc = store.getState().document;
    expect(() => createConstraint(store, "orient", "target", "source", false)).toThrow(/cycle/);
    expect(store.getState().document).toBe(doc);
    const hierarchy = fixture(); hierarchy.nodes.target.parentId = "source";
    expect(() => createConstraint(createSceneStore(hierarchy), "point", "target", "source", false)).toThrow(/cycle/);
  });
  it("allows independent groups, rejects overlapping outputs, and rejects joint scale", () => {
    const store = createSceneStore(fixture());
    createConstraint(store, "point", "source", "target", false); createConstraint(store, "orient", "other", "target", false);
    expect(() => createConstraint(store, "parent", "parent", "target", false)).toThrow(/one constraint/);
    const doc = fixture(); doc.joints = [{ id: "joint", name: "joint", parentId: null, position: [0, 0, 0] }];
    expect(() => createConstraint(createSceneStore(doc), "scale", "source", "joint", false)).toThrow(/Joint scale/);
  });
  it("round-trips offsets, rejects invalid data, and keeps create/delete/toggle undoable", () => {
    const store = createSceneStore(fixture()); const id = createConstraint(store, "parent", "source", "target", true);
    const doc = store.getState().document, constraint = doc.constraints![0];
    expect(() => validateConstraints(JSON.parse(JSON.stringify(doc.constraints)), doc)).not.toThrow();
    for (const patch of [{ sourceId: "missing" }, { id: "__proto__" }, { enabled: 1 }, { offset: { ...constraint.offset, position: [NaN, 0, 0] } },
      { offset: { ...constraint.offset, rotation: [0, 0, 0, 0] } }, { offset: { ...constraint.offset, scale: [0, 1, 1] } }]) {
      expect(() => validateConstraints([{ ...constraint, ...patch }], doc)).toThrow();
    }
    updateConstraint(store, id, { enabled: false, name: "Follow source" });
    expect(store.getState().document.constraints![0].enabled).toBe(false);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    deleteConstraint(store, id); expect(store.getState().document.constraints).toEqual([]);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
  });
  it("revalidates hierarchy edits against existing constraints", () => {
    const store = createSceneStore(fixture()); createConstraint(store, "point", "source", "target", false);
    const changed = structuredClone(store.getState().document); changed.nodes.source.parentId = "target";
    expect(() => validateConstraints(changed.constraints, changed)).toThrow(/cycle/);
  });
  it("measures repeated evaluation of a hundred parent constraints", () => {
    const doc = emptyScene(); doc.constraints = [];
    for (let index = 0; index < 100; index++) {
      for (const prefix of ["source", "target"]) {
        const id = `${prefix}${index}`;
        doc.nodes[id] = { id, type: "transform", name: id, parentId: null, position: [index, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
      }
      doc.constraints.push({ id: `constraint${index}`, name: `constraint${index}`, type: "parent", sourceId: `source${index}`, targetId: `target${index}`,
        enabled: true, maintainOffset: true, offset: { position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
    }
    validateConstraints(doc.constraints, doc);
    const original = JSON.stringify(doc), started = performance.now();
    for (let frame = 0; frame < 100; frame++) {
      const poses = evaluateSceneAnimation(doc, frame); evaluateConstraints(doc, poses);
      expect(poses.get("target99")!.position).toEqual([99, 2, 0]);
    }
    console.info(`Constraints benchmark: 100 parent constraints × 100 evaluations in ${(performance.now() - started).toFixed(1)} ms`);
    expect(JSON.stringify(doc)).toBe(original);
  });
});
