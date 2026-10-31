// CPU-only topology benchmark: node scripts/benchmark-mesh-modeling.mjs
import { createServer } from "vite";
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { validateMeshShape, triangulateMesh, extrudeMeshFaces } = await server.ssrLoadModule("/src/mesh-modeling.ts");
  const { createMeshRenderable } = await server.ssrLoadModule("/src/mesh-renderer.ts");
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
    results.push({ vertices: vertices.length, faces: faces.length, validateMs: median(0), triangulateMs: median(1), prepareRendererMs: median(2), extrudeCommandMs: median(3) });
  }
  console.log(JSON.stringify({ samples: 5, warmups: 2, results, excludes: "GPU upload/rendering, browser scheduling, and editor callbacks" }, null, 2));
} finally { await server.close(); }
