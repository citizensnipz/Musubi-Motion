// CPU-only topology and component-preview benchmark: node scripts/benchmark-mesh-modeling.mjs
import { createServer } from "vite";
import { Matrix4, Vector3 } from "three";
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { validateMeshShape, triangulateMesh, extrudeMeshFaces } = await server.ssrLoadModule("/src/mesh-modeling.ts");
  const { createMeshRenderable } = await server.ssrLoadModule("/src/mesh-renderer.ts");
  const { captureMeshComponentTransform } = await server.ssrLoadModule("/src/mesh-component-transform.ts");
  const statistics = values => {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return { medianMs: +median.toFixed(3), p95Ms: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(3) };
  };
  const results = [];
  for (const size of [32, 100]) {
    const width = size + 1, vertices = [], faces = [];
    for (let z = 0; z <= size; z++) for (let x = 0; x <= size; x++) vertices.push({ id: `v${z * width + x}`, position: [x / size, 0, z / size] });
    for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
      const i = z * width + x; faces.push({ id: `f${z * size + x}`, vertices: [i, i + width, i + width + 1, i + 1].map(i => `v${i}`) });
    }
    const shape = { id: "shape", type: "meshShape", name: "GridShape", parentId: "object", vertices, faces, color: "#9aa8b8", shading: "flat", wireframe: true };
    const doc = emptyScene(); doc.rootIds.push("object"); doc.nodes.object = { id: "object", type: "transform", name: "Grid", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" }; doc.nodes.shape = shape;
    const timings = [];
    for (let iteration = 0; iteration < 7; iteration++) {
      const store = createSceneStore(doc), start = performance.now(); validateMeshShape(shape); const validated = performance.now();
      triangulateMesh(shape); const triangulated = performance.now();
      const rendered = createMeshRenderable(shape), prepared = performance.now();
      extrudeMeshFaces(store, shape.id, faces.map(face => face.id), .25); const extruded = performance.now();
      rendered.dispose();
      if (iteration >= 2) timings.push([validated - start, triangulated - validated, prepared - triangulated, extruded - prepared]);
    }
    const median = column => +timings.map(row => row[column]).sort((a, b) => a - b)[2].toFixed(2);
    const selectedFaces = faces.map(face => face.id), captureTimings = [], previewTimings = [];
    const world = new Matrix4().makeRotationY(.35).scale(new Vector3(2, 3, 1.5)).setPosition(2, 1, -3);
    let snapshot;
    for (let iteration = 0; iteration < 35; iteration++) {
      const start = performance.now();
      snapshot = captureMeshComponentTransform(shape, "face", selectedFaces, world);
      if (iteration >= 5) captureTimings.push(performance.now() - start);
    }
    // One committed renderer and one captured gesture are reused throughout all
    // preview samples. Creation, capture and cleanup are outside frame timings.
    const renderer = createMeshRenderable(shape), deltaWorld = new Matrix4();
    try {
      for (let iteration = 0; iteration < 35; iteration++) {
        deltaWorld.makeTranslation(iteration / 100, .25 + iteration / 200, -iteration / 300);
        const start = performance.now(), changes = snapshot.changes(deltaWorld), converted = performance.now();
        renderer.previewVertices(changes); const previewed = performance.now();
        if (iteration >= 5) previewTimings.push([converted - start, previewed - converted, previewed - start]);
      }
    } finally { renderer.dispose(); }
    results.push({ vertices: vertices.length, faces: faces.length, validateMs: median(0), triangulateMs: median(1), prepareRendererMs: median(2), extrudeCommandMs: median(3),
      componentPreview: { selectedFaces: selectedFaces.length, selectedVertices: snapshot.vertexIds.length,
        capture: statistics(captureTimings), worldToLocalChanges: statistics(previewTimings.map(row => row[0])),
        rendererPreview: statistics(previewTimings.map(row => row[1])), totalPerFrame: statistics(previewTimings.map(row => row[2])) } });
  }
  console.log(JSON.stringify({ node: process.version, topology: { samples: 5, warmups: 2 }, componentPreview: { samples: 30, warmups: 5, rendererReused: true }, results,
    excludes: "Selection overlays, editor callbacks, browser scheduling, GPU upload and rendering; CPU only" }, null, 2));
} finally { await server.close(); }
