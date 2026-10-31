// Reproduce the FK zero-crossing issue, capture a preferred pose, and verify it.
import { createServer } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import { Quaternion, Vector3 } from "three";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { decodeProject, encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { evaluateSceneAnimation } = await server.ssrLoadModule("/src/animation.ts");
  const { evaluateDrivenKeys } = await server.ssrLoadModule("/src/driven-keys.ts");
  const { evaluateRigStages, getIKTargetPoints } = await server.ssrLoadModule("/src/ik.ts");
  const { constraintWorldMatrices } = await server.ssrLoadModule("/src/constraints.ts");
  const { setPreferredAngles } = await server.ssrLoadModule("/src/joint-preferred.ts");
  const { bakeIKToFK } = await server.ssrLoadModule("/src/ik-bake.ts");
  const { createParticlePoseSampler } = await server.ssrLoadModule("/src/particle-pose-sampler.ts");
  const source = await decodeProject(new Uint8Array(await readFile("examples/animated-ik-blend.msb")));
  function evaluate(scene, frame) {
    const poses = evaluateSceneAnimation(scene, frame); evaluateDrivenKeys(scene, poses);
    const stages = evaluateRigStages(scene, poses, true, frame);
    return { poses, stages, worlds: constraintWorldMatrices(scene, poses) };
  }
  const store = createSceneStore(source.scene), chain = ["shoulder", "elbow", "wrist"];
  setPreferredAngles(store, chain, evaluate(source.scene, 0).stages.fkPoses);
  const preferred = store.getState().document;
  if (store.temporal.getState().pastStates.length !== 1) throw Error("Capturing preferences must commit once.");
  const crossings = [50.6521193316, 70.8977247327];
  function crossingChanges(scene) {
    return crossings.map(frame => {
      const before = evaluate(scene, frame - .0001).worlds, after = evaluate(scene, frame + .0001).worlds;
      return { frame,
        wristPositionChange: new Vector3().setFromMatrixPosition(before.get("wrist")).distanceTo(new Vector3().setFromMatrixPosition(after.get("wrist"))),
        shoulderRadians: new Quaternion().setFromRotationMatrix(before.get("shoulder")).angleTo(new Quaternion().setFromRotationMatrix(after.get("shoulder"))),
      };
    });
  }
  function verify(scene) {
    const full = { ...scene, animation: { ...scene.animation, tracks: scene.animation.tracks.filter(track => track.channel !== "ik.blend") },
      ikHandles: scene.ikHandles.map(handle => ({ ...handle, blend: 1 })) };
    const history = createParticlePoseSampler(scene);
    let maximumTargetError = 0, maximumHistoricalError = 0, maximumHalfFrameRotationStep = 0, previous;
    for (let frame = 0; frame <= 120; frame += .5) {
      const actual = evaluate(scene, frame), solved = evaluate(full, frame), target = getIKTargetPoints(full, solved.poses).get(full.ikHandles[0].id).target;
      maximumTargetError = Math.max(maximumTargetError, new Vector3().setFromMatrixPosition(solved.worlds.get("wrist")).distanceTo(new Vector3(...target)));
      const historical = history.worldAt(frame);
      for (const [id, matrix] of actual.worlds) maximumHistoricalError = Math.max(maximumHistoricalError,
        ...matrix.elements.map((value, index) => Math.abs(value - historical.get(id).elements[index])));
      if (previous) for (const id of chain) maximumHalfFrameRotationStep = Math.max(maximumHalfFrameRotationStep,
        new Quaternion().setFromRotationMatrix(previous.get(id)).angleTo(new Quaternion().setFromRotationMatrix(actual.worlds.get(id))));
      previous = actual.worlds;
    }
    if (maximumTargetError > 1e-7 || maximumHistoricalError > 1e-9) throw Error("Preferred-pose target/history verification failed.");
    const transitions = crossingChanges(scene);
    if (transitions.some(value => value.wristPositionChange > .0001 || value.shoulderRadians > .0001)) throw Error("Preferred pose did not remove the measured FK zero-crossing flips.");
    return { maximumTargetError, maximumHistoricalError, maximumHalfFrameRotationStep, transitions };
  }
  const authored = verify(preferred), output = "examples/preferred-ik-motion.msb";
  const bytes = await encodeProject(preferred, new Map(), { ...source.editor, time: 50 / source.scene.animation.fps });
  await writeFile(output, bytes);
  const reopened = await decodeProject(new Uint8Array(await readFile(output)));
  if (JSON.stringify(reopened.scene) !== JSON.stringify(preferred)) throw Error("Preferred metadata changed on readback.");
  const readback = verify(reopened.scene);
  await bakeIKToFK(store, preferred.ikHandles[0].id, { start: 0, end: 120, step: .5, preserveOutsideKeys: true, minimizeRotation: true });
  const baked = store.getState().document;
  let maximumSampleMatrixError = 0, maximumQuarterFrameEndpointError = 0;
  for (let index = 0; index <= 480; index++) {
    const frame = index / 4, original = evaluate(preferred, frame).worlds, actual = evaluate(baked, frame).worlds;
    if (index % 2 === 0) for (const [id, matrix] of original) maximumSampleMatrixError = Math.max(maximumSampleMatrixError,
      ...matrix.elements.map((value, i) => Math.abs(value - actual.get(id).elements[i])));
    else maximumQuarterFrameEndpointError = Math.max(maximumQuarterFrameEndpointError,
      new Vector3().setFromMatrixPosition(original.get("wrist")).distanceTo(new Vector3().setFromMatrixPosition(actual.get("wrist"))));
  }
  if (maximumSampleMatrixError > 1e-6 || maximumQuarterFrameEndpointError > .005) throw Error("Preferred-pose bake exceeded its fixture accuracy bound.");
  console.log(JSON.stringify({ output, bytes: bytes.length, preferences: preferred.joints.filter(joint => joint.preferredAngle).map(joint => ({ id: joint.id, preferredAngle: joint.preferredAngle })),
    legacyTransitions: crossingChanges(source.scene), authored, readback, baked: { maximumSampleMatrixError, maximumQuarterFrameEndpointError },
    note: "This fixture's FK zero-crossing flips are removed. General pole singularities and shortest-arc blend discontinuities are not eliminated." }, null, 2));
} finally { await server.close(); }
