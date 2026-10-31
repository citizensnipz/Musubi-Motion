// CPU-only animated blend evaluation: node scripts/benchmark-ik-blend.mjs
// Run scripts/create-ik-blend-example.mjs first if the example is absent.
import { createServer } from "vite";
import { readFile } from "node:fs/promises";
import { Vector3 } from "three";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { decodeProject, validateScene } = await server.ssrLoadModule("/src/project-archive.ts");
  const { evaluateSceneAnimation, evaluateIKBlend } = await server.ssrLoadModule("/src/animation.ts");
  const { evaluateDrivenKeys } = await server.ssrLoadModule("/src/driven-keys.ts");
  const { evaluateRigStages, getIKTargetPoints, jointWorldMatrices } = await server.ssrLoadModule("/src/ik.ts");
  const { createParticlePoseSampler } = await server.ssrLoadModule("/src/particle-pose-sampler.ts");
  const { scene: example } = await decodeProject(new Uint8Array(await readFile("examples/animated-ik-blend.msb")));
  const warmups = 50, samples = 300;
  const statistics = values => {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return { medianMs: +((sorted[middle - 1] + sorted[middle]) / 2).toFixed(6), p95Ms: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(6) };
  };
  function sceneCopies(count) {
    const scene = { ...structuredClone(example), nodes: {}, rootIds: [], joints: [], constraints: [], ikHandles: [], animation: { ...example.animation, tracks: [] } };
    for (let copy = 0; copy < count; copy++) {
      const source = structuredClone(example), id = value => value === null ? null : `copy${copy}-${value}`;
      for (const node of Object.values(source.nodes)) scene.nodes[id(node.id)] = { ...node, id: id(node.id), name: `${copy + 1} ${node.name}`, parentId: id(node.parentId) };
      scene.rootIds.push(...source.rootIds.map(id));
      scene.joints.push(...source.joints.map(joint => ({ ...joint, id: id(joint.id), name: `${copy + 1} ${joint.name}`, parentId: id(joint.parentId) })));
      scene.constraints.push(...source.constraints.map(constraint => ({ ...constraint, id: id(constraint.id), sourceId: id(constraint.sourceId), targetId: id(constraint.targetId) })));
      scene.ikHandles.push(...source.ikHandles.map(handle => ({ ...handle, id: id(handle.id), rootId: id(handle.rootId), endId: id(handle.endId),
        targetControl: { ...handle.targetControl, objectId: id(handle.targetControl.objectId) }, poleControl: { ...handle.poleControl, objectId: id(handle.poleControl.objectId) } })));
      scene.animation.tracks.push(...source.animation.tracks.map(track => ({ ...track, id: id(track.id), targetId: id(track.targetId), keys: track.keys.map(key => ({ ...key, id: id(key.id) })) })));
    }
    return validateScene(scene);
  }
  function evaluate(scene, frame) {
    const poses = evaluateSceneAnimation(scene, frame); evaluateDrivenKeys(scene, poses);
    evaluateRigStages(scene, poses, false, frame); return poses;
  }
  function measure(action) {
    const values = [];
    for (let index = 0; index < warmups + samples; index++) {
      const frame = index * 120 / (warmups + samples), start = performance.now();
      action(frame, index);
      if (index >= warmups) values.push(performance.now() - start);
    }
    return statistics(values);
  }
  const results = [];
  for (const chains of [1, 16]) {
    const scene = sceneCopies(chains);
    for (const [frame, value] of [[0, 0], [30, .5], [60, 1], [120, 0]]) {
      const poses = evaluate(scene, frame), worlds = jointWorldMatrices(scene, poses), points = getIKTargetPoints(scene, poses);
      for (const handle of scene.ikHandles) {
        if (evaluateIKBlend(scene, handle.id, frame) !== value) throw Error("Benchmark clone lost its blend curve.");
        if (!worlds.get(handle.endId).elements.every(Number.isFinite)) throw Error("Benchmark pose is not finite.");
        if (value === 1 && new Vector3().setFromMatrixPosition(worlds.get(handle.endId)).distanceTo(new Vector3(...points.get(handle.id).target)) > 1e-7) throw Error("Full IK benchmark pose missed its target.");
      }
    }
    const fullStages = measure(frame => evaluate(scene, frame));
    const misses = createParticlePoseSampler(scene), historicalMiss = measure(frame => misses.worldAt(frame));
    const hits = createParticlePoseSampler(scene), frames = Array.from({ length: 64 }, (_, index) => index * 1.125);
    for (const frame of frames) hits.worldAt(frame);
    const historicalHit = measure((_, index) => hits.worldAt(frames[index % frames.length]));
    results.push({ chains, joints: scene.joints.length, transforms: Object.values(scene.nodes).filter(node => node.type === "transform").length,
      tracks: scene.animation.tracks.length, blendTracks: scene.animation.tracks.filter(track => track.channel === "ik.blend").length,
      constraints: scene.constraints.length, fullStages, historicalMiss, historicalHit });
  }
  console.log(JSON.stringify({ node: process.version, warmups, samples, results,
    fullStages: "Time animation → SDK → upstream constraints → frame-aware IK blend → remaining constraints; fresh pose map each sample",
    historicalMiss: "Unique fractional frames with complete world matrices and bounded-cache eviction",
    historicalHit: "64 primed exact-frame entries reused",
    excludes: "Fixture setup/validation, editor callbacks, overlays, skinning, browser scheduling, GPU upload and rendering; CPU only" }, null, 2));
} finally { await server.close(); }
