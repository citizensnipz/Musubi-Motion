// Rebuild the mixed FX scene with node scripts/create-particle-example.mjs.
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { emptyScene, addSplat } = await server.ssrLoadModule("/src/scene-document.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { createMeshPrimitive, findMeshShape, updateMeshAppearance } = await server.ssrLoadModule("/src/mesh-modeling.ts");
  const { createController } = await server.ssrLoadModule("/src/controller-curves.ts");
  const { createParticleEmitter, findParticleShape, updateParticleEmitter } = await server.ssrLoadModule("/src/particle-emitter.ts");
  const { evaluateSceneAnimation, setKeys, setAnimationSettings } = await server.ssrLoadModule("/src/animation.ts");
  const { encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const store = createSceneStore(emptyScene());
  createMeshPrimitive(store, "plane", { name: "Ground", size: 6, position: [0, -.1, 0], color: "#48515a" });
  const sphere = createMeshPrimitive(store, "sphere", { name: "Surface source", size: .7, position: [1.2, .8, 0], color: "#66717d" });
  const source = findMeshShape(store.getState().document, sphere); updateMeshAppearance(store, source.id, { shading: "smooth" });
  const fountain = createParticleEmitter(store, "directional", { name: "Moving fountain", position: [-2, 0, 0] });
  updateParticleEmitter(store, findParticleShape(store.getState().document, fountain).id, {
    rate: 100, lifetime: 3, endFrame: 120, speed: 3, speedRandom: .4, spread: .08,
    acceleration: [0, -2, 0], drag: .1, sizes: [.05, .015], colors: ["#c5d6e4", "#668197"],
    attraction: { position: [-1, 1, 0], strength: .5, radius: 3 },
  });
  const surface = createParticleEmitter(store, "surface", { name: "Surface mist", surfaceId: source.id });
  updateParticleEmitter(store, findParticleShape(store.getState().document, surface).id, {
    rate: 150, lifetime: 2, speed: .6, speedRandom: .15, spread: .1,
    acceleration: [0, 0, 0], drag: .4, sizes: [.025, .008], colors: ["#e0d9c9", "#8f8474"],
    turbulence: { strength: .25, scale: .7 },
  });
  const volume = createParticleEmitter(store, "box", { name: "Volume rain", position: [0, 2.6, -1.5] });
  updateParticleEmitter(store, findParticleShape(store.getState().document, volume).id, {
    rate: 100, lifetime: 3, speed: .4, speedRandom: .1, spread: .1, direction: [0, -1, 0], volume: [3, .1, 1],
    acceleration: [0, -1, 0], sizes: [.025, .01], colors: ["#bfc4cb", "#7c8590"], opacities: [.6, 0],
  });
  createController(store, "circle", { name: "Fountain guide", plane: "XZ", size: .5, position: [-2, -.05, 0], color: "#9aa8b8" });
  const mixed = addSplat(store.getState().document, { id: "particle-knot", kind: "procedural", generator: "knot-v1" }, "Splat reference", [0, 0, 0]);
  mixed.document.nodes[mixed.id].position = [2.2, .6, -2]; mixed.document.nodes[mixed.id].scale = [.25, .25, .25]; store.setState({ document: mixed.document });
  setAnimationSettings(store, { end: 192 });
  for (const [frame, x] of [[0, -2], [48, -.8], [96, -2], [192, -2]]) {
    const poses = evaluateSceneAnimation(store.getState().document, frame); poses.get(fountain).position[0] = x;
    setKeys(store, [fountain], frame, poses, ["position.x"]);
  }
  const bytes = await encodeProject(store.getState().document, new Map(), {
    camera: { position: [7, 4, 10], target: [0, .9, 0], fov: 42, near: .01, far: 1000 }, time: 2,
  });
  await mkdir("examples", { recursive: true }); await writeFile("examples/particle-study.msb", bytes);
  console.log(`Wrote particle-study.msb (${bytes.length} bytes).`);
} finally { await server.close(); }
