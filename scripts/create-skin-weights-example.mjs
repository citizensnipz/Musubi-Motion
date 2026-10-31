// Run with node scripts/create-skin-weights-example.mjs from the repository root.
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { Matrix4 } from "three";
const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
let mesh;
try {
  const { emptyScene, addSplat } = await server.ssrLoadModule("/src/scene-document.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { makeDemo, prepareSplat } = await server.ssrLoadModule("/src/splat-assets.ts");
  const { createSkinWeightLookup, editSkinWeight } = await server.ssrLoadModule("/src/skin-weights.ts");
  const { setKeys, setAnimationSettings } = await server.ssrLoadModule("/src/animation.ts");
  const { encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const asset = { id: "skin-study-asset", kind: "procedural", generator: "knot-v1" };
  const doc = addSplat(emptyScene(), asset, "Skin study", [0, 0, 0], "skin-study", "skin-study-shape").document;
  doc.joints = [
    { id: "skin-root", name: "Root", parentId: null, position: [-1, 0, 0] },
    { id: "skin-middle", name: "Middle", parentId: "skin-root", position: [1, 0, 0] },
    { id: "skin-tip", name: "Tip", parentId: "skin-middle", position: [1, 0, 0] },
  ];
  const binding = { jointIds: doc.joints.map(joint => joint.id),
    restMatrices: [-1, 0, 1].map(x => new Matrix4().makeTranslation(x, 0, 0).toArray()) };
  doc.nodes["skin-study-shape"].binding = binding;
  mesh = makeDemo(); await prepareSplat(mesh);
  const lookup = createSkinWeightLookup(binding), store = createSceneStore(doc);
  editSkinWeight(store, "skin-study-shape", Array.from({ length: 512 }, (_, index) => index), "skin-tip", .85,
    { count: mesh.numSplats, getWeights: index => lookup(index, mesh.extSplats.getSplat(index).center.toArray()) });
  setAnimationSettings(store, { end: 48 });
  for (const [frame, angle] of [[0, 0], [24, 60], [48, 0]]) {
    setKeys(store, ["skin-middle"], frame, new Map([["skin-middle", {
      position: [1, 0, 0], rotation: [0, 0, angle], scale: [1, 1, 1],
    }]]), ["rotation.z"]);
  }
  const bytes = await encodeProject(store.getState().document, new Map(), {
    camera: { position: [5, 3, 8], target: [0, .5, 0], fov: 42, near: .01, far: 1000 }, time: 0,
  });
  await mkdir("examples", { recursive: true });
  await writeFile("examples/skin-weights-study.msb", bytes);
  console.log(`Wrote skin-weights-study.msb (${mesh.numSplats} original components, 512 overrides, ${bytes.length} bytes).`);
} finally { mesh?.dispose(); await server.close(); }
