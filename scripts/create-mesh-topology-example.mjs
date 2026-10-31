// Run with node scripts/create-mesh-topology-example.mjs from the repository root.
// The dissolved cube also reverses every face loop. DoubleSide rendering means
// that its appearance may not differ, but the reversed winding persists in MSB.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Vector3 } from "three";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { createMeshPrimitive, findMeshShape, meshEdges, updateMeshAppearance } = await server.ssrLoadModule("/src/mesh-modeling.ts");
  const { deleteMeshEdges } = await server.ssrLoadModule("/src/mesh-edge-delete.ts");
  const { mergeMeshVerticesToCenter } = await server.ssrLoadModule("/src/mesh-merge.ts");
  const { reverseMeshNormals } = await server.ssrLoadModule("/src/mesh-normals.ts");
  const { encodeProject, decodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const store = createSceneStore();
  const objects = [
    { name: "Original cube", position: [-2, 0, 0], color: "#9daab5", vertices: 8, faces: 6, edges: 12 },
    { name: "Dissolved cube", position: [0, 0, 0], color: "#b4a891", vertices: 8, faces: 5, edges: 11 },
    { name: "Merged pyramid", position: [2, 0, 0], color: "#96aa9a", vertices: 5, faces: 5, edges: 8 },
  ].map(spec => {
    const id = createMeshPrimitive(store, "cube", { name: spec.name, position: spec.position, color: spec.color, size: 1.2 });
    const shape = findMeshShape(store.getState().document, id);
    updateMeshAppearance(store, shape.id, { wireframe: true });
    return { ...spec, id, shapeId: shape.id };
  });

  function normal(shape, face) {
    const vertices = new Map(shape.vertices.map(vertex => [vertex.id, new Vector3(...vertex.position)]));
    const [a, b, c] = face.vertices.slice(0, 3).map(id => vertices.get(id));
    return new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
  }
  const dissolved = findMeshShape(store.getState().document, objects[1].id);
  const top = dissolved.faces.find(face => normal(dissolved, face).y > .99);
  const right = dissolved.faces.find(face => normal(dissolved, face).x > .99);
  assert.ok(top && right, "Cube has +Y and +X faces");
  const shared = meshEdges(dissolved).find(edge => edge.faceIds.includes(top.id) && edge.faceIds.includes(right.id));
  assert.ok(shared, "Top and right faces share an edge");
  deleteMeshEdges(store, dissolved.id, [shared.id]);
  const beforeReverse = findMeshShape(store.getState().document, dissolved.id);
  assert.equal(beforeReverse.faces.filter(face => face.vertices.length === 6).length, 1);
  const reversed = reverseMeshNormals(store, dissolved.id);
  assert.equal(reversed.length, 5);

  const pyramid = findMeshShape(store.getState().document, objects[2].id);
  const pyramidTop = pyramid.faces.find(face => normal(pyramid, face).y > .99);
  assert.ok(pyramidTop, "Cube has a +Y face to merge");
  const apex = mergeMeshVerticesToCenter(store, pyramid.id, pyramidTop.vertices);
  const expectedApex = pyramidTop.vertices.map(id => pyramid.vertices.find(vertex => vertex.id === id).position)
    .reduce((sum, position) => sum.add(new Vector3(...position)), new Vector3()).divideScalar(pyramidTop.vertices.length);

  const bytes = await encodeProject(store.getState().document, new Map(), {
    camera: { position: [5, 3, 8], target: [0, 0, 0], fov: 42, near: .01, far: 1000 }, time: 0,
  });
  await mkdir("examples", { recursive: true });
  const destination = "examples/mesh-topology-study.msb";
  await writeFile(destination, bytes);
  const opened = await decodeProject(new Uint8Array(await readFile(destination)));
  assert.equal(opened.scene.rootIds.length, 3);
  const stats = objects.map(spec => {
    const shape = findMeshShape(opened.scene, spec.id);
    assert.ok(shape, `${spec.name} is present in the decoded archive`);
    assert.equal(shape.vertices.length, spec.vertices); assert.equal(shape.faces.length, spec.faces); assert.equal(meshEdges(shape).length, spec.edges);
    assert.deepEqual(opened.scene.nodes[spec.id].position, spec.position); assert.equal(shape.wireframe, true); assert.equal(shape.color, spec.color);
    return `${spec.name}: ${shape.vertices.length} vertices / ${shape.faces.length} faces / ${meshEdges(shape).length} edges`;
  });
  const reopenedDissolved = findMeshShape(opened.scene, dissolved.id);
  assert.deepEqual(reopenedDissolved.faces, beforeReverse.faces.map(face => ({ ...face, vertices: [...face.vertices].reverse() })));
  assert.equal(reopenedDissolved.faces.filter(face => face.vertices.length === 6).length, 1);
  const reopenedPyramid = findMeshShape(opened.scene, pyramid.id);
  assert.deepEqual(reopenedPyramid.vertices.find(vertex => vertex.id === apex).position, expectedApex.toArray());
  assert.deepEqual(reopenedPyramid.faces.map(face => face.vertices.length).sort(), [3, 3, 3, 3, 4]);
  console.log(`Wrote and verified ${destination} (${bytes.length} bytes).\n${stats.join("\n")}`);
} finally { await server.close(); }
