/** Canonical boundary identity, independent of starting corner and winding.
 * Callers validate unique corners first, so the smallest ID anchors both
 * orientations in linear time. This compares topology, not geometric overlap. */
export function faceCycle(vertices: readonly string[]): string {
  let start = 0;
  for (let index = 1; index < vertices.length; index++) if (vertices[index] < vertices[start]) start = index;
  const forward = vertices.map((_, index) => vertices[(start + index) % vertices.length]);
  const backward = vertices.map((_, index) => vertices[(start - index + vertices.length) % vertices.length]);
  const a = JSON.stringify(forward), b = JSON.stringify(backward);
  return a < b ? a : b;
}
