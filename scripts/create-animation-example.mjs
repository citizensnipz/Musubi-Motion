// Run with `node scripts/create-animation-example.mjs` from the repository root.
// Vite resolves the same TypeScript modules used by the editor; no extra dependency.
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { emptyScene, addSplat } = await server.ssrLoadModule('/src/scene-document.ts');
  const { encodeProject } = await server.ssrLoadModule('/src/project-archive.ts');
  const { defaultAnimation } = await server.ssrLoadModule('/src/animation.ts');
  const asset = { id: 'study-asset', kind: 'procedural', generator: 'knot-v1' };
  let doc = addSplat(emptyScene(), asset, 'Animated study', [0, 0, 0], 'study', 'study-shape').document;
  doc = addSplat(doc, asset, 'Driven study', [0, 0, 0], 'driven', 'driven-shape').document;
  doc.nodes.driven.position = [3, 0, 0];
  doc.nodes.driven.scale = [.5, .5, .5];
  doc.joints = [
    { id: 'shoulder', name: 'Shoulder', parentId: null, position: [-3, 0, 0] },
    { id: 'elbow', name: 'Elbow', parentId: 'shoulder', position: [0, 1, 0] },
    { id: 'wrist', name: 'Wrist', parentId: 'elbow', position: [0, 1, 0] },
  ];
  const key = (id, time, value, interpolation = 'bezier') => ({ id, time, value, interpolation, tangentMode: 'auto' });
  doc.animation = { ...defaultAnimation(), end: 96, tracks: [
    { id: 'bounce', targetId: 'study', channel: 'position.y', keys: [key('bounce0', 0, 0), key('bounce1', 24, 1.5), key('bounce2', 48, 0), key('bounce3', 72, 1.5), key('bounce4', 96, 0)] },
    { id: 'spin', targetId: 'study', channel: 'rotation.y', keys: [key('spin0', 0, 0, 'linear'), key('spin1', 96, 720, 'linear')] },
    { id: 'fk', targetId: 'shoulder', channel: 'rotation.z', keys: [key('fk0', 0, -30), key('fk1', 48, 30), key('fk2', 96, -30)] },
  ] };
  doc.drivenKeys = [{ id: 'response', driver: { targetId: 'study', channel: 'position.y' }, driven: { targetId: 'driven', channel: 'rotation.z' },
    keys: [key('response0', 0, 0), key('response1', 1.5, 90)] }];
  const bytes = await encodeProject(doc, new Map(), {
    camera: { position: [7, 5, 12], target: [0, .7, 0], fov: 42, near: .01, far: 1000 }, time: 0,
  });
  await mkdir('examples', { recursive: true });
  await writeFile('examples/animation-study.msb', bytes);
  console.log(`Wrote examples/animation-study.msb (${bytes.length} bytes)`);
} finally { await server.close(); }
