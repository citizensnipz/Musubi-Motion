// CPU-only solver comparison: node scripts/benchmark-ik.mjs
import { createServer } from "vite";
const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  const { emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { evaluateSceneAnimation } = await server.ssrLoadModule("/src/animation.ts");
  const { evaluateIK, validateIKHandles } = await server.ssrLoadModule("/src/ik.ts");
  const doc = emptyScene(); doc.joints = []; doc.ikHandles = [];
  for (let i = 0; i < 20; i++) {
    doc.joints.push({ id: `root${i}`, name: "Root", parentId: null, position: [i * 3, 0, 0] },
      { id: `mid${i}`, name: "Middle", parentId: `root${i}`, position: [0, 1, 0] },
      { id: `end${i}`, name: "End", parentId: `mid${i}`, position: [0, 1, 0] });
    doc.ikHandles.push({ id: `handle${i}`, name: "Handle", rootId: `root${i}`, endId: `end${i}`,
      target: [i * 3 + .7, 1.2, .3], poleTarget: [i * 3, 0, 2], solver: "two-bone", blend: 1, enabled: true, iterations: 64 });
  }
  const results = {};
  for (const solver of ["ccd", "two-bone"]) {
    doc.ikHandles = doc.ikHandles.map(handle => ({ ...handle, solver }));
    validateIKHandles(doc.ikHandles, doc);
    const samples = [];
    for (let i = 0; i < 110; i++) {
      const poses = evaluateSceneAnimation(doc, 0), start = performance.now();
      evaluateIK(doc, poses);
      const elapsed = performance.now() - start;
      if (i >= 10) samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    results[solver] = { medianMs: +samples[50].toFixed(3), p95Ms: +samples[95].toFixed(3) };
  }
  console.log(JSON.stringify({ chains: 20, samples: 100, results,
    excludes: "animation evaluation, binding, elasticity, rendering and browser scheduling" }, null, 2));
} finally { await server.close(); }
