import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = new Uint8Array(await readFile(new URL("../examples/splat-selection-regions.splat", import.meta.url)));
const filename = "splat-selection-regions.splat", count = source.byteLength / 32;
if (count !== 433) throw Error("Regenerate the original selection regions fixture before generating this example.");
const server = await createServer({ root, configLoader: "runner", server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { addSplat, emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { editSplatComponents } = await server.ssrLoadModule("/src/splat-component-edits.ts");
  const { encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const asset = { id: "regions", kind: "file", fileName: filename, byteLength: source.byteLength };
  let doc = addSplat(emptyScene(), asset, "Edited Regions", [0, 0, 0], "edited", "edited-shape").document;
  doc = addSplat(doc, asset, "Original Instance", [0, 0, 0], "original", "original-shape").document;
  doc.nodes.edited.position[1] = -.7;
  doc.nodes.original.position[1] = .7;
  const identity = { shapeId: "edited-shape", assetId: asset.id, count };
  doc = editSplatComponents(doc, identity, "hide", Uint32Array.from({ length: 144 }, (_, i) => i));
  doc = editSplatComponents(doc, identity, "delete", Uint32Array.from({ length: 144 }, (_, i) => i + 144));
  const editor = { camera: { position: [0, 0, 8], target: [0, 0, 0], fov: 42, view: "front", height: 4, near: .01, far: 1000 }, time: 0 };
  const bytes = await encodeProject(doc, new Map([[asset.id, new File([source], filename)]]), editor);
  await writeFile(new URL("../examples/splat-edit-regions.msb", import.meta.url), bytes);
  console.log(`Saved two instances of ${count} original splats with one embedded asset and two authored edit ranges.`);
} finally {
  await server.close();
}
