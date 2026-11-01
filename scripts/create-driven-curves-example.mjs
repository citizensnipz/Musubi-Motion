// Reproducible fractional SDK curves, independent from timeline key coordinates.
import { createServer } from "vite";
import { writeFile, readFile } from "node:fs/promises";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { createSceneStore } = await server.ssrLoadModule("/src/scene-store.ts");
  const { createController } = await server.ssrLoadModule("/src/controller-curves.ts");
  const { createMeshPrimitive } = await server.ssrLoadModule("/src/mesh-modeling.ts");
  const { defaultAnimation, evaluateCurve, evaluateSceneAnimation, upsertTrack } = await server.ssrLoadModule("/src/animation.ts");
  const { evaluateDrivenKeys, upsertDrivenRelationship } = await server.ssrLoadModule("/src/driven-keys.ts");
  const { insertDrivenCurveKey } = await server.ssrLoadModule("/src/driven-curve-edit.ts");
  const { encodeProject, decodeProject } = await server.ssrLoadModule("/src/project-archive.ts");
  const store = createSceneStore(emptyScene());
  const control = createController(store, "circle", { name: "Driver control", plane: "XZ", size: .7, position: [-2, 0, 0] });
  const block = createMeshPrimitive(store, "cube", { name: "Driven block", size: .8, position: [0, 0, 0] });
  const indicator = createMeshPrimitive(store, "sphere", { name: "Visibility indicator", size: .5, position: [2, .1, 0], color: "#aaaabb" });
  createMeshPrimitive(store, "plane", { name: "Ground", size: 5, position: [0, -.5, 0], color: "#505863" });
  store.setState({ document: { ...store.getState().document, animation: { ...defaultAnimation(), end: 96, tracks: [] } } });
  const key = (id, time, value, extra = {}) => ({ id, time, value, interpolation: "linear", tangentMode: "auto", ...extra });
  upsertTrack(store, { id: "driver-motion", targetId: control, channel: "position.y", keys: [key("driver-0", 0, 0), key("driver-48", 48, 1), key("driver-96", 96, 0)] });
  const driver = { targetId: control, channel: "position.y" };
  const weighted = [
    key("lift-0", 0, .2, { interpolation: "bezier", tangentMode: "fixed", inSlope: 0, outSlope: 2, outWeight: .65 }),
    key("lift-04", .4, 1.8, { interpolation: "bezier", tangentMode: "fixed", inSlope: 1.3, outSlope: -2, inWeight: .2, outWeight: .2, broken: true }),
    key("lift-1", 1, .5, { interpolation: "bezier", tangentMode: "fixed", inSlope: 0, outSlope: 0, inWeight: .6 }),
  ];
  upsertDrivenRelationship(store, { id: "sdk-lift", driver, driven: { targetId: block, channel: "position.y" }, keys: weighted });
  upsertDrivenRelationship(store, { id: "sdk-rotation", driver, driven: { targetId: block, channel: "rotation.z" }, keys: [key("turn-0", 0, -30), key("turn-1", 1, 90)] });
  upsertDrivenRelationship(store, { id: "sdk-scale", driver, driven: { targetId: block, channel: "scale.x" }, keys: [key("scale-0", 0, .3), key("scale-1", 1, 1.2)] });
  // SDK visibility is a continuous scalar response; rendering uses its .5 threshold.
  upsertDrivenRelationship(store, { id: "sdk-visibility", driver, driven: { targetId: indicator, channel: "visibility" }, keys: [key("visible-0", 0, 0), key("visible-1", 1, 1)] });
  const timeAnimation = store.getState().document.animation;
  insertDrivenCurveKey(store, "sdk-lift", .25);
  if (store.getState().document.animation !== timeAnimation) throw Error("SDK insertion changed time animation.");
  function verify(scene) {
    const relation = scene.drivenKeys.find(item => item.id === "sdk-lift");
    let maximumInsertionError = 0, maximumEvaluationError = 0;
    for (let index = 0; index <= 1000; index++) {
      const value = index / 1000;
      maximumInsertionError = Math.max(maximumInsertionError, Math.abs(evaluateCurve(weighted, value) - evaluateCurve(relation.keys, value)));
    }
    for (let frame = 0; frame <= 96; frame += .25) {
      const driverValue = frame <= 48 ? frame / 48 : (96 - frame) / 48;
      const poses = evaluateSceneAnimation(scene, frame); evaluateDrivenKeys(scene, poses);
      const actual = poses.get(block);
      maximumEvaluationError = Math.max(maximumEvaluationError,
        Math.abs(actual.position[1] - evaluateCurve(weighted, driverValue)),
        Math.abs(actual.rotation[2] - (-30 + 120 * driverValue)),
        Math.abs(actual.scale[0] - (.3 + .9 * driverValue)),
        Math.abs(poses.get(indicator).visibility - driverValue));
    }
    if (maximumInsertionError > 1e-9 || maximumEvaluationError > 1e-9) throw Error("SDK example evaluation differs from its expected response.");
    return { maximumInsertionError, maximumEvaluationError };
  }
  const scene = store.getState().document, authored = verify(scene), output = "examples/driven-curves-study.msb";
  const bytes = await encodeProject(scene, new Map(), { camera: { position: [5, 4, 9], target: [0, .6, 0], fov: 42, near: .01, far: 1000 }, time: 12 / 24 });
  await writeFile(output, bytes);
  const reopened = await decodeProject(new Uint8Array(await readFile(output)));
  if (JSON.stringify(reopened.scene) !== JSON.stringify(scene)) throw Error("Archive readback changed SDK curves.");
  console.log(JSON.stringify({ output, bytes: bytes.length, driver: control, block, indicator, relationships: 4,
    weightedCurveSamplesPerPass: 1001, frameSamplesPerPass: 385, authored, readback: verify(reopened.scene),
    note: "Driver coordinates are fractional attribute values; only the control's motion is keyed in scene time." }, null, 2));
} finally { await server.close(); }
