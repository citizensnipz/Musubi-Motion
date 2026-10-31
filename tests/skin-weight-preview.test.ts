import { describe, expect, it, vi } from "vitest";
import { Color, Object3D, Vector3 } from "three";
import { createSkinWeightPreview } from "../src/skin-weight-preview.ts";

describe("skin weight preview", () => {
  it("uses mesh-local skinned positions and maps zero/one weights to the color ramp", () => {
    const parent = new Object3D(); parent.position.set(4, 2, 0);
    const preview = createSkinWeightPreview();
    preview.update(parent, new Float32Array([1, 0, 0, NaN, NaN, NaN, 0, 1, 0]), [0, .5, 1]);
    parent.updateMatrixWorld(true);
    expect(new Vector3(1, 0, 0).applyMatrix4(preview.points.matrixWorld).toArray()).toEqual([5, 2, 0]);
    expect(preview.points.geometry.drawRange.count).toBe(2);
    const colors = preview.points.geometry.getAttribute("color").array;
    const first = new Color("#285ea8"); const last = new Color("#ff6a38");
    expect(colors[0]).toBeCloseTo(first.r); expect(colors[5]).toBeCloseTo(last.b);
    expect(preview.points.visible).toBe(true);
    preview.dispose();
  });
  it("rejects invalid rows atomically and reuses equal-length buffers", () => {
    const parent = new Object3D(), preview = createSkinWeightPreview();
    preview.update(parent, new Float32Array([1, 2, 3]), [.2]);
    const position = preview.points.geometry.getAttribute("position");
    expect(() => preview.update(new Object3D(), new Float32Array([4, 5, 6]), [2])).toThrow();
    expect(preview.points.parent).toBe(parent);
    expect([...position.array.slice(0, 3)]).toEqual([1, 2, 3]);
    preview.update(parent, new Float32Array([4, 5, 6]), [.7]);
    expect(preview.points.geometry.getAttribute("position")).toBe(position);
    expect([...position.array.slice(0, 3)]).toEqual([4, 5, 6]);
    preview.dispose();
  });
  it("clears stale overlays and disposes exactly once", () => {
    const preview = createSkinWeightPreview(), parent = new Object3D();
    const geometryDispose = vi.fn(), materialDispose = vi.fn();
    preview.points.geometry.addEventListener("dispose", geometryDispose);
    preview.points.material.addEventListener("dispose", materialDispose);
    preview.update(parent, new Float32Array([0, 0, 0]), [1]);
    preview.setVisible(false); expect(preview.points.visible).toBe(false);
    preview.setVisible(true); expect(preview.points.visible).toBe(true);
    preview.clear(); preview.setVisible(true);
    expect(preview.points.parent).toBeNull(); expect(preview.points.visible).toBe(false);
    preview.dispose(); preview.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1); expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(() => preview.update(parent, new Float32Array(), [])).toThrow(/disposed/);
  });
});
