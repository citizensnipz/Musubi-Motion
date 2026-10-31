// Run with node scripts/create-two-bone-example.mjs from the repository root.
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { Matrix4 } from "three";
const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  const { emptyScene, addSplat } = await server.ssrLoadModule("/src/scene-document.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { createIKHandle } = await server.ssrLoadModule("/src/ik.ts");
  const { encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const doc = addSplat(emptyScene(), { id: "limb-asset", kind: "procedural", generator: "knot-v1" },
    "Two-bone skin", [0, 0, 0], "limb", "limb-shape").document;
  doc.joints = [
    { id: "limb-root", name: "Shoulder", parentId: null, position: [-1, 0, 0] },
    { id: "limb-middle", name: "Elbow", parentId: "limb-root", position: [1, 0, 0] },
    { id: "limb-end", name: "Wrist", parentId: "limb-middle", position: [1, 0, 0] },
  ];
  doc.nodes["limb-shape"].binding = { jointIds: doc.joints.map(joint => joint.id),
    restMatrices: [-1, 0, 1].map(x => new Matrix4().makeTranslation(x, 0, 0).toArray()) };
  const store = createSceneStore(doc);
  createIKHandle(store, "limb-root", "limb-end", [.5, .75, 0], { solver: "two-bone", poleTarget: [0, 1.5, 1] });
  const bytes = await encodeProject(store.getState().document, new Map(), {
    camera: { position: [5, 3, 8], target: [0, .5, 0], fov: 42, near: .01, far: 1000 }, time: 0,
  });
  await mkdir("examples", { recursive: true });
  await writeFile("examples/two-bone-study.msb", bytes);
  console.log(`Wrote two-bone-study.msb (${bytes.length} bytes).`);
} finally { await server.close(); }
