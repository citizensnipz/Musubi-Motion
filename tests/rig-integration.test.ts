import { describe, expect, it } from "vitest";
import { Matrix4 } from "three";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { addSplat, deleteSceneItems, emptyScene, type SceneDocument } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { evaluateSceneAnimation, setKeys, validateAnimation } from "../src/animation.ts";
import { createIKHandle, evaluateIK, validateIKHandles } from "../src/ik.ts";
import { createConstraint, evaluateConstraints, validateConstraints } from "../src/constraints.ts";
import { setDrivenKey, evaluateDrivenKeys } from "../src/driven-keys.ts";
import { reparentJoint } from "../src/skeleton.ts";

const editor = { camera: { position: [3, 2, 8] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 42, near: 0.01, far: 1000 }, time: 0 };
function fixture(): SceneDocument {
  let doc = emptyScene();
  for (const id of ["source", "target", "nested"]) {
    doc = addSplat(doc, { id: `${id}-asset`, kind: "procedural", generator: "knot-v1" }, id, [0, 0, 0], id, `${id}-shape`).document;
  }
  doc.nodes.nested.parentId = "target"; doc.rootIds = doc.rootIds.filter(id => id !== "nested");
  doc.joints = [
    { id: "root", name: "root", parentId: null, position: [0, 0, 0] },
    { id: "middle", name: "middle", parentId: "root", position: [0, 1, 0] },
    { id: "end", name: "end", parentId: "middle", position: [0, 1, 0] },
    { id: "independent", name: "independent", parentId: null, position: [3, 0, 0] },
  ];
  const shape = doc.nodes["target-shape"];
  if (shape.type === "splatShape") {
    shape.binding = { jointIds: ["root", "middle", "end"], restMatrices: [0, 1, 2].map(y => new Matrix4().makeTranslation(0, y, 0).toArray()) };
    shape.elasticity = { stretch: 1, spacing: 1.5, expansion: 1, budget: 100, density: 1, distribution: 0, joints: null };
  }
  const store = createSceneStore(doc);
  setKeys(store, ["source"], 0, undefined, ["position.x"]);
  setKeys(store, ["source"], 20, new Map([["source", { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }]]), ["position.x"]);
  setDrivenKey(store, { targetId: "source", channel: "position.x" }, { targetId: "independent", channel: "rotation.z" }, 0, 0);
  setDrivenKey(store, { targetId: "source", channel: "position.x" }, { targetId: "independent", channel: "rotation.z" }, 2, 90);
  createIKHandle(store, "root", "end", [1, 1, 0]);
  createConstraint(store, "point", "source", "target", true);
  createConstraint(store, "orient", "end", "nested", true);
  return store.getState().document;
}
function evaluate(doc: SceneDocument, frame: number) {
  const poses = evaluateSceneAnimation(doc, frame); evaluateDrivenKeys(doc, poses); evaluateIK(doc, poses); evaluateConstraints(doc, poses); return poses;
}

describe("complete rig persistence and deletion", () => {
  it("round-trips combined animation, SDK, IK, constraints, binding and elasticity", async () => {
    const doc = fixture(), opened = await decodeProject(await encodeProject(doc, new Map(), editor));
    expect(opened.scene).toEqual(doc);
    expect(evaluate(opened.scene, 10)).toEqual(evaluate(doc, 10));
    expect(opened.scene.nodes["target-shape"]).toEqual(doc.nodes["target-shape"]);
    expect(evaluate(doc, 10).get("target")!.position[0]).toBeCloseTo(1);
    expect(evaluate(doc, 10).get("independent")!.rotation[2]).toBeCloseTo(45);
  });
  it("removes all rig references to a deleted object subtree and preserves surviving IK", () => {
    const doc = fixture(), next = deleteSceneItems(doc, ["target"]);
    expect(next.nodes.target).toBeUndefined(); expect(next.nodes.nested).toBeUndefined();
    expect(next.constraints).toEqual([]); expect(next.ikHandles).toEqual(doc.ikHandles);
    expect(Object.keys(next.assets)).toEqual(["source-asset"]);
    expect(() => validateScene(next)).not.toThrow();
    const store = createSceneStore(doc); store.setState({ document: next, editLabel: "Delete object subtree" });
    store.temporal.getState().undo(); expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(next);
  });
  it("removes a deleted joint subtree's IK and constraints while retaining binding rest data", () => {
    const doc = fixture(), next = deleteSceneItems(doc, ["root"]);
    expect(next.joints!.map(joint => joint.id)).toEqual(["independent"]);
    expect(next.ikHandles).toEqual([]);
    expect(next.constraints!.map(constraint => constraint.type)).toEqual(["point"]);
    // The existing binding fallback uses rest matrices when a bone is removed.
    expect(next.nodes["target-shape"]).toBe(doc.nodes["target-shape"]);
    expect(() => validateScene(next)).not.toThrow();
    expect([...evaluate(next, 10).values()].every(pose => [...pose.position, ...pose.rotation, ...pose.scale].every(Number.isFinite))).toBe(true);
  });
  it("deleting an internal IK joint removes its descendant endpoint and handle", () => {
    const doc = fixture(), next = deleteSceneItems(doc, ["middle"]);
    expect(next.joints!.map(joint => joint.id)).toEqual(["root", "independent"]);
    expect(next.ikHandles).toEqual([]);
    expect(next.constraints!.some(constraint => constraint.sourceId === "end")).toBe(false);
    expect(next.nodes["target-shape"]).toBe(doc.nodes["target-shape"]);
    expect(() => validateScene(next)).not.toThrow();
  });
  it("removes animation, SDK source links and constraints when their source is deleted", () => {
    const next = deleteSceneItems(fixture(), ["source"]);
    expect(next.animation!.tracks).toEqual([]); expect(next.drivenKeys).toEqual([]);
    expect(next.constraints!.map(constraint => constraint.type)).toEqual(["orient"]);
    expect(() => validateScene(next)).not.toThrow();
  });
  it("rejects malformed rig records in actual packed archives before replacement", async () => {
    const packed = await encodeProject(fixture(), new Map(), editor);
    const mutations = [
      (scene: SceneDocument) => { scene.ikHandles![0].target = [Infinity, 0, 0]; },
      (scene: SceneDocument) => { scene.ikHandles![0].endId = "missing"; },
      (scene: SceneDocument) => { scene.constraints![0].sourceId = "missing"; },
      (scene: SceneDocument) => { scene.constraints![0].offset.rotation = [0, 0, 0, 0]; },
      (scene: SceneDocument) => { scene.constraints![0].sourceId = "nested"; },
    ];
    for (const mutate of mutations) {
      const entries = unzipSync(packed), manifest = JSON.parse(strFromU8(entries["scene.json"]));
      mutate(manifest.scene); entries["scene.json"] = strToU8(JSON.stringify(manifest));
      await expect(decodeProject(zipSync(entries))).rejects.toThrow();
    }
  });
  it("validates joint reparenting against both IK chains and constraint dependencies", () => {
    const doc = fixture();
    const invalidIK = { ...doc, joints: reparentJoint(doc.joints!, "end", null) };
    expect(() => validateIKHandles(invalidIK.ikHandles, invalidIK)).toThrow(/descendant/);
    const plain = createSceneStore({ ...doc, constraints: [], ikHandles: [] });
    createConstraint(plain, "point", "root", "independent", false);
    const constrained = plain.getState().document;
    const invalidConstraint = { ...constrained, joints: reparentJoint(constrained.joints!, "root", "independent") };
    expect(() => validateConstraints(invalidConstraint.constraints, invalidConstraint)).toThrow(/cycle/);
  });
  it("rejects transform/joint and shape/joint ID collisions in archive and core validation", () => {
    for (const id of ["source", "source-shape"]) {
      const doc = fixture(); doc.joints!.push({ id, name: "collision", parentId: null, position: [0, 0, 0] });
      expect(() => validateAnimation(doc.animation, doc)).toThrow(/distinct/);
      expect(() => validateIKHandles(doc.ikHandles, doc)).toThrow(/distinct/);
      expect(() => validateConstraints(doc.constraints, doc)).toThrow(/distinct/);
      expect(() => validateScene({ ...doc, animation: undefined, ikHandles: undefined, constraints: undefined, drivenKeys: undefined })).toThrow();
    }
  });
});
