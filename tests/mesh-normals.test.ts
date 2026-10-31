import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { createSceneStore } from "../src/scene-store.ts";
import { createMeshPrimitive, deleteMeshFaces, findMeshShape, triangulateMesh, updateMeshAppearance, validateMeshShape } from "../src/mesh-modeling.ts";
import { reverseMeshNormals } from "../src/mesh-normals.ts";
import { createMeshRenderable } from "../src/mesh-renderer.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import type { MeshShapeNode, Vec3 } from "../src/scene-document.ts";

function fixture(preset: "cube" | "plane" = "cube") {
  const store = createSceneStore(), id = createMeshPrimitive(store, preset), shape = findMeshShape(store.getState().document, id)!;
  return { store, id, shape };
}
function triangleNormals(shape: MeshShapeNode) {
  const triangles = triangulateMesh(shape), normals = new Map<string, Vector3>();
  for (let index = 0; index < triangles.indices.length; index += 3) {
    const points = triangles.indices.slice(index, index + 3).map(vertex => new Vector3().fromArray(triangles.positions, vertex * 3));
    const id = triangles.triangleFaceIds[index / 3], sum = normals.get(id) ?? new Vector3();
    sum.add(new Vector3().crossVectors(points[1].sub(points[0]), points[2].sub(points[0]))); normals.set(id, sum);
  }
  for (const normal of normals.values()) normal.normalize();
  return normals;
}
function disconnectedShells() {
  const { store, shape } = fixture(), second = fixture().shape;
  const combined: MeshShapeNode = { ...shape, vertices: [...shape.vertices, ...second.vertices.map(vertex => ({ ...vertex, position: [vertex.position[0] + 3, vertex.position[1], vertex.position[2]] as Vec3 }))], faces: [...shape.faces, ...second.faces] };
  validateMeshShape(combined);
  const doc = store.getState().document;
  return { store: createSceneStore({ ...doc, nodes: { ...doc.nodes, [shape.id]: combined } }), shape: combined, firstIds: shape.faces.map(face => face.id), secondIds: second.faces.map(face => face.id) };
}

describe("reverse mesh normals", () => {
  it("reverses actual triangulated face normals without moving vertices or replacing component IDs", () => {
    const { store, shape } = fixture(), original = structuredClone(shape), beforeNormals = triangleNormals(shape);
    expect(reverseMeshNormals(store, shape.id)).toEqual(shape.faces.map(face => face.id));
    const changed = findMeshShape(store.getState().document, shape.id)!;
    expect(changed.vertices).toEqual(original.vertices);
    expect(changed.faces.map(face => face.id)).toEqual(original.faces.map(face => face.id));
    changed.faces.forEach((face, index) => expect(face.vertices).toEqual([...original.faces[index].vertices].reverse()));
    for (const [id, normal] of triangleNormals(changed)) expect(normal.dot(beforeNormals.get(id)!)).toBeCloseTo(-1, 10);
    expect(shape).toEqual(original); expect(() => validateMeshShape(changed)).not.toThrow();
    reverseMeshNormals(store, shape.id); expect(findMeshShape(store.getState().document, shape.id)).toEqual(original);
  });

  it("expands one selected face to its complete shell and leaves disconnected shells unchanged", () => {
    const { store, shape, firstIds, secondIds } = disconnectedShells(), beforeNormals = triangleNormals(shape);
    expect(reverseMeshNormals(store, shape.id, [firstIds[0], firstIds[0]])).toEqual(firstIds);
    const changed = findMeshShape(store.getState().document, shape.id)!;
    for (const id of secondIds) expect(changed.faces.find(face => face.id === id)).toEqual(shape.faces.find(face => face.id === id));
    for (const [id, normal] of triangleNormals(changed)) expect(normal.dot(beforeNormals.get(id)!)).toBeCloseTo(firstIds.includes(id) ? -1 : 1, 10);
    expect(() => validateMeshShape(changed)).not.toThrow();
  });

  it("allows several shell seeds in one atomic operation with stable document-order results", () => {
    const { store, shape, firstIds, secondIds } = disconnectedShells();
    const historyLength = store.temporal.getState().pastStates.length;
    const changed = reverseMeshNormals(store, shape.id, [secondIds[2], firstIds[3]]);
    expect(changed).toEqual(shape.faces.map(face => face.id));
    expect(store.temporal.getState().pastStates).toHaveLength(historyLength + 1);
    for (const [id, normal] of triangleNormals(findMeshShape(store.getState().document, shape.id)!)) expect(normal.dot(triangleNormals(shape).get(id)!)).toBeCloseTo(-1, 10);
  });

  it("regenerates smooth vertex normals in the renderer after reversal", () => {
    const { store, shape } = fixture("plane"); updateMeshAppearance(store, shape.id, { shading: "smooth" });
    const before = findMeshShape(store.getState().document, shape.id)!, renderer = createMeshRenderable(before);
    const oldNormals = Array.from(renderer.mesh.geometry.getAttribute("normal").array), positions = Array.from(renderer.mesh.geometry.getAttribute("position").array);
    reverseMeshNormals(store, shape.id, [shape.faces[0].id]); renderer.update(findMeshShape(store.getState().document, shape.id)!);
    const normals = renderer.mesh.geometry.getAttribute("normal");
    for (let index = 0; index < normals.count; index++) {
      const previous = new Vector3().fromArray(oldNormals, index * 3), next = new Vector3().fromBufferAttribute(normals, index);
      expect(previous.length()).toBeCloseTo(1); expect(next.dot(previous)).toBeCloseTo(-1, 10);
    }
    expect(renderer.mesh.material.flatShading).toBe(false); expect(Array.from(renderer.mesh.geometry.getAttribute("position").array)).toEqual(positions); renderer.dispose();
  });

  it("round-trips reversed winding through undo, redo, and an MSB archive", async () => {
    const { store, shape } = fixture(), before = store.getState().document;
    reverseMeshNormals(store, shape.id, [shape.faces[0].id]); const after = store.getState().document;
    expect(store.getState().editLabel).toBe("Reverse mesh normals");
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
    const editor = { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: .01, far: 1000 }, time: 0 };
    const restored = await decodeProject(await encodeProject(after, new Map(), editor));
    const reopened = findMeshShape(restored.scene, shape.id)!;
    expect(reopened).toEqual(findMeshShape(after, shape.id)); expect(triangulateMesh(reopened)).toEqual(triangulateMesh(findMeshShape(after, shape.id)!));
  });

  it("rejects empty or stale explicit selections and non-mesh targets without a history entry", () => {
    const { store, shape, id } = fixture(), before = store.getState().document, historyLength = store.temporal.getState().pastStates.length;
    for (const ids of [[], ["missing"], [shape.faces[0].id, "missing"]]) expect(() => reverseMeshNormals(store, shape.id, ids)).toThrow(/existing mesh faces/);
    expect(() => reverseMeshNormals(store, shape.id, new Array(2))).toThrow(/existing mesh faces/);
    expect(() => reverseMeshNormals(store, shape.id, Array(100_001).fill(shape.faces[0].id))).toThrow(/existing mesh faces/);
    expect(() => reverseMeshNormals(store, "missing")).toThrow(/polygon mesh/);
    expect(() => reverseMeshNormals(store, id)).toThrow(/polygon mesh/);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(historyLength);
  });

  it("treats reversing an empty mesh as a no-op but still rejects an explicit empty selection", () => {
    const { store, shape } = fixture("plane"); deleteMeshFaces(store, shape.id, shape.faces.map(face => face.id));
    const before = store.getState().document, historyLength = store.temporal.getState().pastStates.length;
    expect(reverseMeshNormals(store, shape.id)).toEqual([]);
    expect(() => reverseMeshNormals(store, shape.id, [])).toThrow(/existing mesh faces/);
    expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(historyLength);
  });
});
