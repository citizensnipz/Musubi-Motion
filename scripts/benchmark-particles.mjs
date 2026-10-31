// CPU simulation/replay benchmark, including async yields: node scripts/benchmark-particles.mjs
import { createServer } from "vite";
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { createParticleEmitter, findParticleShape, updateParticleEmitter } = await server.ssrLoadModule("/src/particle-emitter.ts");
  const { createParticleSimulation } = await server.ssrLoadModule("/src/particle-simulation.ts");
  const results = [];
  for (const rate of [500, 2500]) {
    const store = createSceneStore(), id = createParticleEmitter(store, "directional");
    updateParticleEmitter(store, findParticleShape(store.getState().document, id).id, { rate, lifetime: 2, endFrame: 240 });
    const doc = store.getState().document, simulation = createParticleSimulation(doc, findParticleShape(doc, id));
    const started = performance.now(), initial = await simulation.snapshotAt(48), replayMs = performance.now() - started;
    const steps = [];
    for (let frame = 49; frame < 84; frame++) {
      const start = performance.now(); await simulation.snapshotAt(frame); if (frame >= 54) steps.push(performance.now() - start);
    }
    const sorted = steps.sort((a, b) => a - b), backward = performance.now(); await simulation.snapshotAt(24); const backwardMs = performance.now() - backward;
    results.push({ rate, liveAt2Seconds: initial.count, initialReplayMs: +replayMs.toFixed(2), backwardReplayMs: +backwardMs.toFixed(2),
      forwardFrameMedianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2), forwardFrameP95Ms: +sorted[Math.floor(sorted.length * .95)].toFixed(2) });
    simulation.dispose();
  }
  console.log(JSON.stringify({ fps: 24, simulationHz: 120, forwardSamples: 30, results, excludes: "GPU upload/rendering, browser UI, surface sampling and animated rig evaluation" }, null, 2));
} finally { await server.close(); }
