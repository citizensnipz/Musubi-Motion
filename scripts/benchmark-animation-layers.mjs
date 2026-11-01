// CPU animation evaluation only; excludes viewport rendering, skinning and UI.
// Run: node scripts/benchmark-animation-layers.mjs
import { createServer } from "vite";
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const { defaultAnimation, evaluateSceneAnimation, validateAnimation } = await server.ssrLoadModule("/src/animation.ts");
  const channels = ["position.x", "rotation.y", "scale.z"];
  const fixtures = [{ objects: 100, layers: 10, channels: 3, keys: 2 }, { objects: 1000, layers: 10, channels: 3, keys: 2 }, { objects: 100, layers: 1000, channels: 1, keys: 1 }];
  const reports = [];
  for (const settings of fixtures) {
    const doc = emptyScene();
    doc.animation = { ...defaultAnimation(), layers: Array.from({ length: settings.layers }, (_, index) => ({ id: `layer-${index}`, name: `Layer ${index}`, mode: index % 3 === 2 ? "override" : "additive", weight: 0.5, mute: false, solo: false, locked: false })) };
    for (let object = 0; object < settings.objects; object++) {
      const id = `object-${object}`;
      doc.nodes[id] = { id, type: "transform", name: id, parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" }; doc.rootIds.push(id);
      for (let layer = 0; layer < settings.layers; layer++) for (let channel = 0; channel < settings.channels; channel++) {
        const value = channel === 2 ? 1 + layer * 0.001 : (layer + 1) * (channel ? 0.1 : 0.01);
        doc.animation.tracks.push({ id: `track-${object}-${layer}-${channel}`, targetId: id, channel: channels[channel], layerId: `layer-${layer}`, keys: Array.from({ length: settings.keys }, (_, key) => ({ id: `key-${object}-${layer}-${channel}-${key}`, time: key * 100, value: value * (1 + key * 0.5), interpolation: "linear", tangentMode: "auto" })) });
      }
    }
    validateAnimation(doc.animation, doc);
    const compileStart = performance.now(); evaluateSceneAnimation(doc, 0); const compileMs = performance.now() - compileStart;
    const times = [], sampleCount = settings.layers === 1000 ? 100 : 300;
    let maxError = 0;
    for (let sample = -30; sample < sampleCount; sample++) {
      const frame = ((sample + 30) * 0.731) % 100, start = performance.now(), poses = evaluateSceneAnimation(doc, frame), elapsed = performance.now() - start;
      let expected = 0;
      for (let layer = 0; layer < settings.layers; layer++) {
        const value = (layer + 1) * 0.01 * (settings.keys === 1 ? 1 : 1 + frame / 200);
        expected = layer % 3 === 2 ? expected * 0.5 + value * 0.5 : expected + value * 0.5;
      }
      for (const pose of poses.values()) maxError = Math.max(maxError, Math.abs(pose.position[0] - expected));
      if (sample >= 0) times.push(elapsed);
    }
    if (maxError > 1e-9) throw Error(`Layer evaluation mismatch: ${maxError}`);
    times.sort((a, b) => a - b);
    reports.push({ ...settings, tracks: doc.animation.tracks.length, totalKeys: doc.animation.tracks.length * settings.keys, compileMs, medianMsPerFrame: times[Math.floor(times.length / 2)], p95MsPerFrame: times[Math.floor(times.length * 0.95)], maxError });
  }
  console.log(JSON.stringify({ scope: "CPU animation evaluation; no rendering/skinning/UI", reports }, null, 2));
} finally { await server.close(); }
