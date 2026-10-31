import { BufferGeometry, Color, Float32BufferAttribute, Object3D, Points, PointsMaterial } from "three";

/** Paused, sampled component overlay; positions are already skinned in mesh-local space. */
export function createSkinWeightPreview() {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(5000 * 3), 3));
  geometry.setAttribute("color", new Float32BufferAttribute(new Float32Array(5000 * 3), 3));
  geometry.setDrawRange(0, 0);
  const material = new PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true,
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const points = new Points(geometry, material);
  points.name = "Skin weight preview";
  points.renderOrder = 10000;
  points.frustumCulled = false;
  points.visible = false;
  points.raycast = () => {};
  const low = new Color("#285ea8"), high = new Color("#ff6a38");
  let populated = false, disposed = false;
  return {
    points,
    update(parent: Object3D, positions: Float32Array, weights: readonly number[]) {
      if (disposed) throw Error("Skin weight preview was disposed.");
      if (positions.length !== weights.length * 3 || weights.length > 5000
        || weights.some(weight => !Number.isFinite(weight) || weight < 0 || weight > 1)) {
        throw Error("Skin weight preview needs at most 5,000 positions and weights between 0 and 1.");
      }
      const visible: number[] = [], colors: number[] = [];
      const color = new Color();
      for (let index = 0; index < weights.length; index++) {
        const position = positions.subarray(index * 3, index * 3 + 3);
        // Hidden/transparent source components use NaN positions, like object selection.
        if (![...position].every(Number.isFinite)) continue;
        visible.push(...position);
        color.copy(low).lerp(high, weights[index]); colors.push(color.r, color.g, color.b);
      }
      geometry.getAttribute("position").array.set(visible);
      geometry.getAttribute("color").array.set(colors);
      geometry.getAttribute("position").needsUpdate = true;
      geometry.getAttribute("color").needsUpdate = true;
      geometry.setDrawRange(0, visible.length / 3);
      populated = visible.length > 0;
      if (points.parent !== parent) parent.add(points);
      points.visible = populated;
    },
    setVisible(visible: boolean) { points.visible = !disposed && populated && visible; },
    clear() { populated = false; points.visible = false; points.removeFromParent(); },
    dispose() {
      if (disposed) return;
      disposed = true; populated = false; points.removeFromParent(); points.visible = false;
      geometry.dispose(); material.dispose();
    },
  };
}
