// Original procedural data in standard 32-byte .splat records.
import { writeFile } from "node:fs/promises";

const records = [];
const layers = [
  { center: -1, z: 0, color: [216, 104, 73] },
  { center: 1, z: 0, color: [75, 163, 226] },
  { center: -1, z: -.7, color: [103, 199, 124] },
];
for (const { center, z, color } of layers) {
  for (let row = -2; row <= 2; row++) for (let column = -2; column <= 2; column++) {
    records.push({ x: center + column / 10, y: row / 10, z, color, opacity: 255 });
  }
}
for (let i = 0; i <= 10; i++) {
  records.push({ x: (i - 5) / 4, y: -.75 + Math.sin(i * Math.PI / 5) * .08, z: 0, color: [213, 179, 85], opacity: 255 });
}
records.push({ x: 0, y: 0, z: 0, color: [255, 255, 255], opacity: 0 });
const bytes = Buffer.alloc(records.length * 32);
for (const [index, record] of records.entries()) {
  const offset = index * 32;
  [record.x, record.y, record.z, .027, .027, .013].forEach((value, component) => bytes.writeFloatLE(value, offset + component * 4));
  bytes.set([...record.color, record.opacity, 255, 128, 128, 128], offset + 24);
}
await writeFile(new URL("../examples/splat-gesture-regions.splat", import.meta.url), bytes);
console.log(`${records.length} original splats, ${bytes.length} bytes`);
