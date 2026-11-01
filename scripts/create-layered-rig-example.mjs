import { createServer } from "vite";
import { readFile, writeFile } from "node:fs/promises";
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { decodeProject, encodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { addAnimationLayer, updateAnimationLayer } = await server.ssrLoadModule("/src/animation-layers.ts");
  const { setKeys, evaluateSceneAnimation } = await server.ssrLoadModule("/src/animation.ts");
  const { jointWorldMatrices } = await server.ssrLoadModule("/src/ik.ts");
  const { setJointOrientation, setJointLocalAxes } = await server.ssrLoadModule("/src/joint-orientation.ts");
  const { mirrorJointSubtree, mirrorJointPose, reflectJointMatrix } = await server.ssrLoadModule("/src/joint-mirror.ts");
  const loaded = await decodeProject(new Uint8Array(await readFile("examples/skin-weights-study.msb")));
  const scene = loaded.scene;
  scene.joints.forEach(joint => { joint.name = `L_${joint.name}`; });
  const store = createSceneStore(scene);
  setJointOrientation(store, "skin-middle", [12, 0, 20]);
  setJointLocalAxes(store, "skin-middle", true);
  const pairs = mirrorJointSubtree(store, "skin-root", { axis: "X", search: "L_", replace: "R_" });
  const layer = addAnimationLayer(store, "Arm adjustment", "additive");
  updateAnimationLayer(store, layer, { weight: .5 });
  for (const [frame, offset] of [[0, 0], [24, 30], [48, 0]]) {
    const doc = store.getState().document, pose = evaluateSceneAnimation(doc, frame).get("skin-middle");
    const base = doc.animation.tracks.find(track => track.id && track.targetId === "skin-middle" && track.channel === "rotation.z" && !track.layerId);
    const baseKey = base.keys.find(key => key.time === frame);
    const wanted = { ...pose, rotation: [0, 0, baseKey.value + offset] };
    setKeys(store, ["skin-middle"], frame, new Map([["skin-middle", wanted]]), ["rotation.z"]);
  }
  const mirrorLayer = addAnimationLayer(store, "Mirrored pose", "override");
  for (const frame of [0, 12, 24, 36, 48]) {
    const doc = store.getState().document;
    mirrorJointPose(store, pairs, "X", evaluateSceneAnimation(doc, frame), { frame });
  }
  function verify(doc) {
    let max = 0;
    for (const frame of [0, 12, 24, 36, 48]) {
      const poses = evaluateSceneAnimation(doc, frame), worlds = jointWorldMatrices(doc, poses);
      for (const [source, destination] of pairs) {
        const expected = reflectJointMatrix(worlds.get(source), "X").elements, actual = worlds.get(destination).elements;
        expected.forEach((value, index) => max = Math.max(max, Math.abs(value - actual[index])));
      }
    }
    if (max > 1e-7) throw Error(`Mirrored layered pose mismatch: ${max}`);
    return max;
  }
  const doc = store.getState().document, before = verify(doc);
  const bytes = await encodeProject(doc, loaded.assets, { camera: { position: [5, 3, 8], target: [0, .5, 0], fov: 42, near: .01, far: 1000 }, time: 1 });
  const output = "examples/layered-rig-study.msb"; await writeFile(output, bytes);
  const reopened = await decodeProject(new Uint8Array(await readFile(output)));
  if (JSON.stringify(reopened.scene) !== JSON.stringify(doc)) throw Error("Archive changed the layered rig.");
  console.log(JSON.stringify({ output, bytes: bytes.length, joints: doc.joints.length, layers: doc.animation.layers.length,
    activeLayer: mirrorLayer, mirroredFrames: 5, maxWorldError: before, reopenedMaxWorldError: verify(reopened.scene) }, null, 2));
} finally { await server.close(); }
