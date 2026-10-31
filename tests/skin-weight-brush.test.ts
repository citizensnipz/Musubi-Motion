import { describe, expect, it, vi } from "vitest";
import { Matrix4, OrthographicCamera } from "three";
import { createSkinBrushIndex, createSkinBrushStroke, type SkinBrushOptions } from "../src/skin-weight-brush.ts";
import type { ComponentProjectionOptions } from "../src/component-picking.ts";

function projection(points: number[][], patch: Partial<ComponentProjectionOptions> = {}): ComponentProjectionOptions {
  const data = new Float32Array(points.flatMap(([x, y, z = -2]) => [x, 100 - y, z]));
  return { componentCount: points.length, readPositions: (start, count) => data.slice(start * 3, (start + count) * 3),
    matrixWorld: new Matrix4(), camera: new OrthographicCamera(0, 100, 100, 0, 1, 10), width: 100, height: 100,
    yieldTask: async () => {}, ...patch };
}
const defaults: SkinBrushOptions = { radius: 10, strength: 0.5, value: 1, mode: "replace", getWeight: () => 0.2 };

describe("skin brush spatial index", () => {
  it("queries inclusive grid boundaries with stable original indices and clipped centers", async () => {
    const index = await createSkinBrushIndex(projection([[31, 50], [32, 50], [64, 50], [NaN, 50], [50, 50, 2], [50, 50, -11], [101, 50]]));
    expect(index.componentCount).toBe(7); expect(index.visibleCount).toBe(3); expect(index.cellSize).toBe(32);
    const visit = vi.fn(); index.query(32, 40, 64, 60, visit);
    expect(visit.mock.calls.map(call => call[0])).toEqual([1, 2]);
    visit.mockClear(); index.query(-100, -100, -1, -1, visit); expect(visit).not.toHaveBeenCalled();
    expect(() => index.query(1, 0, 0, 1, visit)).toThrow(/bounds/);
  });

  it("snapshots projection and preserves component IDs across chunk boundaries", async () => {
    const data = new Float32Array(4097 * 3).fill(NaN); data.set([50, 50, -2], 4096 * 3);
    const options = projection([], { componentCount: 4097, readPositions: (start, count) => data.slice(start * 3, (start + count) * 3) });
    options.yieldTask = async () => { options.matrixWorld.makeTranslation(500, 0, 0); options.camera.projectionMatrix.makeScale(500, 500, 500); };
    const index = await createSkinBrushIndex(options), ids: number[] = [];
    index.query(0, 0, 100, 100, id => ids.push(id)); expect(ids).toEqual([4096]);
  });

  it("grows dense grid buckets without losing or inventing overlapping component IDs", async () => {
    const index = await createSkinBrushIndex(projection(Array.from({ length: 1025 }, () => [50, 50])));
    const ids: number[] = []; index.query(49, 49, 51, 51, id => ids.push(id));
    expect(ids).toEqual(Array.from({ length: 1025 }, (_, index) => index));
    expect(index.visibleCount).toBe(1025);
  });

  it("cancels index construction before reading and after an asynchronous chunk", async () => {
    const readPositions = vi.fn((_start: number, count: number) => new Float32Array(count * 3).fill(NaN));
    await expect(createSkinBrushIndex(projection([], { componentCount: 1, readPositions, cancelled: () => true }))).rejects.toMatchObject({ name: "AbortError" });
    expect(readPositions).not.toHaveBeenCalled();
    let cancelled = false;
    await expect(createSkinBrushIndex(projection([], { componentCount: 4097, readPositions, cancelled: () => cancelled, yieldTask: async () => { cancelled = true; } }))).rejects.toMatchObject({ name: "AbortError" });
    expect(readPositions.mock.calls).toEqual([[0, 4096]]);
  });
});

describe("skin brush strokes", () => {
  it("paints a continuous capsule including its end caps with smooth distance falloff", async () => {
    const index = await createSkinBrushIndex(projection([[50, 50], [50, 55], [15, 50], [10, 50], [50, 61], [85, 50]]));
    const stroke = createSkinBrushStroke(index, defaults);
    stroke.addSegment({ x: 20, y: 50 }, { x: 80, y: 50 });
    expect(stroke.affectedCount).toBe(4);
    const values = stroke.values(); expect(values.map(value => value.index)).toEqual([0, 1, 2, 5]);
    expect(values[0].weight).toBeCloseTo(0.6);
    for (const value of values.slice(1)) expect(value.weight).toBeCloseTo(0.4);
  });

  it("handles a stationary stamp and replace/add/subtract modes with clamping", async () => {
    const index = await createSkinBrushIndex(projection([[50, 50]])), point = { x: 50, y: 50 };
    for (const [mode, expected] of [["replace", 0.3], ["add", 0.4], ["subtract", 0]] as const) {
      const stroke = createSkinBrushStroke(index, { ...defaults, mode, value: 0.4 });
      stroke.addSegment(point, point); expect(stroke.values()[0].weight).toBeCloseTo(expected);
    }
    const add = createSkinBrushStroke(index, { ...defaults, mode: "add", strength: 1, getWeight: () => 0.9 });
    add.addSegment(point, point); expect(add.values()).toEqual([{ index: 0, weight: 1 }]);
    const subtract = createSkinBrushStroke(index, { ...defaults, mode: "subtract", strength: 1, getWeight: () => 0.1 });
    subtract.addSegment(point, point); expect(subtract.values()).toEqual([{ index: 0, weight: 0 }]);
  });

  it("does not accumulate repeated passes and is independent of pointer event density", async () => {
    const index = await createSkinBrushIndex(projection([[20, 50], [50, 54], [80, 55]]));
    const coarse = createSkinBrushStroke(index, defaults), getWeight = vi.fn(() => 0.2);
    const dense = createSkinBrushStroke(index, { ...defaults, getWeight });
    coarse.addSegment({ x: 10, y: 50 }, { x: 90, y: 50 });
    for (let pass = 0; pass < 3; pass++) for (let x = 10; x < 90; x += 5) dense.addSegment({ x, y: 50 }, { x: x + 5, y: 50 });
    expect(dense.values()).toEqual(coarse.values()); expect(getWeight).toHaveBeenCalledTimes(3);
  });

  it("keeps the original weight snapshot when later segments increase coverage", async () => {
    const index = await createSkinBrushIndex(projection([[50, 50]]));
    let weight = 0.2;
    const getWeight = vi.fn(() => weight), stroke = createSkinBrushStroke(index, { ...defaults, getWeight });
    stroke.addSegment({ x: 50, y: 55 }, { x: 50, y: 55 }); weight = 0.9;
    stroke.addSegment({ x: 50, y: 50 }, { x: 50, y: 50 });
    expect(stroke.values()[0].weight).toBeCloseTo(0.6); expect(getWeight).toHaveBeenCalledTimes(1);
  });

  it("only reads weights from intersecting nearby grid candidates", async () => {
    const index = await createSkinBrushIndex(projection([[10, 10], [11, 10], [50, 50], [95, 95]]));
    const getWeight = vi.fn(() => 0.2), stroke = createSkinBrushStroke(index, { ...defaults, radius: 2, getWeight });
    stroke.addSegment({ x: 10, y: 10 }, { x: 10, y: 10 });
    expect(getWeight.mock.calls.map(call => call[0])).toEqual([0, 1]);
  });

  it("invalidates the entire stroke on overflow, preventing a partial values commit", async () => {
    const index = await createSkinBrushIndex(projection([[20, 50], [50, 50], [80, 50]]));
    const stroke = createSkinBrushStroke(index, { ...defaults, limit: 2 });
    stroke.addSegment({ x: 20, y: 50 }, { x: 20, y: 50 });
    expect(() => stroke.addSegment({ x: 20, y: 50 }, { x: 80, y: 50 })).toThrow(/exceeds the 2/);
    expect(stroke.affectedCount).toBe(0); expect(() => stroke.values()).toThrow(/exceeds/);
    expect(() => stroke.addSegment({ x: 20, y: 50 }, { x: 20, y: 50 })).toThrow(/exceeds/);
  });

  it("omits unchanged results and treats zero strength as a no-op", async () => {
    const index = await createSkinBrushIndex(projection([[50, 50]])), point = { x: 50, y: 50 };
    for (const patch of [{ strength: 0 }, { value: 0.2 }, { mode: "add" as const, value: 0 }]) {
      const stroke = createSkinBrushStroke(index, { ...defaults, ...patch }); stroke.addSegment(point, point);
      expect(stroke.values()).toEqual([]);
    }
    const stroke = createSkinBrushStroke(index, { ...defaults, value: 0.2 }); stroke.addSegment(point, point);
    expect(stroke.affectedCount).toBe(1);
  });

  it("validates settings and invalidates bad position or original weight data", async () => {
    const index = await createSkinBrushIndex(projection([[50, 50]]));
    for (const patch of [{ radius: 0 }, { radius: 257 }, { strength: NaN }, { strength: -1 }, { value: 2 }, { limit: 20001 }, { limit: 0 }]) expect(() => createSkinBrushStroke(index, { ...defaults, ...patch })).toThrow();
    const stroke = createSkinBrushStroke(index, defaults);
    expect(() => stroke.addSegment({ x: NaN, y: 0 }, { x: 1, y: 1 })).toThrow(/finite/);
    expect(() => stroke.values()).toThrow(/finite/);
    const badWeight = createSkinBrushStroke(index, { ...defaults, getWeight: () => Infinity });
    expect(() => badWeight.addSegment({ x: 50, y: 50 }, { x: 50, y: 50 })).toThrow(/weights/);
    expect(() => badWeight.values()).toThrow(/weights/);
  });
});
