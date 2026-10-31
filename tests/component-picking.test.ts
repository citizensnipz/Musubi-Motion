import { describe, expect, it, vi } from "vitest";
import { Matrix4, Object3D, OrthographicCamera, PerspectiveCamera, WebGPUCoordinateSystem } from "three";
import { pickProjectedComponents, type ComponentPickOptions } from "../src/component-picking.ts";

function options(points: number[][], patch: Partial<ComponentPickOptions> = {}): ComponentPickOptions {
  const positions = new Float32Array(points.flat());
  return { componentCount: points.length, readPositions: (start, count) => positions.slice(start * 3, (start + count) * 3),
    matrixWorld: new Matrix4(), camera: new PerspectiveCamera(90, 1, 1, 10), width: 100, height: 100,
    start: { x: 40, y: 40 }, end: { x: 60, y: 60 }, yieldTask: async () => {}, ...patch };
}

describe("projected component selection", () => {
  it("selects perspective centers through geometry without occlusion and sorts stable global indices", async () => {
    const result = await pickProjectedComponents(options([[0, 0, -2], [0, 0, -8], [1, 0, -2], [0.2, 0.2, -4]]));
    expect(result).toEqual([0, 1, 3]);
  });
  it("supports orthographic cameras and reversed inclusive marquee bounds", async () => {
    const camera = new OrthographicCamera(-50, 50, 50, -50, 1, 9);
    expect(await pickProjectedComponents(options([[-10, 10, -2], [10, -10, -8], [11, 0, -2]], { camera, start: { x: 60, y: 60 }, end: { x: 40, y: 40 } }))).toEqual([0, 1]);
  });
  it("applies parent transforms and updates camera parent world matrices once", async () => {
    const parent = new Object3D(); parent.position.set(2, 3, 0); parent.rotation.z = Math.PI / 2;
    const child = new Object3D(); child.position.set(1, 0, -4); parent.add(child); parent.updateMatrixWorld(true);
    const cameraParent = new Object3D(); cameraParent.position.set(2, 4, 0);
    const camera = new PerspectiveCamera(90, 1, 1, 10); cameraParent.add(camera);
    expect(await pickProjectedComponents(options([[0, 0, 0], [3, 0, 0]], { camera, matrixWorld: child.matrixWorld }))).toEqual([0]);
  });
  it("excludes near/far clipped, offscreen, behind-camera and nonfinite positions", async () => {
    expect(await pickProjectedComponents(options([[0, 0, -2], [0, 0, -0.5], [0, 0, -11], [20, 0, -2], [0, 0, 2], [NaN, 0, -2], [0, Infinity, -2]], { start: { x: -1000, y: -1000 }, end: { x: 1000, y: 1000 } }))).toEqual([0]);
    const camera = new OrthographicCamera(-1, 1, 1, -1, -5, 10);
    expect(await pickProjectedComponents(options([[0, 0, 2], [0, 0, -2]], { camera }))).toEqual([1]);
  });
  it("uses the correct near clip range for WebGPU projection matrices", async () => {
    const camera = new PerspectiveCamera(90, 1, 1, 10); camera.coordinateSystem = WebGPUCoordinateSystem; camera.updateProjectionMatrix();
    expect(await pickProjectedComponents(options([[0, 0, -0.75], [0, 0, -2]], { camera }))).toEqual([1]);
  });
  it("clicks within eight CSS pixels, resolving screen-distance ties by depth then index", async () => {
    const camera = new OrthographicCamera(-50, 50, 50, -50, 1, 10), click = { start: { x: 50, y: 50 }, end: { x: 50, y: 50 }, camera };
    expect(await pickProjectedComponents(options([[0, 0, -8], [0, 0, -2], [0, 0, -2]], click))).toEqual([1]);
    expect(await pickProjectedComponents(options([[1, 0, -2], [0, 0, -8]], click))).toEqual([1]);
    expect(await pickProjectedComponents(options([[8, 0, -2], [9, 0, -2]], click))).toEqual([0]);
    expect(await pickProjectedComponents(options([[9, 0, -2]], click))).toEqual([]);
  });
  it("uses the release point for short clicks and treats exactly four-pixel drags as rectangles", async () => {
    const camera = new OrthographicCamera(-50, 50, 50, -50, 1, 10);
    expect(await pickProjectedComponents(options([[0, 0, -2], [3, 0, -2]], { camera, start: { x: 50, y: 50 }, end: { x: 53, y: 50 } }))).toEqual([1]);
    expect(await pickProjectedComponents(options([[0, 0, -2], [4, 0, -2]], { camera, start: { x: 50, y: 50 }, end: { x: 54, y: 50 } }))).toEqual([0, 1]);
  });
  it("reads bounded chunks, preserves global indices and yields only between chunks", async () => {
    const positions = new Float32Array(8200 * 3).fill(NaN), selected = [0, 4095, 4096, 8191, 8192, 8199];
    selected.forEach(index => positions.set([0, 0, -3], index * 3));
    const readPositions = vi.fn((start, count) => positions.slice(start * 3, (start + count) * 3)), yieldTask = vi.fn(async () => {});
    expect(await pickProjectedComponents(options([], { componentCount: 8200, readPositions, yieldTask }))).toEqual(selected);
    expect(readPositions.mock.calls).toEqual([[0, 4096], [4096, 4096], [8192, 8]]); expect(yieldTask).toHaveBeenCalledTimes(2);
    yieldTask.mockClear(); await pickProjectedComponents(options([[0, 0, -3]], { yieldTask })); expect(yieldTask).not.toHaveBeenCalled();
  });
  it("snapshots camera, object matrix and gesture coordinates across asynchronous chunks", async () => {
    const positions = new Float32Array(4097 * 3).fill(NaN); positions.set([0, 0, -3], 4096 * 3);
    const input = options([], { componentCount: 4097, readPositions: (start, count) => positions.slice(start * 3, (start + count) * 3) });
    input.yieldTask = async () => { input.camera.position.set(100, 0, 0); input.camera.projectionMatrix.makeScale(100, 100, 100); input.matrixWorld.makeTranslation(100, 0, 0); input.end.x = 0; };
    expect(await pickProjectedComponents(input)).toEqual([4096]);
  });
  it("cancels before reads, after yielding and immediately before returning", async () => {
    const readPositions = vi.fn(() => new Float32Array([0, 0, -3]));
    await expect(pickProjectedComponents(options([[0, 0, -3]], { readPositions, cancelled: () => true }))).rejects.toMatchObject({ name: "AbortError" }); expect(readPositions).not.toHaveBeenCalled();
    let cancelled = false, reads = 0;
    await expect(pickProjectedComponents(options([], { componentCount: 4097, readPositions: (_start, count) => { reads++; return new Float32Array(count * 3).fill(NaN); }, cancelled: () => cancelled, yieldTask: async () => { cancelled = true; } }))).rejects.toMatchObject({ name: "AbortError" }); expect(reads).toBe(1);
    let checks = 0;
    await expect(pickProjectedComponents(options([[0, 0, -3]], { cancelled: () => ++checks === 4 }))).rejects.toMatchObject({ name: "AbortError" });
  });
  it("rejects selection overflow atomically while clicks still return at most one component", async () => {
    const points = Array.from({ length: 3 }, () => [0, 0, -3]);
    await expect(pickProjectedComponents(options(points, { limit: 2 }))).rejects.toThrow(/exceeds the 2 component limit/);
    expect(await pickProjectedComponents(options(points, { limit: 1, start: { x: 50, y: 50 }, end: { x: 50, y: 50 } }))).toEqual([0]);
    await expect(pickProjectedComponents(options([], { componentCount: 20001, readPositions: (_start, count) => { const values = new Float32Array(count * 3); for (let index = 0; index < count; index++) values[index * 3 + 2] = -3; return values; } }))).rejects.toThrow(/20,000/);
  });
  it("validates bounds, counts, matrices and exact position-buffer length", async () => {
    for (const patch of [{ componentCount: -1 }, { componentCount: 1.5 }, { width: 0 }, { height: Infinity }, { limit: 0 }, { limit: 20001 }, { end: { x: NaN, y: 0 } }]) await expect(pickProjectedComponents(options([[0, 0, -3]], patch))).rejects.toThrow();
    for (const readPositions of [() => new Float32Array(2), () => new Float32Array(6), () => [0, 0, -3] as unknown as Float32Array]) await expect(pickProjectedComponents(options([[0, 0, -3]], { readPositions }))).rejects.toThrow(/exactly three Float32/);
    const invalid = new Matrix4(); invalid.elements[0] = NaN;
    await expect(pickProjectedComponents(options([[0, 0, -3]], { matrixWorld: invalid }))).rejects.toThrow(/finite values/);
    expect(await pickProjectedComponents(options([]))).toEqual([]);
  });
});
