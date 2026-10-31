import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { createSceneStore } from "../src/scene-store.ts";
import { emptyScene, type MeshShapeNode, type Vec3 } from "../src/scene-document.ts";
import { createMeshPrimitive, deleteMeshFaces, extrudeMeshFaces, findMeshShape, meshEdges, setMeshVertexPositions, triangulateMesh, updateMeshAppearance, validateMeshShape } from "../src/mesh-modeling.ts";

function fixture(preset: "cube" | "plane" | "sphere" | "cylinder" = "cube") {
  const store = createSceneStore(), id = createMeshPrimitive(store, preset), shape = findMeshShape(store.getState().document, id)!;
  return { store, id, shape };
}
const point = (shape: MeshShapeNode, id: string) => new Vector3(...shape.vertices.find(vertex => vertex.id === id)!.position);
const normal = (shape: MeshShapeNode, ids: string[]) => new Vector3().crossVectors(point(shape, ids[1]).sub(point(shape, ids[0])), point(shape, ids[2]).sub(point(shape, ids[0]))).normalize();
function grid(): MeshShapeNode {
  const vertices = Array.from({ length: 9 }, (_, index) => ({ id: `v${index}`, position: [index % 3, Math.floor(index / 3), 0] as Vec3 }));
  return { id: "shape", name: "GridShape", parentId: "object", type: "meshShape", vertices,
    faces: [0, 1, 3, 4].map(index => ({ id: `f${index}`, vertices: [index, index + 1, index + 4, index + 3].map(value => `v${value}`) })), color: "#aabbcc", shading: "flat", wireframe: false };
}
function storeFor(shape: MeshShapeNode) {
  return createSceneStore({ ...emptyScene(), rootIds: ["object"], nodes: {
    object: { id: "object", name: "Object", type: "transform", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" }, shape,
  } });
}

describe("shared polygon primitives and triangulation", () => {
  it("builds welded, consistently oriented primitives with stable component IDs", () => {
    for (const preset of ["cube", "plane", "sphere", "cylinder"] as const) {
      const { shape } = fixture(preset); expect(() => validateMeshShape(shape)).not.toThrow();
      expect(new Set([...shape.vertices.map(vertex => vertex.id), ...shape.faces.map(face => face.id)]).size).toBe(shape.vertices.length + shape.faces.length);
      const edges = meshEdges(shape), triangles = triangulateMesh(shape);
      expect(triangles.vertexIds).toEqual(shape.vertices.map(vertex => vertex.id)); expect(triangles.indices.length).toBe(triangles.triangleFaceIds.length * 3);
      expect(edges.every(edge => edge.faceIds.length === (preset === "plane" ? 1 : 2))).toBe(true);
      for (let index = 0; index < triangles.indices.length; index += 3) {
        const points = triangles.indices.slice(index, index + 3).map(vertex => point(shape, triangles.vertexIds[vertex]));
        const cross = new Vector3().crossVectors(points[1].clone().sub(points[0]), points[2].clone().sub(points[0]));
        if (preset !== "plane") expect(cross.dot(points[0].clone().add(points[1]).add(points[2]))).toBeGreaterThan(0);
      }
      if (preset === "cube") { expect(shape.vertices).toHaveLength(8); expect(shape.faces).toHaveLength(6); expect(edges).toHaveLength(12); }
      if (preset === "plane") { expect(shape.vertices).toHaveLength(4); expect(shape.faces).toHaveLength(1); }
      if (preset === "cylinder") { expect(shape.vertices).toHaveLength(32); expect(shape.faces).toHaveLength(18); }
    }
  });
  it("creates ordinary placed transforms without assets and supports one-step undo", () => {
    const store = createSceneStore(), before = store.getState().document;
    const id = createMeshPrimitive(store, "cube", { name: "Box", size: 2, position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 2, 2], color: "#abcdef" });
    const shape = findMeshShape(store.getState().document, id)!;
    expect(store.getState().document.nodes[id]).toMatchObject({ name: "Box", position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 2, 2] });
    expect(shape.vertices.every(vertex => vertex.position.every(value => Math.abs(value) === 1))).toBe(true);
    expect(store.getState().document.assets).toEqual({}); expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before); store.temporal.getState().redo();
    const second = createMeshPrimitive(store, "plane", { name: "Box" }); expect(store.getState().document.nodes[second].name).toBe("Box1");
  });
  it("triangulates concave and nonplanar polygons while retaining face and vertex ID mappings", () => {
    const shape = grid(); shape.vertices = [[0, 0, 0], [2, 0, 0], [2, 2, 0.3], [1, 1, 0], [0, 2, 0]].map((position, index) => ({ id: `v${index}`, position: position as Vec3 })); shape.faces = [{ id: "concave", vertices: shape.vertices.map(vertex => vertex.id) }];
    validateMeshShape(shape); const triangulated = triangulateMesh(shape);
    expect(triangulated.triangleFaceIds).toEqual(["concave", "concave", "concave"]);
    const reordered = { ...shape, vertices: [...shape.vertices].reverse() }, second = triangulateMesh(reordered);
    expect(second.indices.map(index => second.vertexIds[index])).toEqual(triangulated.indices.map(index => triangulated.vertexIds[index]));
    expect(meshEdges(reordered)).toEqual(meshEdges(shape));
  });
});

describe("mesh edit commands", () => {
  it("moves one shared cube vertex without requiring adjacent quads to remain planar", () => {
    const { store, shape } = fixture(), before = store.getState().document, selected = shape.vertices[0];
    const position = selected.position.map((value, axis) => value + [0.1, 0.2, 0.15][axis]) as Vec3;
    setMeshVertexPositions(store, shape.id, [{ id: selected.id, position }]);
    const edited = findMeshShape(store.getState().document, shape.id)!;
    expect(edited.vertices[0].position).toEqual(position); expect(edited.faces).toBe(shape.faces);
    expect(shape.faces.filter(face => face.vertices.includes(selected.id))).toHaveLength(3);
    expect(() => validateMeshShape(edited)).not.toThrow(); position[0] = 99; expect(edited.vertices[0].position[0]).not.toBe(99);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before); store.temporal.getState().redo(); expect(findMeshShape(store.getState().document, shape.id)).toBe(edited);
  });
  it("updates appearance atomically and preserves no-op document identity", () => {
    const { store, shape } = fixture(); updateMeshAppearance(store, shape.id, { color: "#ff00aa", shading: "smooth", wireframe: true });
    const doc = store.getState().document; expect(findMeshShape(doc, shape.id)).toMatchObject({ color: "#ff00aa", shading: "smooth", wireframe: true });
    updateMeshAppearance(store, shape.id, { shading: "smooth" }); setMeshVertexPositions(store, shape.id, []); expect(store.getState().document).toBe(doc);
    expect(() => updateMeshAppearance(store, shape.id, { color: "red" })).toThrow(); expect(store.getState().document).toBe(doc);
  });
  it("extrudes two adjacent cube faces as one region with boundary-only side walls", () => {
    const { store, shape } = fixture(), edge = meshEdges(shape)[0], selected = edge.faceIds, before = store.getState().document;
    const top = extrudeMeshFaces(store, shape.id, selected, 0.3), result = findMeshShape(store.getState().document, shape.id)!;
    expect(top).toHaveLength(2); expect(top.every(id => !selected.includes(id))).toBe(true);
    expect(result.faces).toHaveLength(12); expect(result.vertices).toHaveLength(14);
    expect(result.faces.filter(face => !top.includes(face.id) && !shape.faces.some(original => original.id === face.id))).toHaveLength(6);
    for (const face of shape.faces.filter(face => !selected.includes(face.id))) expect(result.faces.find(candidate => candidate.id === face.id)).toBe(face);
    expect(meshEdges(result).every(edge => edge.faceIds.length === 2)).toBe(true); expect(() => validateMeshShape(result)).not.toThrow();
    const after = store.getState().document; store.temporal.getState().undo(); expect(store.getState().document).toBe(before); store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
  });
  it("extrudes a connected grid region, shares top interior vertices and removes obsolete originals", () => {
    const shape = grid(), store = storeFor(shape), top = extrudeMeshFaces(store, shape.id, shape.faces.map(face => face.id), 1);
    const result = findMeshShape(store.getState().document, shape.id)!;
    expect(top).toHaveLength(4); expect(result.faces).toHaveLength(12); expect(result.vertices).toHaveLength(17);
    expect(result.vertices.some(vertex => vertex.id === "v4")).toBe(false);
    const topCenter = result.vertices.find(vertex => vertex.position[0] === 1 && vertex.position[1] === 1 && vertex.position[2] === 1)!;
    expect(result.faces.filter(face => top.includes(face.id) && face.vertices.includes(topCenter.id))).toHaveLength(4);
    expect(() => validateMeshShape(result)).not.toThrow();
  });
  it("rejects disconnected regions, closed whole meshes, zero normal and invalid distances atomically", () => {
    const { store, shape } = fixture(), before = store.getState().document;
    const first = shape.faces[0], n = normal(shape, first.vertices), opposite = shape.faces.find(face => normal(shape, face.vertices).dot(n) < -0.9)!;
    expect(() => extrudeMeshFaces(store, shape.id, [first.id, opposite.id], 1)).toThrow(/edge-connected/);
    expect(() => extrudeMeshFaces(store, shape.id, shape.faces.map(face => face.id), 1)).toThrow(/no region boundary/);
    const sides = shape.faces.filter(face => Math.abs(normal(shape, face.vertices).y) < 0.1);
    expect(() => extrudeMeshFaces(store, shape.id, sides.map(face => face.id), 1)).toThrow(/average normal/);
    for (const distance of [0, Infinity, NaN, 1000001]) expect(() => extrudeMeshFaces(store, shape.id, [first.id], distance)).toThrow();
    expect(store.getState().document).toBe(before);
  });
  it("deletes faces and unreferenced vertices, preserving stable IDs and allowing an empty mesh", () => {
    const { store, shape } = fixture(), deleted = shape.faces[0].id;
    deleteMeshFaces(store, shape.id, [deleted]); const remaining = findMeshShape(store.getState().document, shape.id)!;
    expect(remaining.faces).toHaveLength(5); expect(remaining.vertices).toHaveLength(8);
    expect(remaining.faces.every(face => shape.faces.includes(face))).toBe(true);
    deleteMeshFaces(store, shape.id, remaining.faces.map(face => face.id)); const empty = findMeshShape(store.getState().document, shape.id)!;
    expect(empty.faces).toEqual([]); expect(empty.vertices).toEqual([]); expect(() => validateMeshShape(empty)).not.toThrow(); expect(triangulateMesh(empty).indices).toEqual([]);
    store.temporal.getState().undo(); expect(findMeshShape(store.getState().document, shape.id)).toBe(remaining);
  });
});

describe("mesh validation and atomic failures", () => {
  it("rejects malformed topology, same-direction shared edges and disconnected vertex fans", () => {
    const { shape } = fixture();
    const cases: Array<(shape: any) => void> = [
      value => value.vertices[0].position[0] = NaN, value => value.vertices[0].position[0] = 1000001,
      value => value.vertices[1].id = value.vertices[0].id, value => value.faces[1].id = value.faces[0].id,
      value => value.faces[0].vertices[0] = "missing", value => value.faces[0].vertices[0] = value.faces[0].vertices[1],
      value => value.faces[0].vertices.reverse(), value => value.faces.push({ ...value.faces[0], id: "duplicate" }), value => value.shading = "bad", value => value.wireframe = 1,
    ];
    for (const mutate of cases) { const invalid = structuredClone(shape); mutate(invalid); expect(() => validateMeshShape(invalid)).toThrow(); }
    const fan = grid(); fan.faces = [fan.faces[0], fan.faces[3]]; expect(() => validateMeshShape(fan)).toThrow(/disconnected face fans/);
  });
  it("rejects projected self-intersections and zero-area edits before mutating the scene", () => {
    const { store, shape } = fixture("plane"), before = store.getState().document, face = shape.faces[0];
    const a = shape.vertices.find(vertex => vertex.id === face.vertices[0])!, b = shape.vertices.find(vertex => vertex.id === face.vertices[1])!;
    expect(() => setMeshVertexPositions(store, shape.id, [{ id: a.id, position: b.position }])).toThrow();
    expect(() => setMeshVertexPositions(store, shape.id, [{ id: "missing", position: [0, 0, 0] }])).toThrow(/no longer exists/);
    expect(() => setMeshVertexPositions(store, shape.id, [{ id: a.id, position: a.position }, { id: a.id, position: b.position }])).toThrow(/unique IDs/);
    expect(() => deleteMeshFaces(store, shape.id, ["missing"])).toThrow(); expect(store.getState().document).toBe(before);
    const crossed = grid(); crossed.vertices = [[0, 0, 0], [2, 2, 0], [0, 2, 0], [2, 0, 0]].map((position, index) => ({ id: `v${index}`, position: position as Vec3 })); crossed.faces = [{ id: "crossed", vertices: ["v0", "v1", "v2", "v3"] }];
    expect(() => validateMeshShape(crossed)).toThrow();
  });
  it("serializes stable topology and rejects excessive polygon and object counts", () => {
    const { shape } = fixture("cylinder"), restored = JSON.parse(JSON.stringify(shape)); validateMeshShape(restored); expect(triangulateMesh(restored)).toEqual(triangulateMesh(shape));
    expect(() => validateMeshShape({ ...shape, vertices: Array(100001).fill(shape.vertices[0]) })).toThrow(/100,000/);
    expect(() => validateMeshShape({ ...shape, faces: Array(100001).fill(shape.faces[0]) })).toThrow(/100,000/);
    const polygon = grid(); polygon.vertices = Array.from({ length: 65 }, (_, index) => ({ id: `v${index}`, position: [Math.cos(index / 65 * Math.PI * 2), Math.sin(index / 65 * Math.PI * 2), 0] })); polygon.faces = [{ id: "large", vertices: polygon.vertices.map(vertex => vertex.id) }];
    expect(() => validateMeshShape(polygon)).toThrow(/3–64/);
  });
});
