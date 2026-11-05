// Original procedural data; no external asset or model obligations. Standard 32-byte .splat records.
import { writeFile, mkdir } from "node:fs/promises";
const values = [];
for (const [x, z, color] of [[-1, 0, [220, 100, 70]], [1, 0, [70, 160, 220]], [-1, -1, [100, 200, 100]]]) {
  for (let row = 0; row < 12; row++) for (let col = 0; col < 12; col++) values.push({ x: x + (col - 5.5) * .045, y: (row - 5.5) * .045, z, color, opacity: 255 });
}
values.push({ x: 0, y: .8, z: 0, color: [255, 255, 255], opacity: 0 });
const bytes = Buffer.alloc(values.length * 32);
values.forEach((s, index) => { const offset = index * 32;
  [s.x, s.y, s.z, .025, .025, .012].forEach((value, component) => bytes.writeFloatLE(value, offset + component * 4));
  bytes.set([...s.color, s.opacity, 255, 128, 128, 128], offset + 24);
});
await mkdir(new URL("../examples/", import.meta.url), { recursive: true });
await writeFile(new URL("../examples/splat-selection-regions.splat", import.meta.url), bytes);
console.log(`${values.length} original splats, ${bytes.length} bytes`);
