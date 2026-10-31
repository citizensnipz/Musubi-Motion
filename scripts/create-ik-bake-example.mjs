// Bake the animated controller/blend example and verify saved FK motion.
// Run node scripts/create-ik-bake-example.mjs.
import { createServer } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import { Vector3 } from "three";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { decodeProject, encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { evaluateSceneAnimation } = await server.ssrLoadModule("/src/animation.ts");
  const { evaluateDrivenKeys } = await server.ssrLoadModule("/src/driven-keys.ts");
  const { evaluateRigStages } = await server.ssrLoadModule("/src/ik.ts");
  const { constraintWorldMatrices } = await server.ssrLoadModule("/src/constraints.ts");
  const { bakeIKToFK } = await server.ssrLoadModule("/src/ik-bake.ts");
  const { createParticlePoseSampler } = await server.ssrLoadModule("/src/particle-pose-sampler.ts");
  const source = await decodeProject(new Uint8Array(await readFile("examples/animated-ik-blend.msb")));
  const original = source.scene, store = createSceneStore(original), handleId = original.ikHandles[0].id;
  const settings = { start: 0, end: 120, step: .5, preserveOutsideKeys: true, minimizeRotation: true };
  const started = performance.now();
  const result = await bakeIKToFK(store, handleId, settings);
  const commandMilliseconds = performance.now() - started;
  const scene = store.getState().document;
  if (scene.ikHandles[0].enabled) throw Error("Baked handle must be disabled.");
  if (store.temporal.getState().pastStates.length !== 1) throw Error("Bake must create one undo entry.");
  store.temporal.getState().undo();
  if (store.getState().document !== original) throw Error("Undo did not restore the original scene.");
  store.temporal.getState().redo();
  if (store.getState().document !== scene) throw Error("Redo did not restore the baked scene.");
  function worlds(doc, frame) {
    const poses = evaluateSceneAnimation(doc, frame);
    evaluateDrivenKeys(doc, poses); evaluateRigStages(doc, poses, false, frame);
    return constraintWorldMatrices(doc, poses);
  }
  function verify(candidate) {
    let maximumSampleMatrixError = 0, maximumBetweenSampleEndpointError = 0, maximumHistoricalError = 0;
    const sampler = createParticlePoseSampler(candidate);
    for (let index = 0; index <= 480; index++) {
      const frame = index / 4, expected = worlds(original, frame), actual = worlds(candidate, frame);
      if (index % 2 === 0) {
        for (const [id, matrix] of expected) {
          const next = actual.get(id);
          if (!next) throw Error(`Missing baked world pose: ${id}`);
          maximumSampleMatrixError = Math.max(maximumSampleMatrixError,
            ...matrix.elements.map((value, i) => Math.abs(value - next.elements[i])));
        }
      } else {
        const expectedEnd = new Vector3().setFromMatrixPosition(expected.get("wrist"));
        const actualEnd = new Vector3().setFromMatrixPosition(actual.get("wrist"));
        maximumBetweenSampleEndpointError = Math.max(maximumBetweenSampleEndpointError, expectedEnd.distanceTo(actualEnd));
      }
      const historical = sampler.worldAt(frame);
      for (const [id, matrix] of actual) maximumHistoricalError = Math.max(maximumHistoricalError,
        ...matrix.elements.map((value, i) => Math.abs(value - historical.get(id).elements[i])));
    }
    if (maximumSampleMatrixError > 1e-6) throw Error(`Baked sample mismatch: ${maximumSampleMatrixError}`);
    if (maximumHistoricalError > 1e-9) throw Error(`Historical pose mismatch: ${maximumHistoricalError}`);
    return { maximumSampleMatrixError, maximumBetweenSampleEndpointError, maximumHistoricalError };
  }
  const authored = verify(scene), output = "examples/baked-ik-motion.msb";
  const bytes = await encodeProject(scene, new Map(), { ...source.editor, time: 30 / original.animation.fps });
  await writeFile(output, bytes);
  const reopened = await decodeProject(new Uint8Array(await readFile(output)));
  if (JSON.stringify(reopened.scene) !== JSON.stringify(scene)) throw Error("Archive readback changed the baked scene.");
  const archiveReadback = verify(reopened.scene);
  console.log(JSON.stringify({ output, bytes: bytes.length, settings, result, commandMilliseconds,
    verificationSamplesPerPass: 481, authored, archiveReadback, verifiedSingleUndoRedo: true,
    note: "Sampled poses match. Intermediate linear Euler interpolation is approximate; the endpoint error is measured in scene units." }, null, 2));
} finally { await server.close(); }
