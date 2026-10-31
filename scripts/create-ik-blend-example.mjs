// Decorate the linked-controller example with animated FK and IK/FK blend.
// Run node scripts/create-ik-controls-example.mjs first if its archive is absent.
// Then run node scripts/create-ik-blend-example.mjs.
import { createServer } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import { Euler, MathUtils, Quaternion, Vector3 } from "three";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { decodeProject, encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { evaluateSceneAnimation, evaluateIKBlend, setIKBlendKey, upsertTrack } = await server.ssrLoadModule("/src/animation.ts");
  const { evaluateDrivenKeys } = await server.ssrLoadModule("/src/driven-keys.ts");
  const { evaluateRigStages, getIKTargetPoints, jointWorldMatrices, updateIKHandle } = await server.ssrLoadModule("/src/ik.ts");
  const { createParticlePoseSampler } = await server.ssrLoadModule("/src/particle-pose-sampler.ts");
  const source = await decodeProject(new Uint8Array(await readFile("examples/animated-ik-controls.msb"))), store = createSceneStore(source.scene);
  const handleId = source.scene.ikHandles[0].id;
  updateIKHandle(store, handleId, { name: "Animated IK-FK blend", blend: 1 });
  const frames = [0, 30, 60, 90, 120];
  for (const [targetId, values] of [["shoulder", [-35, -10, 40, 0, -35]], ["elbow", [20, 50, -15, 35, 20]]]) {
    upsertTrack(store, { id: `${targetId}-fk-motion`, targetId, channel: "rotation.z", keys: frames.map((time, index) => ({
      id: `${targetId}-fk-${index}`, time, value: values[index], interpolation: "bezier", tangentMode: "auto",
    })) });
  }
  for (const [frame, value] of [[0, 0], [60, 1], [120, 0]]) setIKBlendKey(store, handleId, frame, value);
  const blend = store.getState().document.animation.tracks.find(track => track.channel === "ik.blend");
  upsertTrack(store, { ...blend, keys: blend.keys.map(key => ({ ...key, interpolation: "linear" })) });

  const rotation = pose => new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad), "XYZ"));
  function evaluate(scene, frame) {
    const poses = evaluateSceneAnimation(scene, frame); evaluateDrivenKeys(scene, poses);
    return { poses, stages: evaluateRigStages(scene, poses, true, frame) };
  }
  function verify(scene) {
    const fullScene = { ...scene, ikHandles: scene.ikHandles.map(handle => ({ ...handle, blend: 1 })),
      animation: { ...scene.animation, tracks: scene.animation.tracks.filter(track => track.channel !== "ik.blend") } };
    const sampler = createParticlePoseSampler(scene);
    let maximumQuaternionError = 0, maximumFullIKTargetError = 0, maximumHistoricalError = 0;
    for (let frame = 0; frame <= 120; frame += .5) {
      const expectedBlend = frame <= 60 ? frame / 60 : (120 - frame) / 60;
      if (Math.abs(evaluateIKBlend(scene, handleId, frame) - expectedBlend) > 1e-12) throw Error(`Blend curve differs at frame ${frame}.`);
      const actual = evaluate(scene, frame), full = evaluate(fullScene, frame);
      const authoredFK = evaluateSceneAnimation(scene, frame);
      for (const joint of ["shoulder", "elbow", "wrist"]) {
        // Independent local quaternion expectation: authored FK to an explicit
        // constant-one solve, using the known triangular blend function above.
        const expected = rotation(authoredFK.get(joint)).slerp(rotation(full.stages.solvedPoses.get(joint)), expectedBlend);
        const error = expected.angleTo(rotation(actual.stages.solvedPoses.get(joint)));
        maximumQuaternionError = Math.max(maximumQuaternionError, error);
        if (!Number.isFinite(error) || error > 1e-6) throw Error(`Local quaternion blend differs at ${joint}, frame ${frame}: ${error}`);
      }
      const fullTarget = getIKTargetPoints(fullScene, full.poses).get(handleId).target;
      const fullEnd = new Vector3().setFromMatrixPosition(jointWorldMatrices(fullScene, full.poses).get("wrist"));
      maximumFullIKTargetError = Math.max(maximumFullIKTargetError, fullEnd.distanceTo(new Vector3(...fullTarget)));
      const actualWorld = jointWorldMatrices(scene, actual.poses).get("wrist"), historicalWorld = sampler.worldAt(frame).get("wrist");
      const historicalError = Math.max(...actualWorld.elements.map((value, index) => Math.abs(value - historicalWorld.elements[index])));
      maximumHistoricalError = Math.max(maximumHistoricalError, historicalError);
      if (historicalError > 1e-9) throw Error(`Historical sample differs at frame ${frame}.`);
    }
    if (maximumFullIKTargetError > 1e-7) throw Error(`Full IK reference missed its target: ${maximumFullIKTargetError}`);
    return { maximumQuaternionError, maximumFullIKTargetError, maximumHistoricalError };
  }
  const scene = store.getState().document, original = verify(scene);
  const bytes = await encodeProject(scene, new Map(), { ...source.editor, time: 0 });
  const output = "examples/animated-ik-blend.msb";
  await writeFile(output, bytes);
  const opened = await decodeProject(new Uint8Array(await readFile(output))), readback = verify(opened.scene);
  if (JSON.stringify(opened.scene) !== JSON.stringify(scene)) throw Error("Archive readback changed the authored scene.");
  console.log(JSON.stringify({ output, bytes: bytes.length, fps: 24, frameRange: [0, 120], blend: [[0, 0], [30, .5], [60, 1], [90, .5], [120, 0]],
    samplesPerPass: 241, authored: original, archiveReadback: readback, verifiedArchiveReadback: true,
    note: "Partial blend interpolates local joint rotations; the effector intentionally leaves the target until full IK." }, null, 2));
} finally { await server.close(); }
