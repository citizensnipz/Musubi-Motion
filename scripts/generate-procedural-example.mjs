import { createServer } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, "examples/textures");
const server = await createServer({
  root,
  configLoader: "runner",
  cacheDir: resolve(process.env.TEMP ?? root, "musubi-procedural-example-cache"),
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { animatedNoiseGraph } = await server.ssrLoadModule("/src/procedural-graph.ts");
  const { prepareTexture } = await server.ssrLoadModule("/src/texture-assets.ts");
  const { encodeProjectBlob, decodeProjectBlob } = await server.ssrLoadModule("/src/project-archive.ts");
  const bytes = await readFile(resolve(directory, "musubi-checker.png"));
  const thumbnail = "data:image/png;base64," + bytes.toString("base64");
  const asset = await prepareTexture(new File([bytes], "Musubi checker.png"), "color", async () => ({ alpha: true, thumbnail }));
  const scene = {
    ...emptyScene(),
    textureAssets: { [asset.id]: asset },
    proceduralGraph: animatedNoiseGraph(asset.id),
  };
  const editor = { camera: { position: [0, 0, 6], target: [0, 0, 0], fov: 42, near: 0.01, far: 1000 }, time: 0 };
  const archive = await encodeProjectBlob(scene, new Map(), editor);
  await decodeProjectBlob(archive);
  await writeFile(resolve(directory, "animated-noise-ramp.msb"), Buffer.from(await archive.arrayBuffer()));
  console.log("Generated animated noise × ramp with embedded checker alpha.");
} finally {
  await server.close();
}
