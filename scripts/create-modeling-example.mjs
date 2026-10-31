// Run with node scripts/create-modeling-example.mjs from the repository root.
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { emptyScene, addSplat } = await server.ssrLoadModule("/src/scene-document.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { createMeshPrimitive, findMeshShape, extrudeMeshFaces, updateMeshAppearance } = await server.ssrLoadModule("/src/mesh-modeling.ts");
  const { createController } = await server.ssrLoadModule("/src/controller-curves.ts");
  const { evaluateSceneAnimation, setKeys, setAnimationSettings } = await server.ssrLoadModule("/src/animation.ts");
  const { encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const store = createSceneStore(emptyScene());
  const cube = createMeshPrimitive(store, "cube", { name: "Extruded cube", size: 1.2, position: [-1.5, .2, 0] });
  const cubeShape = findMeshShape(store.getState().document, cube);
  extrudeMeshFaces(store, cubeShape.id, [cubeShape.faces[0].id, cubeShape.faces[2].id], .35);
  updateMeshAppearance(store, cubeShape.id, { wireframe: true });
  const sphere = createMeshPrimitive(store, "sphere", { name: "Smooth sphere", size: 1.25, position: [1.2, .2, 0], color: "#b6afa0" });
  updateMeshAppearance(store, findMeshShape(store.getState().document, sphere).id, { shading: "smooth" });
  createMeshPrimitive(store, "plane", { name: "Ground", size: 5, position: [0, -.6, 0], color: "#656d76" });
  createController(store, "circle", { name: "Curve control", plane: "XZ", size: .85, position: [1.2, -.55, 0] });
  const mixed = addSplat(store.getState().document, { id: "modeling-knot", kind: "procedural", generator: "knot-v1" }, "Splat reference", [0, 0, 0]);
  mixed.document.nodes[mixed.id].position = [0, .2, -2]; mixed.document.nodes[mixed.id].scale = [.45, .45, .45];
  store.setState({ document: mixed.document });
  setAnimationSettings(store, { end: 48 });
  for (const [frame, angle] of [[0, 0], [24, 45], [48, 0]]) {
    const poses = evaluateSceneAnimation(store.getState().document, frame); poses.get(cube).rotation[1] = angle;
    setKeys(store, [cube], frame, poses, ["rotation.y"]);
  }
  const bytes = await encodeProject(store.getState().document, new Map(), {
    camera: { position: [5, 4, 9], target: [0, .3, 0], fov: 42, near: .01, far: 1000 }, time: 0,
  });
  await mkdir("examples", { recursive: true }); await writeFile("examples/modeling-study.msb", bytes);
  console.log(`Wrote modeling-study.msb (${bytes.length} bytes).`);
} finally { await server.close(); }
