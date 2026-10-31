import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { evaluateSceneAnimation } from "../src/animation.ts";
import { constraintWorldMatrices, createConstraint, evaluateConstraints, validateConstraints, type Constraint } from "../src/constraints.ts";
import { ikInputConstraintTargets, validateIKControlDependencies } from "../src/ik-control-plan.ts";
import { emptyScene, type SceneDocument, type TransformNode } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture(): SceneDocument {
  const doc = emptyScene();
  for (const id of ["source", "sourceParent", "control", "controlParent", "pole", "other", "late"]) {
    doc.nodes[id] = { id, name: id, type: "transform", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
    doc.rootIds.push(id);
  }
  doc.joints = [
    { id: "ancestor", name: "ancestor", parentId: null, position: [0, 0, 0] },
    { id: "root", name: "root", parentId: "ancestor", position: [0, 0, 0] },
    { id: "middle", name: "middle", parentId: "root", position: [1, 0, 0] },
    { id: "end", name: "end", parentId: "middle", position: [1, 0, 0] },
    { id: "branch", name: "branch", parentId: "middle", position: [0, 1, 0] },
  ];
  doc.ikHandles = [{ id: "ik", name: "Arm", rootId: "root", endId: "end", target: [1, 1, 0], enabled: true, iterations: 64, blend: 1,
    targetControl: { objectId: "control", offset: [0, 0, 0] } }];
  doc.constraints = [];
  return doc;
}
function node(doc: SceneDocument, id: string) { return doc.nodes[id] as TransformNode; }
function point(sourceId: string, targetId: string, enabled = true): Constraint {
  return { id: `${sourceId}_${targetId}`, name: `${sourceId} to ${targetId}`, type: "point", sourceId, targetId, enabled, maintainOffset: false,
    offset: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } };
}
function addOtherChain(doc: SceneDocument) {
  doc.joints!.push(
    { id: "otherRoot", name: "otherRoot", parentId: "ancestor", position: [0, 2, 0] },
    { id: "otherEnd", name: "otherEnd", parentId: "otherRoot", position: [0, 1, 0] },
  );
  doc.ikHandles!.push({ id: "otherIK", name: "Other arm", rootId: "otherRoot", endId: "otherEnd", target: [1, 2, 0], enabled: true, iterations: 64, blend: 1 });
}

describe("linked IK constraint prerequisites", () => {
  it("leaves legacy scenes without links in the original final-only constraint phase", () => {
    const doc = fixture(); delete doc.ikHandles![0].targetControl;
    doc.constraints = [point("end", "control")];
    expect(ikInputConstraintTargets(doc).size).toBe(0);
    expect(() => validateConstraints(doc.constraints, doc)).not.toThrow();
    const poses = evaluateSceneAnimation(doc, 0);
    evaluateConstraints(doc, poses, { includeTargets: ikInputConstraintTargets(doc) });
    expect(poses.get("control")!.position).toEqual([0, 0, 0]);
    evaluateConstraints(doc, poses, { excludeTargets: ikInputConstraintTargets(doc) });
    expect(poses.get("control")!.position).toEqual([2, 0, 0]);
  });

  it("resolves constrained FK ancestors and control prerequisites before both branches sharing that ancestor", () => {
    const doc = fixture(); addOtherChain(doc);
    node(doc, "sourceParent").position = [10, 0, 0];
    node(doc, "other").position = [7, 0, 0];
    doc.constraints = [point("ancestor", "control"), point("source", "ancestor"), point("sourceParent", "source"), point("other", "late")];
    const targets = ikInputConstraintTargets(doc);
    expect(targets).toEqual(new Set(["control", "ancestor", "source", "sourceParent"]));
    const poses = evaluateSceneAnimation(doc, 0);
    evaluateConstraints(doc, poses, { includeTargets: targets });
    const world = constraintWorldMatrices(doc, poses);
    for (const id of ["root", "otherRoot", "control"]) expect(new Vector3().setFromMatrixPosition(world.get(id)!).x).toBe(10);
    expect(poses.get("late")!.position).toEqual([0, 0, 0]);
    const earlyControl = poses.get("control"), earlyAncestor = poses.get("ancestor");
    evaluateConstraints(doc, poses, { excludeTargets: targets });
    expect(poses.get("control")).toBe(earlyControl);
    expect(poses.get("ancestor")).toBe(earlyAncestor);
    expect(poses.get("late")!.position).toEqual([7, 0, 0]);
  });

  it("includes hierarchy parents, disabled sources and dormant pole links with a phase stable through blend zero", () => {
    const doc = fixture();
    node(doc, "control").parentId = "controlParent";
    node(doc, "source").parentId = "sourceParent";
    doc.constraints = [point("source", "controlParent", false), point("other", "pole", false)];
    doc.ikHandles![0].poleControl = { objectId: "pole", offset: [1, 2, 3] };
    const expected = new Set(["control", "pole", "ancestor", "controlParent", "other", "source", "sourceParent"]);
    expect(ikInputConstraintTargets(doc)).toEqual(expected);
    expect(ikInputConstraintTargets(doc)).toBe(ikInputConstraintTargets(doc));
    const disabled = structuredClone(doc);
    Object.assign(disabled.ikHandles![0], { enabled: false, blend: 0, solver: "ccd" });
    expect(ikInputConstraintTargets(disabled)).toEqual(expected);
  });

  it.each(["missing", "end", "shape"])("rejects a nontransform control reference: %s", objectId => {
    const doc = fixture();
    doc.nodes.shape = { id: "shape", name: "shape", type: "curveShape", parentId: "control", degree: 1, points: [[0, 0, 0, 1], [1, 0, 0, 1]], knots: [0, 0, 1, 1], closed: false, color: "#ffffff" };
    doc.ikHandles![0].targetControl!.objectId = objectId;
    expect(() => validateIKControlDependencies(doc)).toThrow(/existing object transform/);
  });

  it.each(["end", "root", "branch"])("rejects feedback through %s, including side descendants outside the explicit chain", sourceId => {
    const doc = fixture(); doc.constraints = [point(sourceId, "control")];
    expect(() => validateIKControlDependencies(doc)).toThrow(/Feedback and cross-IK/);
  });

  it("rejects indirect feedback even with disabled constraints, a disabled handle and zero blend", () => {
    const doc = fixture();
    doc.constraints = [point("end", "other", false), point("other", "control", false)];
    Object.assign(doc.ikHandles![0], { enabled: false, blend: 0 });
    expect(() => validateIKControlDependencies(doc)).toThrow(/Feedback and cross-IK/);
  });

  it("reserves dormant pole-only links against feedback while the solver is CCD", () => {
    const doc = fixture(); delete doc.ikHandles![0].targetControl;
    Object.assign(doc.ikHandles![0], { solver: "ccd", enabled: false, poleControl: { objectId: "pole", offset: [0, 0, 0] } });
    doc.constraints = [point("branch", "pole", false)];
    expect(() => validateIKControlDependencies(doc)).toThrow(/Feedback and cross-IK/);
  });

  it("rejects input from another IK chain even when that other handle is disabled", () => {
    const doc = fixture(); addOtherChain(doc); doc.ikHandles![1].enabled = false;
    doc.constraints = [point("otherEnd", "control")];
    expect(() => validateIKControlDependencies(doc)).toThrow(/cross-IK/);
  });

  it("also checks prerequisites of the linked chain's FK ancestor", () => {
    const doc = fixture(); addOtherChain(doc);
    doc.constraints = [point("otherEnd", "ancestor")];
    expect(() => validateIKControlDependencies(doc)).toThrow(/cross-IK/);
  });

  it("validates candidate constraints rather than a cached old document and leaves history untouched", () => {
    const doc = fixture(), store = createSceneStore(doc);
    ikInputConstraintTargets(doc);
    expect(() => validateConstraints([point("end", "control")], doc)).toThrow(/Feedback/);
    expect(() => createConstraint(store, "point", "end", "control", false)).toThrow(/Feedback/);
    expect(store.getState().document).toBe(doc);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    expect(doc.constraints).toEqual([]);
    createConstraint(store, "point", "source", "control", false);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(doc);
  });

  it("does not trust a runtime cache when validating caller-mutated data", () => {
    const doc = fixture(); ikInputConstraintTargets(doc);
    doc.constraints!.push(point("end", "control"));
    expect(() => validateIKControlDependencies(doc)).toThrow(/Feedback/);
    expect(() => ikInputConstraintTargets(doc)).toThrow(/Feedback/);
  });
});

describe("selective constraint evaluation", () => {
  it("composes unselected parent poses and gives exclusion priority over inclusion", () => {
    const doc = fixture();
    node(doc, "source").parentId = "sourceParent";
    node(doc, "sourceParent").position = [3, 0, 0];
    node(doc, "source").position = [2, 0, 0];
    node(doc, "control").position = [9, 0, 0];
    doc.constraints = [point("source", "control"), point("control", "late")];
    const poses = evaluateSceneAnimation(doc, 0);
    evaluateConstraints(doc, poses, { includeTargets: new Set(["control", "late"]), excludeTargets: new Set(["control"]) });
    expect(poses.get("control")!.position).toEqual([9, 0, 0]);
    expect(poses.get("late")!.position).toEqual([9, 0, 0]);
    evaluateConstraints(doc, poses, { includeTargets: new Set(["control"]) });
    expect(poses.get("control")!.position).toEqual([5, 0, 0]);
    expect(poses.get("late")!.position).toEqual([9, 0, 0]);
  });

  it("skips invalid unselected constraints and commits no partial updates when a selected constraint fails", () => {
    const doc = fixture();
    node(doc, "source").position = [10, 0, 0]; node(doc, "late").position = [10, 0, 0];
    doc.constraints = [point("source", "control"), { ...point("control", "late"), type: "aim" }];
    const early = evaluateSceneAnimation(doc, 0);
    expect(() => evaluateConstraints(doc, early, { includeTargets: new Set(["control"]) })).not.toThrow();
    expect(early.get("control")!.position).toEqual([10, 0, 0]);
    const poses = evaluateSceneAnimation(doc, 0), before = structuredClone(poses), originalControl = poses.get("control");
    expect(() => evaluateConstraints(doc, poses, { includeTargets: new Set(["control", "late"]) })).toThrow(/coincide/);
    expect(poses).toEqual(before);
    expect(poses.get("control")).toBe(originalControl);
  });
});
