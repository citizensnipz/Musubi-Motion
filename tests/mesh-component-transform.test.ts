import { describe, expect, it } from "vitest";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { createMeshPrimitive, findMeshShape, meshEdges, setMeshVertexPositions } from "../src/mesh-modeling.ts";
import { captureMeshComponentTransform, resolveMeshComponentVertices } from "../src/mesh-component-transform.ts";
import { createSceneStore } from "../src/scene-store.ts";
import type { MeshShapeNode, Vec3 } from "../src/scene-document.ts";

function fixture() {
  const store = createSceneStore(), id = createMeshPrimitive(store, "cube"), shape = findMeshShape(store.getState().document, id)!;
  return { store, shape };
}
function nestedWorld() {
  return new Matrix4().compose(new Vector3(3, -2, 5), new Quaternion().setFromEuler(new Euler(0.4, -0.7, 0.3)), new Vector3(2, 0.5, 3))
    .multiply(new Matrix4().compose(new Vector3(1, 2, -1), new Quaternion().setFromEuler(new Euler(-0.2, 0.5, 0.8)), new Vector3(0.8, 1.2, 0.7)));
}
function around(pivot: Vector3, matrix: Matrix4) {
  return new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(matrix).multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
}
function expectVector(actual: Vector3, expected: Vector3) { expect(actual.distanceTo(expected)).toBeLessThan(1e-9); }

describe("mesh component selection resolution", () => {
  it("deduplicates shared edge/face vertices in stable authored order", () => {
    const { shape } = fixture(), edge = meshEdges(shape)[0], selectedFaces = edge.faceIds;
    const expected = new Set(shape.faces.filter(face => selectedFaces.includes(face.id)).flatMap(face => face.vertices));
    const resolved = resolveMeshComponentVertices(shape, "face", [...selectedFaces].reverse());
    expect(resolved).toEqual(shape.vertices.filter(vertex => expected.has(vertex.id)).map(vertex => vertex.id)); expect(resolved).toHaveLength(6);
    const neighboring = meshEdges(shape).filter(candidate => candidate.vertices.includes(edge.vertices[0])).slice(0, 2);
    expect(resolveMeshComponentVertices(shape, "edge", neighboring.map(candidate => candidate.id))).toHaveLength(3);
    const repeated = [shape.vertices[2].id, shape.vertices[0].id, shape.vertices[2].id];
    expect(resolveMeshComponentVertices(shape, "vertex", repeated)).toEqual([shape.vertices[0].id, shape.vertices[2].id]);
  });
  it("computes the centroid of unique selected vertices rather than repeated face corners", () => {
    const { shape } = fixture(), edge = meshEdges(shape)[0], world = nestedWorld();
    const capture = captureMeshComponentTransform(shape, "face", edge.faceIds, world);
    const mean = new Vector3(); for (const id of capture.vertexIds) mean.add(new Vector3(...shape.vertices.find(vertex => vertex.id === id)!.position).applyMatrix4(world)); mean.divideScalar(capture.vertexIds.length);
    expectVector(capture.pivot, mean); expect(capture.baseline).toHaveLength(6);
  });
  it("rejects empty, missing, malformed or oversized component selections", () => {
    const { shape } = fixture();
    expect(() => resolveMeshComponentVertices(shape, "vertex", [])).toThrow(/Select mesh components/);
    expect(() => resolveMeshComponentVertices(shape, "vertex", ["missing"])).toThrow(/no longer exists/);
    expect(() => resolveMeshComponentVertices(shape, "face", ["missing"])).toThrow(/no longer exists/);
    expect(() => resolveMeshComponentVertices(shape, "vertex", ["__proto__"])).toThrow(/Malformed/);
    expect(() => resolveMeshComponentVertices(shape, "edge", ["not-json"])).toThrow(/Malformed/);
    expect(() => resolveMeshComponentVertices(shape, "edge", ['["b","a"]'])).toThrow(/Malformed/);
    expect(() => resolveMeshComponentVertices(shape, "edge", ['[ "a", "b" ]'])).toThrow(/Malformed/);
    expect(() => resolveMeshComponentVertices(shape, "edge", ['["a","b"]'])).toThrow(/no longer exists/);
    expect(() => resolveMeshComponentVertices(shape, "vertex", Array(20001).fill(shape.vertices[0].id))).toThrow(/20,000/);
    expect(() => resolveMeshComponentVertices(shape, "wrong" as any, [shape.vertices[0].id])).toThrow(/component mode/);
  });
  it("permits a legal face selection resolving to more than 20,000 unique vertices", () => {
    const shape: MeshShapeNode = { id: "shape", type: "meshShape", name: "many", parentId: "parent", color: "#ffffff", shading: "flat", wireframe: false,
      vertices: Array.from({ length: 20004 }, (_, index) => ({ id: `v${index}`, position: [index, 0, 0] as Vec3 })),
      faces: Array.from({ length: 6668 }, (_, index) => ({ id: `f${index}`, vertices: [0, 1, 2].map(offset => `v${index * 3 + offset}`) })) };
    expect(resolveMeshComponentVertices(shape, "face", shape.faces.map(face => face.id))).toHaveLength(20004);
  });
});

describe("captured world-space component transforms", () => {
  it("moves selected vertices correctly through nested nonuniform scales and shear", () => {
    const { shape } = fixture(), world = nestedWorld(), selected = shape.faces[0].vertices;
    const capture = captureMeshComponentTransform(shape, "vertex", selected, world), delta = new Matrix4().makeTranslation(2, -3, 1);
    const changed = capture.changes(delta), inverse = world.clone().invert();
    for (const vertex of changed) {
      const original = new Vector3(...shape.vertices.find(candidate => candidate.id === vertex.id)!.position);
      expectVector(new Vector3(...vertex.position), original.applyMatrix4(world).applyMatrix4(delta).applyMatrix4(inverse));
    }
  });
  it("rotates around the world centroid under a sheared parent without changing world distances", () => {
    const { shape } = fixture(), world = nestedWorld(), capture = captureMeshComponentTransform(shape, "face", [shape.faces[0].id], world);
    const delta = around(capture.pivot, new Matrix4().makeRotationAxis(new Vector3(1, 2, 3).normalize(), 1.2)), changed = capture.changes(delta), mean = new Vector3();
    for (const vertex of changed) {
      const before = new Vector3(...shape.vertices.find(candidate => candidate.id === vertex.id)!.position).applyMatrix4(world), after = new Vector3(...vertex.position).applyMatrix4(world);
      expectVector(after, before.clone().applyMatrix4(delta)); expect(after.distanceTo(capture.pivot)).toBeCloseTo(before.distanceTo(capture.pivot), 10); mean.add(after);
    }
    expectVector(mean.divideScalar(changed.length), capture.pivot);
  });
  it("applies world-axis scaling and reflection without decomposing or losing shear", () => {
    const { shape } = fixture(), world = nestedWorld(), capture = captureMeshComponentTransform(shape, "vertex", shape.vertices.map(vertex => vertex.id), world);
    const delta = around(capture.pivot, new Matrix4().makeScale(2, 0.5, -1));
    for (const vertex of capture.changes(delta)) {
      const before = new Vector3(...shape.vertices.find(candidate => candidate.id === vertex.id)!.position).applyMatrix4(world);
      expectVector(new Vector3(...vertex.position).applyMatrix4(world), before.applyMatrix4(delta));
    }
  });
  it("keeps immutable baselines across repeated previews and caller mutations", () => {
    const { shape } = fixture(), world = nestedWorld(), original = shape.vertices[0].position.slice(), capture = captureMeshComponentTransform(shape, "vertex", [shape.vertices[0].id], world);
    const delta = new Matrix4().makeTranslation(1, 2, 3), expected = capture.changes(delta);
    expect(Object.isFrozen(capture.baseline)).toBe(true); expect(Object.isFrozen(capture.baseline[0].position)).toBe(true); expect(Object.isFrozen(capture.vertexIds)).toBe(true);
    expect(() => (capture.baseline[0].position as number[])[0] = 99).toThrow();
    world.identity(); shape.vertices[0].position[0] = 50; expected[0].position[0] = 500; capture.pivot.set(500, 500, 500);
    expect(capture.changes(new Matrix4())[0].position).toEqual(original);
    expect(capture.changes(delta)).toEqual(capture.changes(delta)); expect(capture.changes(delta)[0].position[0]).not.toBe(500);
  });
  it("leaves documents and unselected vertices unchanged and makes identity changes an exact no-op", () => {
    const { store, shape } = fixture(), before = store.getState().document, selected = shape.vertices[0], unselected = shape.vertices[1];
    const capture = captureMeshComponentTransform(shape, "vertex", [selected.id], nestedWorld());
    const preview = capture.changes(new Matrix4().makeTranslation(0.1, 0.2, 0.3)); expect(store.getState().document).toBe(before); expect(shape.vertices[0]).toBe(selected);
    setMeshVertexPositions(store, shape.id, capture.changes(new Matrix4())); expect(store.getState().document).toBe(before);
    setMeshVertexPositions(store, shape.id, preview); const updated = findMeshShape(store.getState().document, shape.id)!;
    expect(updated.vertices.find(vertex => vertex.id === unselected.id)).toBe(unselected); expect(shape.vertices[0]).toBe(selected);
  });
  it("accepts very small invertible scales and rejects singular, nonfinite or projective matrices", () => {
    const { shape } = fixture(), ids = [shape.vertices[0].id], small = new Matrix4().makeScale(1e-6, 1e-6, 1e-6);
    const capture = captureMeshComponentTransform(shape, "vertex", ids, small);
    expect(capture.changes(new Matrix4().makeTranslation(1e-6, 0, 0))[0].position[0]).toBeCloseTo(shape.vertices[0].position[0] + 1, 10);
    const projective = new Matrix4(); projective.elements[3] = 0.1;
    const nonfinite = new Matrix4(); nonfinite.elements[4] = Infinity;
    for (const bad of [new Matrix4().makeScale(0, 1, 1), projective, nonfinite]) {
      expect(() => captureMeshComponentTransform(shape, "vertex", ids, bad)).toThrow(); expect(() => capture.changes(bad)).toThrow();
    }
  });
  it("rejects out-of-bounds or nonfinite results atomically without damaging the baseline", () => {
    const { shape } = fixture(), capture = captureMeshComponentTransform(shape, "vertex", shape.vertices.map(vertex => vertex.id), new Matrix4());
    expect(() => capture.changes(new Matrix4().makeTranslation(1000001, 0, 0))).toThrow(/within ±1,000,000/);
    expect(capture.changes(new Matrix4()).map(vertex => vertex.position)).toEqual(shape.vertices.map(vertex => vertex.position));
    const invalid = structuredClone(shape); invalid.vertices[0].position[0] = NaN;
    expect(() => captureMeshComponentTransform(invalid, "vertex", [invalid.vertices[0].id], new Matrix4())).toThrow(/finite/);
    invalid.vertices[0].position[0] = 1000001; expect(() => captureMeshComponentTransform(invalid, "vertex", [invalid.vertices[0].id], new Matrix4())).toThrow(/within/);
    invalid.vertices[0].position = new Array(3) as Vec3;
    expect(() => captureMeshComponentTransform(invalid, "vertex", [invalid.vertices[0].id], new Matrix4())).toThrow(/finite/);
  });
});
