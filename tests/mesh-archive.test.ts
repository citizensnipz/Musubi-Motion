import { describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { evaluateSceneAnimation, setKeys } from "../src/animation.ts";
import { createConstraint, evaluateConstraints } from "../src/constraints.ts";
import { createController } from "../src/controller-curves.ts";
import { evaluateDrivenKeys, setDrivenKey } from "../src/driven-keys.ts";
import { createMeshPrimitive, extrudeMeshFaces, findMeshShape, updateMeshAppearance } from "../src/mesh-modeling.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { addSplat, emptyScene, type MeshShapeNode, type SceneDocument, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

const editor = { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: 0.01, far: 1000 }, time: 0.5 };

function fixture() {
  const file = new File([new Uint8Array([3, 1, 4, 1, 5])], "scan.splat");
  const splat = addSplat(emptyScene(), { id: "capture", kind: "file", fileName: file.name, byteLength: file.size }, "Capture", [0, 0, 0]);
  const store = createSceneStore({ ...splat.document, joints: [
    { id: "shoulder", name: "Shoulder", parentId: null, position: [0, 0, 0] },
    { id: "elbow", name: "Elbow", parentId: "shoulder", position: [0, 1, 0], rotation: [0, 0, 20] },
  ] });
  const meshId = createMeshPrimitive(store, "cube", { name: "Body", position: [1, 0, 0] });
  const shape = findMeshShape(store.getState().document, meshId)!;
  extrudeMeshFaces(store, shape.id, [shape.faces[0].id], 0.25);
  updateMeshAppearance(store, shape.id, { color: "#aa55cc", shading: "smooth", wireframe: true });
  const controlId = createController(store, "circle", { name: "BodyControl" });
  setKeys(store, [controlId, "elbow"], 0, undefined, ["rotation.z"]);
  const poses = evaluateSceneAnimation(store.getState().document, 24);
  poses.get(controlId)!.rotation[2] = 90; poses.get("elbow")!.rotation[2] = 50;
  setKeys(store, [controlId, "elbow"], 24, poses, ["rotation.z"]);
  setDrivenKey(store, { targetId: controlId, channel: "rotation.z" }, { targetId: meshId, channel: "scale.x" }, 0, 1);
  setDrivenKey(store, { targetId: controlId, channel: "rotation.z" }, { targetId: meshId, channel: "scale.x" }, 90, 2);
  createConstraint(store, "point", controlId, meshId, true);
  return { store, meshId, shapeId: shape.id, controlId, files: new Map([["capture", file]]) };
}

function evaluated(doc: SceneDocument) {
  const poses = evaluateSceneAnimation(doc, 12);
  evaluateDrivenKeys(doc, poses); evaluateConstraints(doc, poses);
  return poses;
}

async function alteredMesh(change: (shape: MeshShapeNode) => void) {
  const data = fixture(), entries = unzipSync(await encodeProject(data.store.getState().document, data.files, editor));
  const manifest = JSON.parse(strFromU8(entries["scene.json"]));
  change(manifest.scene.nodes[data.shapeId]);
  entries["scene.json"] = strToU8(JSON.stringify(manifest));
  return { ...data, bytes: zipSync(entries) };
}

describe("polygon mesh archives", () => {
  it("round trips edited topology alongside splats, controls, joint animation, driven keys and constraints", async () => {
    const { store, meshId, shapeId, files } = fixture(), scene = store.getState().document;
    const before = JSON.stringify(scene), bytes = await encodeProject(scene, files, editor), entries = unzipSync(bytes);
    const opened = await decodeProject(bytes);
    expect(Object.keys(entries).sort()).toEqual(["assets/capture", "scene.json"]);
    expect(opened.scene).toEqual(scene); expect(opened.editor).toEqual(editor);
    expect(JSON.stringify(scene)).toBe(before);
    expect(evaluated(opened.scene)).toEqual(evaluated(scene));
    expect(evaluated(opened.scene).get(meshId)!.scale[0]).toBeCloseTo(1.5);
    const shape = opened.scene.nodes[shapeId] as MeshShapeNode;
    expect(shape.vertices.map(vertex => vertex.id)).toEqual((scene.nodes[shapeId] as MeshShapeNode).vertices.map(vertex => vertex.id));
    expect(shape.faces.some(face => face.vertices.length === 4)).toBe(true);
    expect(shape).toMatchObject({ color: "#aa55cc", shading: "smooth", wireframe: true });
    expect(new Uint8Array(await opened.files.get("capture")!.arrayBuffer())).toEqual(new Uint8Array([3, 1, 4, 1, 5]));
  });

  it("rejects malformed vertex references before a staged archive can replace the active scene", async () => {
    const data = await alteredMesh(shape => { shape.faces[0].vertices[0] = "missing-vertex"; });
    const active = data.store.getState().document, before = JSON.stringify(active), history = data.store.temporal.getState().pastStates.length;
    const apply = vi.fn((opened: Awaited<ReturnType<typeof decodeProject>>) => data.store.setState({ document: opened.scene, editLabel: "Open scene" }));
    await expect(decodeProject(data.bytes).then(apply)).rejects.toThrow(/existing vertex/);
    expect(apply).not.toHaveBeenCalled(); expect(data.store.getState().document).toBe(active);
    expect(JSON.stringify(active)).toBe(before); expect(data.store.temporal.getState().pastStates).toHaveLength(history);
  });

  it("rejects disconnected vertex fans and inconsistent winding on archive load", async () => {
    const fan = await alteredMesh(shape => {
      shape.vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]].map((position, index) => ({ id: `v${index}`, position: position as Vec3 }));
      shape.faces = [{ id: "upper", vertices: ["v0", "v1", "v2"] }, { id: "lower", vertices: ["v0", "v3", "v4"] }];
    });
    await expect(decodeProject(fan.bytes)).rejects.toThrow(/Nonmanifold mesh vertices/);
    const winding = await alteredMesh(shape => { shape.faces.push({ ...shape.faces[0], id: "duplicate-face" }); });
    await expect(decodeProject(winding.bytes)).rejects.toThrow(/consistent face winding/);
  });

  it("rejects invalid mesh saves before generating an archive and preserves empty editable meshes", async () => {
    const { store, shapeId, files } = fixture(), scene = structuredClone(store.getState().document);
    const shape = scene.nodes[shapeId] as MeshShapeNode;
    shape.vertices[0].position[0] = Infinity;
    await expect(encodeProject(scene, files, editor)).rejects.toThrow(/finite positions/);
    shape.vertices = []; shape.faces = [];
    const reopened = await decodeProject(await encodeProject(scene, files, editor));
    expect(reopened.scene.nodes[shapeId]).toEqual(shape);
  });
});
