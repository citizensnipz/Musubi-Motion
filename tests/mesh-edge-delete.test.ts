import { describe, expect, it } from "vitest";
import { deleteMeshEdges } from "../src/mesh-edge-delete.ts";
import { createMeshPrimitive, findMeshShape, meshEdges, triangulateMesh, validateMeshShape } from "../src/mesh-modeling.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { emptyScene, type MeshShapeNode, type Vec3 } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function grid(width = 2, height = 1): MeshShapeNode {
  const stride = width + 1;
  return { id: "shape", type: "meshShape", name: "GridShape", parentId: "object", color: "#8090a0", shading: "flat", wireframe: true,
    vertices: Array.from({ length: stride * (height + 1) }, (_, i) => ({ id: `v${i}`, position: [i % stride, Math.floor(i / stride), 0] as Vec3 })),
    faces: Array.from({ length: width * height }, (_, i) => {
      const a = Math.floor(i / width) * stride + i % width;
      return { id: `f${i}`, vertices: [a, a + 1, a + stride + 1, a + stride].map(index => `v${index}`) };
    }) };
}
function fixture(shape = grid()) {
  validateMeshShape(shape);
  const doc = emptyScene(); doc.rootIds.push("object");
  doc.nodes.object = { id: "object", type: "transform", name: "Grid", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
  doc.nodes[shape.id] = shape;
  return { shape, store: createSceneStore(doc) };
}
function inside(shape: MeshShapeNode, faceIds = shape.faces.map(face => face.id)): string[] {
  const requested = new Set(faceIds);
  return meshEdges(shape).filter(edge => edge.faceIds.length === 2 && edge.faceIds.every(id => requested.has(id))).map(edge => edge.id);
}
function current(store: ReturnType<typeof createSceneStore>, id = "shape") { return store.getState().document.nodes[id] as MeshShapeNode; }
function unchangedAfterFailure(store: ReturnType<typeof createSceneStore>, operation: () => unknown, message: RegExp) {
  const before = store.getState().document, serialized = JSON.stringify(before), history = store.temporal.getState().pastStates.length;
  expect(operation).toThrow(message);
  expect(store.getState().document).toBe(before); expect(JSON.stringify(before)).toBe(serialized); expect(store.temporal.getState().pastStates).toHaveLength(history);
}

describe("Delete Edge polygon command", () => {
  it("merges adjacent faces, preserves boundary vertices and commits exactly one undo step", () => {
    const { shape, store } = fixture(), before = store.getState().document, selected = inside(shape);
    const result = deleteMeshEdges(store, shape.id, selected), edited = current(store);
    expect(result).toEqual([shape.faces[0].id]); expect(edited.faces).toHaveLength(1); expect(edited.faces[0].vertices).toHaveLength(6);
    expect(edited.vertices).toEqual(shape.vertices); expect(new Set(edited.faces[0].vertices)).toEqual(new Set(shape.vertices.map(vertex => vertex.id)));
    expect(meshEdges(edited).some(edge => selected.includes(edge.id))).toBe(false); expect(triangulateMesh(edited).triangleFaceIds).toHaveLength(4);
    expect(store.getState().editLabel).toBe("Delete mesh edges"); expect(store.temporal.getState().pastStates).toHaveLength(1);
    const after = store.getState().document; store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
  });

  it("merges disconnected selections independently and chooses the first authored face in each group", () => {
    const shape = grid(5), originalFaces = [...shape.faces];
    shape.faces = [originalFaces[4], originalFaces[1], originalFaces[0], originalFaces[2], originalFaces[3]];
    const selected = [...inside(shape, ["f0", "f1"]), ...inside(shape, ["f3", "f4"])];
    const first = fixture(shape), second = fixture(structuredClone(shape));
    expect(deleteMeshEdges(first.store, shape.id, selected)).toEqual(["f4", "f1"]);
    expect(deleteMeshEdges(second.store, shape.id, [...selected].reverse())).toEqual(["f4", "f1"]);
    const result = current(first.store);
    expect(result.faces.map(face => face.id)).toEqual(["f4", "f1", "f2"]);
    expect(result.faces.find(face => face.id === "f2")).toEqual(originalFaces[2]); expect(result.vertices).toEqual(shape.vertices);
    expect(current(second.store)).toEqual(result);
  });

  it("dissolves one cube edge into a bent six-sided polygon while retaining all vertices", () => {
    const store = createSceneStore(), transform = createMeshPrimitive(store, "cube"), shape = findMeshShape(store.getState().document, transform)!;
    const edge = meshEdges(shape)[0], affected = new Set(edge.faceIds), first = shape.faces.find(face => affected.has(face.id))!;
    expect(deleteMeshEdges(store, shape.id, [edge.id])).toEqual([first.id]);
    const result = current(store, shape.id);
    expect(result.faces).toHaveLength(5); expect(result.faces.find(face => face.id === first.id)!.vertices).toHaveLength(6);
    expect(result.vertices).toEqual(shape.vertices); expect(meshEdges(result)).toHaveLength(11);
    for (const face of shape.faces.filter(face => !affected.has(face.id))) expect(result.faces.find(candidate => candidate.id === face.id)).toEqual(face);
    expect(() => validateMeshShape(result)).not.toThrow(); expect(triangulateMesh(result).triangleFaceIds.filter(id => id === first.id)).toHaveLength(4);
  });

  it("retains an unused interior vertex when an entire grid region becomes one face, including archive round trip", async () => {
    const { shape, store } = fixture(grid(2, 2));
    expect(deleteMeshEdges(store, shape.id, inside(shape))).toEqual(["f0"]);
    const result = current(store);
    expect(result.faces).toHaveLength(1); expect(result.faces[0].vertices).toHaveLength(8); expect(result.faces[0].vertices).not.toContain("v4");
    expect(result.vertices).toEqual(shape.vertices); expect(result.vertices.find(vertex => vertex.id === "v4")!.position).toEqual([1, 1, 0]);
    const editor = { camera: { position: [3, 2, 8] as Vec3, target: [0, 0, 0] as Vec3, fov: 42, near: .01, far: 1000 }, time: 0 };
    const decoded = await decodeProject(await encodeProject(store.getState().document, new Map(), editor));
    expect(decoded.scene.nodes[shape.id]).toEqual(result); expect(decoded.editor).toEqual(editor);
  });

  it("does not silently dissolve an unselected interior edge in a connected face group", () => {
    const { shape, store } = fixture(grid(2, 2)), selected = inside(shape);
    expect(selected).toHaveLength(4);
    unchangedAfterFailure(store, () => deleteMeshEdges(store, shape.id, selected.slice(0, 3)), /unselected interior edge/);
  });

  it("rejects ring regions with holes and regions with repeated boundary vertices", () => {
    const ring = fixture(grid(3, 3));
    unchangedAfterFailure(ring.store, () => deleteMeshEdges(ring.store, ring.shape.id, inside(ring.shape, ring.shape.faces.filter(face => face.id !== "f4").map(face => face.id))), /holes|multiple boundary/);
    // Omitting the centre and a diagonal corner leaves a pinched boundary: the
    // selected faces remain edge-connected, but meet twice at the same vertex.
    const pinched = fixture(grid(3, 3)), included = ["f0", "f1", "f2", "f3", "f5", "f6", "f7"];
    unchangedAfterFailure(pinched.store, () => deleteMeshEdges(pinched.store, pinched.shape.id, inside(pinched.shape, included)), /repeated boundary vertices/);
  });

  it("rejects closed shells and border edges without deleting their adjacent faces", () => {
    const cube = createSceneStore(), transform = createMeshPrimitive(cube, "cube"), shape = findMeshShape(cube.getState().document, transform)!;
    unchangedAfterFailure(cube, () => deleteMeshEdges(cube, shape.id, inside(shape)), /closed shell|no boundary/);
    const plane = fixture(), border = meshEdges(plane.shape).find(edge => edge.faceIds.length === 1)!;
    unchangedAfterFailure(plane.store, () => deleteMeshEdges(plane.store, plane.shape.id, [...inside(plane.shape), border.id]), /border edge/);
  });

  it("rejects dissolving five cube faces into an opposite-winding duplicate of the sixth", () => {
    for (let excluded = 0; excluded < 6; excluded++) {
      const store = createSceneStore(), transform = createMeshPrimitive(store, "cube"), shape = findMeshShape(store.getState().document, transform)!;
      const selectedFaces = shape.faces.filter((_, index) => index !== excluded).map(face => face.id), selected = inside(shape, selectedFaces);
      expect(selected).toHaveLength(8);
      unchangedAfterFailure(store, () => deleteMeshEdges(store, shape.id, selected), /duplicate faces/);
    }
  });

  it("rejects stale, malformed, empty and excessive selections atomically", () => {
    const { shape, store } = fixture(), selected = inside(shape);
    unchangedAfterFailure(store, () => deleteMeshEdges(store, shape.id, []), /at least one/);
    unchangedAfterFailure(store, () => deleteMeshEdges(store, shape.id, Array(20001).fill(selected[0])), /20,000/);
    for (const id of ["missing", JSON.stringify(JSON.parse(selected[0]).reverse()), "[not-json]"]) unchangedAfterFailure(store, () => deleteMeshEdges(store, shape.id, [selected[0], id]), /no longer exists/);
    unchangedAfterFailure(store, () => deleteMeshEdges(store, "object", selected), /polygon mesh/);
    deleteMeshEdges(store, shape.id, [selected[0], selected[0]]);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    unchangedAfterFailure(store, () => deleteMeshEdges(store, shape.id, selected), /no longer exists/);
  });

  it("rejects a merged polygon beyond the 64-corner limit without pruning vertices", () => {
    const { shape, store } = fixture(grid(32));
    unchangedAfterFailure(store, () => deleteMeshEdges(store, shape.id, inside(shape)), /64 corners/);
    expect(current(store).vertices).toHaveLength(66);
  });

  it("leaves all disconnected groups unchanged if a later group's candidate is invalid", () => {
    const good = grid(), ring = grid(3, 3);
    const badVertices = ring.vertices.map(vertex => ({ id: `ring-${vertex.id}`, position: [vertex.position[0] + 5, vertex.position[1], 0] as Vec3 }));
    const badFaces = ring.faces.map(face => ({ id: `ring-${face.id}`, vertices: face.vertices.map(id => `ring-${id}`) }));
    const shape = { ...good, vertices: [...good.vertices, ...badVertices], faces: [...good.faces, ...badFaces] }, data = fixture(shape);
    const selected = [...inside(shape, ["f0", "f1"]), ...inside(shape, badFaces.filter(face => face.id !== "ring-f4").map(face => face.id))];
    unchangedAfterFailure(data.store, () => deleteMeshEdges(data.store, shape.id, selected), /holes|multiple boundary/);
  });

  it("uses shared final geometry validation before committing a topologically valid boundary", () => {
    const shape = grid();
    // Each face is individually valid but folded back over the other. Their
    // merged outline has zero net area, which the shared validator rejects.
    shape.vertices = [
      { id: "a", position: [0, 0, 0] }, { id: "b", position: [1, 0, 0] }, { id: "c", position: [1, 1, 0] },
      { id: "d", position: [0, 1, 0] }, { id: "e", position: [0, 0, 0] }, { id: "f", position: [0, 1, 0] },
    ];
    shape.faces = [{ id: "first", vertices: ["a", "b", "c", "d"] }, { id: "second", vertices: ["b", "e", "f", "c"] }];
    const { store } = fixture(shape);
    unchangedAfterFailure(store, () => deleteMeshEdges(store, shape.id, inside(shape)), /area|fold|intersect/);
  });
});
