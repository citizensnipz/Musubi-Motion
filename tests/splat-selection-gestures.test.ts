import { describe, expect, it, vi } from "vitest";
import { Matrix4, OrthographicCamera } from "three";
import { combineSplatSelection, pickSplatRegion } from "../src/splat-component-selection.ts";
import { createSplatBrushStroke, createSplatLasso, splatBrushRegion, splatLassoRegion } from "../src/splat-selection-gestures.ts";

const point = (x: number, y: number) => ({ x, y });
const rectangle = (left: number, top: number, right: number, bottom: number) =>
  [point(left, top), point(right, top), point(right, bottom), point(left, bottom)];

function scanOptions(positions: Float32Array) {
  return {
    camera: new OrthographicCamera(-50, 50, 50, -50, 1, 10), matrixWorld: new Matrix4(), width: 100, height: 100,
    componentCount: positions.length / 3, readPositions: (offset: number, count: number) => positions.subarray(offset * 3, (offset + count) * 3),
    depth: "through" as const, yieldTask: async () => {},
  };
}

describe("splat lasso", () => {
  it("preserves a subpixel region and includes the actual polygon boundary", () => {
    const contains = splatLassoRegion(rectangle(30, 49.98, 70, 50.02))!;
    expect(contains(50, 50)).toBe(true);
    expect(contains(50, 49.98)).toBe(true);
    expect(contains(70, 50)).toBe(true);
    expect(contains(50, 49.979)).toBe(false);
    expect(contains(70.01, 50)).toBe(false);
  });

  it("closes the path and applies even-odd fill to both lobes of a self crossing", () => {
    const contains = splatLassoRegion([point(0, 0), point(10, 10), point(0, 10), point(10, 0)])!;
    expect(contains(5, 2)).toBe(true);
    expect(contains(5, 8)).toBe(true);
    expect(contains(5, 5)).toBe(true);
    expect(contains(3, 5)).toBe(false);
    expect(contains(5, 0)).toBe(true);
  });

  it("ignores clicks, duplicate samples and collinear paths, and rejects invalid coordinates", () => {
    const lasso = createSplatLasso(point(10, 10));
    lasso.add(point(10, 10));
    expect(lasso.points).toHaveLength(1);
    expect(splatLassoRegion(lasso.points)).toBeUndefined();
    lasso.add(point(20, 10)); lasso.add(point(5, 10));
    expect(splatLassoRegion(lasso.points)).toBeUndefined();
    expect(() => lasso.add(point(Infinity, 10))).toThrow(/finite/);
  });
});

describe("splat paint selection", () => {
  it("uses arc length across event boundaries and includes the exact release position", () => {
    const dense = createSplatBrushStroke(point(0, 0), 6, 4);
    for (let x = 1; x < 14; x++) dense.add(point(x, 0));
    dense.finish(point(14, 0));
    const sparse = createSplatBrushStroke(point(0, 0), 6, 4);
    sparse.finish(point(14, 0));
    expect(sparse.points).toEqual([0, 4, 8, 12, 14].map(x => point(x, 0)));
    expect(dense.points).toEqual(sparse.points);
    const corner = createSplatBrushStroke(point(0, 0), 6, 4);
    corner.add(point(3, 0)); corner.finish(point(3, 5));
    expect(corner.points).toEqual([point(0, 0), point(3, 1), point(3, 5)]);
  });

  it("selects a tap or continuous dabs and treats repeated visits as one hit per original", async () => {
    const brush = createSplatBrushStroke(point(40, 50), 4, 4);
    brush.add(point(60, 50)); brush.add(point(40, 50)); brush.finish(point(60, 50));
    const contains = splatBrushRegion(brush.points, 4);
    expect(contains(40, 46)).toBe(true);
    expect(contains(40, 45.999)).toBe(false);
    expect(contains(42, 50)).toBe(true);
    const hits = await pickSplatRegion(scanOptions(new Float32Array([-10, 0, -2, 10, 0, -2, 20, 0, -2])), contains);
    expect([...hits]).toEqual([0, 1]);
    expect([...combineSplatSelection([0, 2], hits, "toggle", 3)]).toEqual([1, 2]);
    const tap = createSplatBrushStroke(point(12, 8), 4, 2);
    tap.finish(point(12, 8));
    expect(tap.points).toEqual([point(12, 8)]);
    expect(splatBrushRegion(tap.points, 4)(16, 8)).toBe(true);
  });

  it("validates radius and spacing and rejects overlong traces", () => {
    expect(() => createSplatBrushStroke(point(0, 0), 257, 1)).toThrow(/radius/);
    expect(() => createSplatBrushStroke(point(0, 0), 8, 9)).toThrow(/spacing/);
    expect(() => createSplatBrushStroke(point(0, 0), 8, NaN)).toThrow(/spacing/);
    const stroke = createSplatBrushStroke(point(0, 0), 1, 1);
    expect(() => stroke.finish(point(8200, 0))).toThrow(/too long/);
    expect(() => splatBrushRegion([], 0)).toThrow(/radius/);
  });
});

describe("shared original-ID region projection", () => {
  it.each([
    splatLassoRegion(rectangle(42, 42, 58, 58))!,
    splatBrushRegion([point(50, 50)], 8),
  ])("shares clipping, posed centers, inactive/transparent exclusion and front cells", async contains => {
    const options = scanOptions(new Float32Array([
      -20, 0, -8, -20, 0, -2, NaN, NaN, NaN, -20, 0, 2, -20, 0, -11, 80, 0, -3,
    ]));
    options.matrixWorld.makeTranslation(20, 0, 0);
    expect([...await pickSplatRegion(options, contains)]).toEqual([0, 1]);
    expect([...await pickSplatRegion({ ...options, depth: "front-centers" }, contains)]).toEqual([1]);
  });

  it("keeps all dense memberships, yields in chunks, and rejects cancellation atomically", async () => {
    const count = 100_000, positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { positions[i * 3] = i % 100 - 50; positions[i * 3 + 2] = -2; }
    const stroke = createSplatBrushStroke(point(0, 50), 4, 2);
    stroke.finish(point(100, 50));
    const options = scanOptions(positions), yields = vi.fn(async () => {});
    const hits = await pickSplatRegion({ ...options, yieldTask: yields }, splatBrushRegion(stroke.points, 4));
    expect(hits).toHaveLength(count);
    expect(hits[0]).toBe(0);
    expect(hits[count - 1]).toBe(count - 1);
    expect(yields).toHaveBeenCalledTimes(Math.ceil(count / 4096) - 1);
    let cancelled = false;
    const readPositions = vi.fn(options.readPositions);
    await expect(pickSplatRegion({ ...options, readPositions, cancelled: () => cancelled, yieldTask: async () => { cancelled = true; } },
      splatBrushRegion(stroke.points, 4))).rejects.toMatchObject({ name: "AbortError" });
    expect(readPositions.mock.calls).toEqual([[0, 4096]]);
  });

  it("rejects pathological coverage work without returning a partial selection", async () => {
    const positions = new Float32Array(4096 * 3);
    for (let i = 0; i < 4096; i++) { positions[i * 3] = 49; positions[i * 3 + 2] = -2; }
    const points = Array.from({ length: 8192 }, (_, i) => point(i / 100, i % 2 * 100));
    points[8190].x = 100;
    await expect(pickSplatRegion(scanOptions(positions), splatLassoRegion(points)!)).rejects.toThrow(/complex/);
  });
});
