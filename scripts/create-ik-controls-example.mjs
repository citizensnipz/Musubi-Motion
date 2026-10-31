// Rebuild and verify: node scripts/create-ik-controls-example.mjs
import { createServer } from "vite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Vector3 } from "three";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { createController } = await server.ssrLoadModule("/src/controller-curves.ts");
  const { createMeshPrimitive } = await server.ssrLoadModule("/src/mesh-modeling.ts");
  const { createConstraint } = await server.ssrLoadModule("/src/constraints.ts");
  const { createIKHandle, evaluateRigStages, getIKTargetPoints, jointWorldMatrices } = await server.ssrLoadModule("/src/ik.ts");
  const { defaultAnimation, evaluateSceneAnimation, upsertTrack } = await server.ssrLoadModule("/src/animation.ts");
  const { evaluateDrivenKeys } = await server.ssrLoadModule("/src/driven-keys.ts");
  const { createParticlePoseSampler } = await server.ssrLoadModule("/src/particle-pose-sampler.ts");
  const { encodeProject, decodeProject } = await server.ssrLoadModule("/src/project-archive.ts");

  const store = createSceneStore({ ...emptyScene(), animation: { ...defaultAnimation(), fps: 24, start: 0, end: 120 }, joints: [
    { id: "rig-base", name: "Constrained FK base", parentId: null, position: [0, 0, 0] },
    { id: "shoulder", name: "Shoulder", parentId: "rig-base", position: [0, 0, 0] },
    { id: "elbow", name: "Elbow", parentId: "shoulder", position: [0, 1.2, 0] },
    { id: "wrist", name: "Wrist", parentId: "elbow", position: [0, 1.2, 0] },
  ] });
  const root = createController(store, "square", { name: "Root Motion · keyed", position: [-1.2, 0, 0], size: .65, plane: "XZ", color: "#b3c3a4" });
  const space = createController(store, "circle", { name: "Control Space · follows FK base", size: .18, plane: "XZ", color: "#707b86" });
  const target = createController(store, "circle", { name: "Wrist Target · keyed", position: [1.1, 1.3, .1], size: .24, plane: "XY", color: "#8db6d0" });
  const pole = createController(store, "arrow", { name: "Elbow Pole · keyed", position: [0, 0, 2], size: .3, plane: "XZ", color: "#c19bd4" });
  const doc = store.getState().document;
  store.setState({ document: { ...doc, rootIds: doc.rootIds.filter(id => id !== target && id !== pole), nodes: {
    ...doc.nodes, [target]: { ...doc.nodes[target], parentId: space }, [pole]: { ...doc.nodes[pole], parentId: space },
  } } });
  createMeshPrimitive(store, "plane", { name: "Ground", size: 7, position: [0, -.3, 0], color: "#303841" });
  // This dependency intentionally exercises both constrained controls and a
  // constrained FK ancestor before the linked IK solve.
  createConstraint(store, "point", root, "rig-base", false);
  createConstraint(store, "point", "rig-base", space, false);
  const handle = createIKHandle(store, "shoulder", "wrist", [-.1, 1.3, .1], {
    solver: "two-bone", poleTarget: [-1.2, 0, 2],
    targetControl: { objectId: target, offset: [0, 0, 0] }, poleControl: { objectId: pole, offset: [0, 0, 0] },
  });
  const frames = [0, 30, 60, 90, 120];
  function motion(id, name, samples) {
    for (let axis = 0; axis < 3; axis++) upsertTrack(store, { id: `${name}-${axis}`, targetId: id, channel: `position.${"xyz"[axis]}`,
      keys: frames.map((time, index) => ({ id: `${name}-${axis}-${index}`, time, value: samples[index][axis], interpolation: "bezier", tangentMode: "clamped" })) });
  }
  motion(root, "root", [[-1.2, 0, 0], [-.8, .1, 0], [-1.4, 0, -.2], [-1.1, .15, .1], [-1.2, 0, 0]]);
  motion(target, "target", [[1.1, 1.3, .1], [-.4, 1.7, .5], [-1.1, 1.3, -.2], [.4, .8, .6], [1.1, 1.3, .1]]);
  motion(pole, "pole", [[0, 0, 2], [1, 0, 1.5], [0, -1, 1], [-1, 0, 1.5], [0, 0, 2]]);

  function verify(scene) {
    let maximumError = 0;
    const historical = createParticlePoseSampler(scene);
    for (let frame = 0; frame <= 120; frame += .5) {
      const poses = evaluateSceneAnimation(scene, frame); evaluateDrivenKeys(scene, poses); evaluateRigStages(scene, poses);
      const targetPoint = getIKTargetPoints(scene, poses).get(handle).target;
      const endpoint = new Vector3().setFromMatrixPosition(jointWorldMatrices(scene, poses).get("wrist"));
      const error = endpoint.distanceTo(new Vector3(...targetPoint)); maximumError = Math.max(maximumError, error);
      if (!Number.isFinite(error) || error > 1e-7) throw Error(`IK target missed at frame ${frame}: ${error}`);
      if (frame % 10 === 0) {
        const sampled = new Vector3().setFromMatrixPosition(historical.worldAt(frame).get("wrist"));
        if (sampled.distanceTo(endpoint) > 1e-9) throw Error(`Historical sampler differs at frame ${frame}.`);
      }
    }
    return maximumError;
  }
  const scene = store.getState().document, originalError = verify(scene);
  const bytes = await encodeProject(scene, new Map(), { camera: { position: [5, 3.8, 8], target: [-.8, .85, .5], fov: 42, near: .01, far: 1000 }, time: 0 });
  await mkdir("examples", { recursive: true });
  const output = "examples/animated-ik-controls.msb";
  await writeFile(output, bytes);
  const opened = await decodeProject(new Uint8Array(await readFile(output))), reopenedError = verify(opened.scene);
  if (JSON.stringify(opened.scene) !== JSON.stringify(scene)) throw Error("Archive readback changed the authored scene.");
  console.log(JSON.stringify({ output, bytes: bytes.length, fps: 24, frames: [0, 120], samplesPerPass: 241,
    maximumTargetError: Math.max(originalError, reopenedError), verifiedArchiveReadback: true, historicalSamplerChecked: true,
    controls: { root, target, pole, space }, handle }, null, 2));
} finally { await server.close(); }
