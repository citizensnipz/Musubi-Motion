import { describe, expect, it } from "vitest";
import { mergeMeshVerticesToCenter } from "../src/mesh-merge.ts";
import { createMeshPrimitive, findMeshShape, meshEdges, validateMeshShape } from "../src/mesh-modeling.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { emptyScene, type MeshShapeNode, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture(points: Vec3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]], loops = [[0, 1, 2, 3]]) {
  const shape: MeshShapeNode = { id: "shape", name: "MeshShape", parentId: "object", type: "meshShape", color: "#abcdef", shading: "smooth", wireframe: true,
    vertices: points.map((position, index) => ({ id: `v${index}`, position })),
    faces: loops.map((vertices, index) => ({ id: `f${index}`, vertices: vertices.map(index => `v${index}`) })) };
  validateMeshShape(shape);
  const store = createSceneStore({ ...emptyScene(), rootIds: ["object"], nodes: {
    object: { id: "object", name: "Mesh", type: "transform", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" }, shape,
  } });
  return { shape, store, result: () => store.getState().document.nodes.shape as MeshShapeNode };
}

describe("merge mesh vertices to center", () => {
  it("uses a unique-vertex centroid and the first authored survivor regardless of selection order", () => {
    const { store, shape, result } = fixture();
    const before = JSON.stringify(shape);
    expect(mergeMeshVerticesToCenter(store, shape.id, ["v1", "v0", "v1"])).toBe("v0");
    expect(result().vertices).toEqual([{ id: "v0", position: [1, 0, 0] }, shape.vertices[2], shape.vertices[3]]);
    expect(result().faces).toEqual([{ id: "f0", vertices: ["v0", "v2", "v3"] }]);
    expect(result()).toMatchObject({ color: shape.color, shading: "smooth", wireframe: true });
    expect(JSON.stringify(shape)).toBe(before);
  });

  it("collapses consecutive corners across the cyclic wrap", () => {
    const { store, result } = fixture();
    mergeMeshVerticesToCenter(store, "shape", ["v3", "v0"]);
    expect(result().faces[0]).toEqual({ id: "f0", vertices: ["v0", "v1", "v2"] });
    expect(result().vertices[0].position).toEqual([0, 1, 0]);
  });

  it("drops collapsed faces while retaining the survivor and all unrelated isolated vertices", () => {
    const { store, result } = fixture([[0, 0, 0], [2, 0, 0], [0, 2, 0], [8, 9, 10]], [[0, 1, 2]]);
    mergeMeshVerticesToCenter(store, "shape", ["v2", "v0", "v1"]);
    expect(result().faces).toEqual([]);
    expect(result().vertices).toEqual([{ id: "v0", position: [2 / 3, 2 / 3, 0] }, { id: "v3", position: [8, 9, 10] }]);
  });

  it("welds shared topology throughout a closed cube and keeps every surviving face ID", () => {
    const store = createSceneStore(), id = createMeshPrimitive(store, "cube"), shape = findMeshShape(store.getState().document, id)!;
    const edge = meshEdges(shape)[0], survivor = mergeMeshVerticesToCenter(store, shape.id, edge.vertices);
    const result = findMeshShape(store.getState().document, id)!;
    expect(result.vertices).toHaveLength(7);
    expect(result.faces.map(face => face.id)).toEqual(shape.faces.map(face => face.id));
    expect(result.faces.filter(face => face.vertices.length === 3)).toHaveLength(2);
    expect(meshEdges(result).every(edge => edge.faceIds.length === 2)).toBe(true);
    expect(result.vertices.filter(vertex => edge.vertices.includes(vertex.id)).map(vertex => vertex.id)).toEqual([survivor]);
    expect(() => validateMeshShape(result)).not.toThrow();
  });

  it("rejects a nonconsecutive repeated corner rather than splitting a pinched face", () => {
    const { store } = fixture(), before = store.getState().document;
    expect(() => mergeMeshVerticesToCenter(store, "shape", ["v0", "v2"])).toThrow(/pinch/);
    expect(store.getState().document).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("rejects duplicate resulting faces independent of start corner and winding", () => {
    const { store } = fixture([[0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, -1, 0]], [[0, 1, 2], [2, 1, 3]]);
    const before = store.getState().document;
    expect(() => mergeMeshVerticesToCenter(store, "shape", ["v0", "v3"])).toThrow(/duplicate faces/);
    expect(store.getState().document).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("rejects disconnected face fans after welding separate shells", () => {
    const { store } = fixture([[0, 0, 0], [1, 0, 0], [0, 1, 0], [3, 0, 0], [4, 0, 0], [3, 1, 0]], [[0, 1, 2], [3, 4, 5]]);
    const before = store.getState().document;
    expect(() => mergeMeshVerticesToCenter(store, "shape", ["v0", "v3"])).toThrow(/Nonmanifold/);
    expect(store.getState().document).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("rejects zero-area surviving faces atomically through shared validation", () => {
    const { store } = fixture([[-1, 0, 0], [1, 0, 0], [2, 1, 0], [4, 2, 0]]), before = store.getState().document;
    expect(() => mergeMeshVerticesToCenter(store, "shape", ["v0", "v1"])).toThrow(/nonzero area/);
    expect(store.getState().document).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("rejects missing, malformed, insufficient, and excessive selections without history changes", () => {
    const { store } = fixture(), before = store.getState().document;
    for (const ids of [[], ["v0"], ["v0", "v0"], ["v0", "missing"], ["v0", ""], ["v0", 7], null, "v0", Array(100_001).fill("v0")]) {
      expect(() => mergeMeshVerticesToCenter(store, "shape", ids as string[])).toThrow();
    }
    for (const id of ["missing", "object", "", null, 7]) expect(() => mergeMeshVerticesToCenter(store, id as string, ["v0", "v1"])).toThrow();
    expect(store.getState().document).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it("supports one-step undo and redo with stable IDs", () => {
    const { store } = fixture(), before = store.getState().document;
    const survivor = mergeMeshVerticesToCenter(store, "shape", ["v1", "v0"]), after = store.getState().document;
    expect(store.getState().editLabel).toBe("Merge vertices to center");
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
    expect((after.nodes.shape as MeshShapeNode).vertices[0].id).toBe(survivor);
  });

  it("roundtrips merged topology, appearance and survivor IDs through the scene archive", async () => {
    const { store, result } = fixture();
    mergeMeshVerticesToCenter(store, "shape", ["v0", "v1"]);
    const editor = { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: .01, far: 1000 }, time: 0 };
    const opened = await decodeProject(await encodeProject(store.getState().document, new Map(), editor));
    expect(opened.scene.nodes.shape).toEqual(result());
  });
});
