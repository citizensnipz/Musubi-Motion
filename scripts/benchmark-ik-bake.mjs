// CPU command timings, including validation, verification, yielding, and commit.
import { createServer } from "vite";
import { readFile } from "node:fs/promises";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { decodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { bakeIKToFK } = await server.ssrLoadModule("/src/ik-bake.ts");
  const { scene } = await decodeProject(new Uint8Array(await readFile("examples/animated-ik-blend.msb")));
  const warmups = 2, runs = 5, rows = [];
  for (const step of [.5, .05]) {
    const timings = [], yields = [];
    let result;
    for (let run = 0; run < warmups + runs; run++) {
      const store = createSceneStore(scene); let yieldCount = 0;
      const started = performance.now();
      result = await bakeIKToFK(store, scene.ikHandles[0].id,
        { start: 0, end: 120, step, preserveOutsideKeys: true, minimizeRotation: true },
        { yieldTask: async () => { yieldCount++; await new Promise(resolve => setTimeout(resolve, 0)); } });
      const elapsed = performance.now() - started;
      if (store.temporal.getState().pastStates.length !== 1) throw Error("Benchmark bake did not commit once.");
      if (run >= warmups) { timings.push(elapsed); yields.push(yieldCount); }
    }
    timings.sort((a, b) => a - b);
    rows.push({ step, samples: result.samples, keysWritten: result.keysWritten,
      medianMs: +timings[Math.floor(runs / 2)].toFixed(3), maximumMs: +timings.at(-1).toFixed(3), yields });
  }
  console.log(JSON.stringify({ node: process.version, warmups, runs, rows,
    includes: "Source sampling, curve construction, validation, full-scene sample verification, timer yields, and one undo commit",
    excludes: "Browser rendering, progress DOM updates, editor listeners and archive I/O; timings are local CPU evidence" }, null, 2));
} finally { await server.close(); }
