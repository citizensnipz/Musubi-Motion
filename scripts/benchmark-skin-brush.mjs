// Local CPU-only benchmark: node scripts/benchmark-skin-brush.mjs
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { unzipSync, strFromU8 } from "fflate";
import { Matrix4, PerspectiveCamera } from "three";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
let mesh, skin;
try {
  const { makeDemo, prepareSplat } = await server.ssrLoadModule("/src/splat-assets.ts");
  const { createBinding } = await server.ssrLoadModule("/src/splat-binding.ts");
  const { createSkinBrushIndex, createSkinBrushStroke } = await server.ssrLoadModule("/src/skin-weight-brush.ts");
  const archive = unzipSync(await readFile("examples/skin-weights-study.msb"));
  const { scene, editor } = JSON.parse(strFromU8(archive["scene.json"]));
  const binding = scene.nodes["skin-study-shape"].binding;
  mesh = makeDemo(); await prepareSplat(mesh);
  skin = createBinding(mesh, binding);
  const rest = new Map(binding.jointIds.map((id, index) => [id, new Matrix4().fromArray(binding.restMatrices[index])]));
  skin.update(id => rest.get(id));
  const view = editor.camera, width = 1290, height = 734;
  const camera = new PerspectiveCamera(view.fov, width / height, view.near, view.far);
  camera.position.fromArray(view.position); camera.lookAt(...view.target); camera.updateMatrixWorld(true);
  const scans = [], strokes = [];
  let affected = 0;
  for (let iteration = 0; iteration < 25; iteration++) {
    const started = performance.now();
    const index = await createSkinBrushIndex({ componentCount: skin.componentCount,
      readPositions: (offset, count) => skin.getComponentPositions(Array.from({ length: count }, (_, i) => offset + i)),
      matrixWorld: mesh.matrixWorld, camera, width, height, yieldTask: async () => {},
    });
    const projected = performance.now();
    const stroke = createSkinBrushStroke(index, { radius: 32, strength: 1, value: .2, mode: "replace",
      getWeight: i => skin.getWeights(i).find(row => row.jointId === "skin-tip")?.weight ?? 0,
    });
    stroke.addSegment({ x: 648.324, y: 295.381 }, { x: 698.324, y: 295.381 });
    affected = stroke.values().length;
    const finished = performance.now();
    if (iteration >= 5) { scans.push(projected - started); strokes.push(finished - projected); }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(JSON.stringify({ components: skin.componentCount, affected, samples: scans.length,
    medianProjectionAndIndexMs: +median(scans).toFixed(2), medianStrokeMs: +median(strokes).toFixed(2),
    excludes: "GPU rendering, browser scheduling, document command, binding rebuild, and elasticity",
  }, null, 2));
} finally { skin?.dispose(); mesh?.dispose(); await server.close(); }
