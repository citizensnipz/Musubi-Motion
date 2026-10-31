// CPU-only shared-command benchmark: node scripts/benchmark-mesh-topology.mjs
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { meshEdges } = await server.ssrLoadModule("/src/mesh-modeling.ts");
  const { mergeMeshVerticesToCenter } = await server.ssrLoadModule("/src/mesh-merge.ts");
  const { deleteMeshEdges } = await server.ssrLoadModule("/src/mesh-edge-delete.ts");
  const { reverseMeshNormals } = await server.ssrLoadModule("/src/mesh-normals.ts");
  const statistics = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: +sorted[2].toFixed(3), minMs: +sorted[0].toFixed(3), maxMs: +sorted.at(-1).toFixed(3) };
  };
  const results = [];
  for (const size of [32, 100]) {
    // Same welded unit-square grid and winding as benchmark-mesh-modeling.mjs.
    const width = size + 1, vertices = [], faces = [];
    for (let z = 0; z <= size; z++) for (let x = 0; x <= size; x++) vertices.push({ id: `v${z * width + x}`, position: [x / size, 0, z / size] });
    for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
      const i = z * width + x;
      faces.push({ id: `f${z * size + x}`, vertices: [i, i + width, i + width + 1, i + 1].map(index => `v${index}`) });
    }
    const shape = { id: "shape", type: "meshShape", name: "GridShape", parentId: "object", vertices, faces, color: "#9aa8b8", shading: "flat", wireframe: true };
    const doc = emptyScene(); doc.rootIds.push("object");
    doc.nodes.object = { id: "object", type: "transform", name: "Grid", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
    doc.nodes.shape = shape;
    const interior = meshEdges(shape).find(edge => edge.faceIds.length === 2);
    if (!interior) throw Error("Benchmark grid needs an interior edge.");
    const commands = {
      mergeBoundaryVertices: store => mergeMeshVerticesToCenter(store, shape.id, [vertices[0].id, vertices[1].id]),
      deleteInteriorEdge: store => deleteMeshEdges(store, shape.id, [interior.id]),
      reverseAllNormals: store => reverseMeshNormals(store, shape.id),
    };
    const samples = Object.fromEntries(Object.keys(commands).map(name => [name, []]));
    for (let iteration = 0; iteration < 7; iteration++) {
      for (const [name, command] of Object.entries(commands)) {
        // Commands receive the identical immutable baseline in a fresh store.
        // Their validation, defensive topology copy and history commit are timed.
        const store = createSceneStore(doc), start = performance.now();
        command(store);
        const elapsed = performance.now() - start;
        if (store.getState().document === doc || store.temporal.getState().pastStates.length !== 1) throw Error(`${name} did not produce exactly one document commit.`);
        if (iteration >= 2) samples[name].push(elapsed);
      }
    }
    results.push({ vertices: vertices.length, faces: faces.length,
      ...Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, statistics(values)])) });
  }
  console.log(JSON.stringify({ node: process.version, warmups: 2, samples: 5, statistics: "median, minimum and maximum of five timed command calls",
    includes: "Shared command validation, topology copying and undo-history commit on a fresh store",
    excludes: "Store creation, selection resolution outside the command, renderer preparation, UI callbacks, GPU upload and rendering; CPU only", results }, null, 2));
} finally { await server.close(); }
