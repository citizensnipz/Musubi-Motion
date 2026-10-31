import { describe, expect, it } from "vitest";
import { ShapeUtils, Vector2, Vector3 } from "three";
import { createMeshPrimitive, findMeshShape, setMeshTopology, triangulateMesh, validateMeshShape } from "../src/mesh-modeling.ts";
import { createSceneStore } from "../src/scene-store.ts";
import type { MeshShapeNode, Vec3 } from "../src/scene-document.ts";

function fixture() {
  const store = createSceneStore(), id = createMeshPrimitive(store, "plane", { color: "#2468ac", position: [3, 4, 5] }), shape = findMeshShape(store.getState().document, id)!;
  return { store, shape, id };
}
function topology(shape: MeshShapeNode) { return structuredClone({ vertices: shape.vertices, faces: shape.faces }); }
function polygon(shape: MeshShapeNode, positions: Vec3[]): MeshShapeNode {
  return { ...shape, vertices: positions.map((position, index) => ({ id: `v${index}`, position })), faces: [{ id: "polygon", vertices: positions.map((_, index) => `v${index}`) }] };
}

describe("shared mesh topology replacement", () => {
  it("copies caller-owned topology at every mutable level while preserving owning metadata", () => {
    const { store, shape, id } = fixture(), before = store.getState().document, replacement = topology(shape);
    replacement.vertices[0].position[0] += .2;
    const expected = structuredClone(replacement);
    setMeshTopology(store, shape.id, replacement, "Topology fixture edit");
    const committed = findMeshShape(store.getState().document, shape.id)!;
    expect(committed).toEqual({ ...shape, ...expected }); expect(store.getState().document.nodes[id]).toBe(before.nodes[id]);
    expect(committed.vertices).not.toBe(replacement.vertices); expect(committed.faces).not.toBe(replacement.faces);
    expect(committed.vertices[0]).not.toBe(replacement.vertices[0]); expect(committed.vertices[0].position).not.toBe(replacement.vertices[0].position);
    expect(committed.faces[0]).not.toBe(replacement.faces[0]); expect(committed.faces[0].vertices).not.toBe(replacement.faces[0].vertices);
    replacement.vertices[0].id = "changed"; replacement.vertices[0].position[0] = 999;
    replacement.faces[0].id = "changed-face"; replacement.faces[0].vertices.reverse(); replacement.vertices.length = 0; replacement.faces.length = 0;
    expect(committed).toEqual({ ...shape, ...expected }); expect(before.nodes[shape.id]).toEqual(shape);
    expect(store.getState().editLabel).toBe("Topology fixture edit");
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(findMeshShape(store.getState().document, shape.id)).toBe(committed);
  });

  it("preserves document identity, undo history and pending redo for an equal replacement", () => {
    const { store, shape } = fixture(), original = store.getState().document, replacement = topology(shape);
    replacement.vertices[0].position[0] += .2; setMeshTopology(store, shape.id, replacement);
    const edited = store.getState().document; store.temporal.getState().undo();
    const past = store.temporal.getState().pastStates.length, future = store.temporal.getState().futureStates.length, label = store.getState().editLabel;
    setMeshTopology(store, shape.id, topology(shape), "Should not enter history");
    expect(store.getState().document).toBe(original); expect(store.getState().editLabel).toBe(label);
    expect(store.temporal.getState().pastStates).toHaveLength(past); expect(store.temporal.getState().futureStates).toHaveLength(future);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(edited);
  });

  it("rejects malformed arrays, sparse coordinates and invalid faces without touching history or geometry", () => {
    const { store, shape, id } = fixture(), before = store.getState().document, history = store.temporal.getState().pastStates.length;
    const originalTriangulation = triangulateMesh(shape);
    const cases: unknown[] = [null, {}, { vertices: {}, faces: [] }, { vertices: [], faces: {} }];
    for (const value of [NaN, Infinity, 1000001, undefined]) {
      const bad = topology(shape); bad.vertices[0].position[0] = value as number; cases.push(bad);
    }
    const sparsePosition = topology(shape); delete (sparsePosition.vertices[0].position as number[])[1]; cases.push(sparsePosition);
    const sparseVertices = topology(shape); delete sparseVertices.vertices[0]; cases.push(sparseVertices);
    const sparseLoop = topology(shape); delete sparseLoop.faces[0].vertices[1]; cases.push(sparseLoop);
    const missing = topology(shape); missing.faces[0].vertices[0] = "missing"; cases.push(missing);
    const duplicate = topology(shape); duplicate.vertices[1].id = duplicate.vertices[0].id; cases.push(duplicate);
    const zeroArea = topology(shape); zeroArea.vertices.forEach(vertex => { vertex.position = [0, 0, 0]; }); cases.push(zeroArea);
    for (const replacement of cases) {
      expect(() => setMeshTopology(store, shape.id, replacement as Parameters<typeof setMeshTopology>[2])).toThrow();
      expect(store.getState().document).toBe(before); expect(store.temporal.getState().pastStates).toHaveLength(history);
      expect(triangulateMesh(findMeshShape(before, shape.id)!)).toEqual(originalTriangulation);
    }
    expect(() => setMeshTopology(store, id, topology(shape))).toThrow(/polygon mesh/);
    expect(() => setMeshTopology(store, "missing", topology(shape))).toThrow(/polygon mesh/);
    expect(store.getState().document).toBe(before);
  });

  it("keeps the existing dominant-plane tessellation for a valid concave polygon", () => {
    const { store, shape } = fixture();
    const points: Vec3[] = [[0, 0, 0], [3, 0, 0], [3, 3, 0], [1.5, 1, 0], [0, 3, 0]];
    const next = polygon(shape, points);
    // This is the previous triangulation contract for a valid XY projection.
    const expected = ShapeUtils.triangulateShape(points.map(([x, y]) => new Vector2(x, y)), []).flat();
    setMeshTopology(store, shape.id, topology(next));
    const committed = findMeshShape(store.getState().document, shape.id)!;
    expect(triangulateMesh(committed).indices).toEqual(expected);
    expect(triangulateMesh(committed).triangleFaceIds).toEqual(Array(points.length - 2).fill("polygon"));
  });

  it("triangulates a bent six-sided shell boundary whose coordinate-axis projection collapses", () => {
    const { store, shape } = fixture();
    // Boundary of adjacent +Y/+X cube faces after their shared edge is dissolved.
    const points: Vec3[] = [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, -1, 1], [1, -1, -1], [1, 1, -1]];
    expect(new Set(points.map(([x, , z]) => `${x},${z}`)).size).toBeLessThan(points.length);
    const next = polygon(shape, points); setMeshTopology(store, shape.id, topology(next));
    const committed = findMeshShape(store.getState().document, shape.id)!, triangles = triangulateMesh(committed);
    expect(committed.vertices).toEqual(next.vertices); expect(committed.faces).toEqual(next.faces); expect(() => validateMeshShape(committed)).not.toThrow();
    expect(triangles.indices).toHaveLength(12); expect(triangles.triangleFaceIds).toEqual(Array(4).fill("polygon"));
    const meanNormal = new Vector3(1, 1, 0).normalize();
    for (let index = 0; index < triangles.indices.length; index += 3) {
      const [a, b, c] = triangles.indices.slice(index, index + 3).map(vertex => new Vector3().fromArray(triangles.positions, vertex * 3));
      const normal = new Vector3().crossVectors(b.sub(a), c.sub(a));
      expect(normal.length()).toBeGreaterThan(0); expect(normal.dot(meanNormal)).toBeGreaterThan(0);
    }
    expect(triangulateMesh(committed)).toEqual(triangles);
  });

  it("does not rescue genuinely self-crossing planar faces with the projection fallback", () => {
    const { store, shape } = fixture(), before = store.getState().document;
    // Unequal lobes ensure nonzero signed area, exercising intersection checks.
    const crossed = polygon(shape, [[0, 0, 0], [3, 2, 0], [0, 2, 0], [2, 0, 0]]);
    expect(() => setMeshTopology(store, shape.id, topology(crossed))).toThrow(/self-intersects|folds/);
    expect(store.getState().document).toBe(before);
  });
});
