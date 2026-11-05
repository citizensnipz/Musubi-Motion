import { describe, it, expect, vi } from "vitest";
import { Matrix4, OrthographicCamera, PerspectiveCamera, Vector3, Object3D } from "three";
import type { SplatMesh } from "@sparkjsdev/spark";
import { combineSplatSelection, pickSplatComponents, readOriginalSplatPositions, splatSelectionOperation, splatHighlightIndices } from "../src/splat-component-selection.ts";
import { createSplatComponentPreview } from "../src/splat-component-preview.ts";

function options(points: number[][], patch = {}) {
  const values = new Float32Array(points.flat());
  return { componentCount: points.length, readPositions: (start: number, count: number) => values.slice(start * 3, (start + count) * 3),
    matrixWorld: new Matrix4(), camera: new OrthographicCamera(-50, 50, 50, -50, 1, 10), width: 100, height: 100,
    start: { x: 40, y: 40 }, end: { x: 60, y: 60 }, depth: "through" as const, yieldTask: async () => {}, ...patch };
}

describe("original splat component selection", () => {
  it("maps Maya replace/toggle/subtract/add modifiers", () => {
    expect(splatSelectionOperation(false, false)).toBe("replace");
    expect(splatSelectionOperation(true, false)).toBe("toggle");
    expect(splatSelectionOperation(false, true)).toBe("subtract");
    expect(splatSelectionOperation(true, true)).toBe("add");
    const original = [1, 4];
    expect(combineSplatSelection(original, [2, 4, 2], "replace", 6)).toEqual(new Uint32Array([2, 4]));
    expect(combineSplatSelection(original, [2, 4], "add", 6)).toEqual(new Uint32Array([1, 2, 4]));
    expect(combineSplatSelection(original, [2, 4], "subtract", 6)).toEqual(new Uint32Array([1]));
    expect(combineSplatSelection(original, [2, 4, 4], "toggle", 6)).toEqual(new Uint32Array([1, 2]));
    expect(original).toEqual([1, 4]);
  });
  it("rejects invalid stable IDs and over-limit union atomically", () => {
    for (const value of [-1, 3, .5, Infinity, NaN]) expect(() => combineSplatSelection([0], [value], "add", 3)).toThrow(/index/);
    const previous = Array.from({ length: 1_000_000 }, (_, index) => index);
    expect(() => combineSplatSelection(previous, [1_000_000], "add", 1_000_001)).toThrow(/1,000,000/);
    expect(previous).toHaveLength(1_000_000);
    expect(combineSplatSelection(previous, [0], "subtract", 1_000_001)).toHaveLength(999_999);
  });
  it("through selects both depths while front centers selects stable nearest per cell", async () => {
    const points = [[0, 0, -8], [0, 0, -2], [1, 0, -2], [8, 0, -5], [0, 0, -2]];
    expect(await pickSplatComponents(options(points))).toEqual(new Uint32Array([0, 1, 2, 3, 4]));
    expect(await pickSplatComponents({ ...options(points), depth: "front-centers" })).toEqual(new Uint32Array([1, 3]));
  });
  it("clicks use nearest screen center, then depth and source index, within 8 CSS px", async () => {
    expect(await pickSplatComponents(options([[0, 0, -8], [0, 0, -2], [0, 0, -2]], { start: { x: 50, y: 50 }, end: { x: 50, y: 50 } }))).toEqual(new Uint32Array([1]));
    expect(await pickSplatComponents(options([[9, 0, -2]], { start: { x: 50, y: 50 }, end: { x: 50, y: 50 } }))).toEqual(new Uint32Array([]));
    expect(await pickSplatComponents({ ...options([[0, 0, -8], [0, 0, -2]]), depth: "front-centers", start: { x: 50, y: 50 }, end: { x: 50, y: 50 } })).toEqual(new Uint32Array([1]));
  });
  it("applies local-to-world pose and camera clipping, excluding transparent NaN centers", async () => {
    expect(await pickSplatComponents(options([[0, 0, -2], [NaN, 0, -2], [0, 0, -11], [0, 0, 2], [100, 0, -2]]))).toEqual(new Uint32Array([0]));
    expect(await pickSplatComponents(options([[-20, 0, 0], [0, 0, 0]], { matrixWorld: new Matrix4().makeTranslation(20, 0, -3) }))).toEqual(new Uint32Array([0]));
    expect(await pickSplatComponents(options([[0, 0, -2]], { camera: new PerspectiveCamera(90, 1, 1, 10) }))).toEqual(new Uint32Array([0]));
  });
  it("cancels an asynchronous scan before applying anything and preserves stable offsets", async () => {
    let canceled = false;
    const read = vi.fn((_start: number, count: number) => new Float32Array(count * 3).fill(NaN));
    await expect(pickSplatComponents({ ...options([]), componentCount: 8200, readPositions: read, cancelled: () => canceled,
      yieldTask: async () => { canceled = true; } })).rejects.toMatchObject({ name: "AbortError" });
    expect(read.mock.calls).toEqual([[0, 4096]]);
    const points = Array.from({ length: 4100 }, () => [100, 0, -3]); points[4099] = [0, 0, -3];
    expect(await pickSplatComponents(options(points))).toEqual(new Uint32Array([4099]));
  });
  it("rejects excess hits instead of silently truncating and bounds front cell memory", async () => {
    await expect(pickSplatComponents(options(Array.from({ length: 1_000_001 }, () => [0, 0, -3])))).rejects.toThrow(/1,000,000/);
    await expect(pickSplatComponents({ ...options([]), width: 100_000, height: 100_000, depth: "front-centers" })).rejects.toThrow(/screen cells/);
    await expect(pickSplatComponents(options([], { end: { x: NaN, y: 50 } }))).rejects.toThrow(/finite/);
  });
  it("keeps all 100k memberships while explicitly sampling only highlight markers", () => {
    const ids = combineSplatSelection([], Uint32Array.from({ length: 100_000 }, (_, index) => index), "replace", 100_000);
    expect(ids).toHaveLength(100_000); expect(ids.byteLength).toBe(400_000);
    const highlights = splatHighlightIndices(ids); expect(highlights).toHaveLength(20_000); expect(highlights[1]).toBe(5);
    expect(ids[99_999]).toBe(99_999);
  });
  it("reads only requested original indices and combines source/mesh opacity without mutating source", () => {
    const values = [{ center: new Vector3(1, 2, 3), opacity: 1 }, { center: new Vector3(4, 5, 6), opacity: .1 }];
    const source = { numSplats: 2, getSplat: vi.fn((index: number) => values[index]) };
    const mesh = { extSplats: source, opacity: .5, minRaycastOpacity: .1 } as unknown as SplatMesh;
    const result = readOriginalSplatPositions(mesh, [1, 0]);
    expect([...result.slice(0, 3)].every(Number.isNaN)).toBe(true); expect([...result.slice(3)]).toEqual([1, 2, 3]);
    expect(source.getSplat.mock.calls).toEqual([[1], [0]]); expect(values[0].center.toArray()).toEqual([1, 2, 3]);
    expect(() => readOriginalSplatPositions(mesh, [2])).toThrow(/index/);
  });
  it("highlights every selected center, filters hidden positions and keeps overlay unpickable/transient", () => {
    const preview = createSplatComponentPreview(), parent = new Object3D();
    const values = new Float32Array(20_000 * 3); values[0] = NaN;
    preview.update(parent, values);
    expect(preview.points.parent).toBe(parent); expect(preview.points.geometry.drawRange.count).toBe(19_999);
    expect(preview.points.material.depthTest).toBe(false);
    const hits: unknown[] = []; preview.points.raycast({} as never, hits as never); expect(hits).toEqual([]);
    expect(() => preview.update(parent, new Float32Array(60_003))).toThrow(/size/);
    preview.clear(); expect(parent.children).toHaveLength(0); preview.dispose();
  });
});
