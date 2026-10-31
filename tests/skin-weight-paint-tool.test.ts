import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Object3D, OrthographicCamera, type Points } from "three";
import { createSkinWeightPaintTool } from "../src/skin-weight-paint-tool.ts";
import type { SkinWeightBrushSettings } from "../src/skin-weight-paint-panel.ts";

// Minimal native event surfaces; projection, brush evaluation and Three resources stay real.
class ElementSurface extends EventTarget {
  style: Record<string, string> = {};
  hidden = false;
  className = "";
  children: ElementSurface[] = [];
  parent?: ElementSurface;
  onBlur?: () => void;
  blur = vi.fn(() => this.onBlur?.());
  setPointerCapture = vi.fn();
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  append(child: ElementSurface) { child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}

const tools: ReturnType<typeof createSkinWeightPaintTool>[] = [];
let windowSurface: EventTarget;
let documentSurface: { activeElement: ElementSurface | null; createElement: () => ElementSurface };

beforeEach(() => {
  vi.useFakeTimers();
  let time = 0;
  vi.spyOn(performance, "now").mockImplementation(() => time += 10);
  windowSurface = new EventTarget();
  documentSurface = { activeElement: null, createElement: () => new ElementSurface() };
  vi.stubGlobal("window", windowSurface);
  vi.stubGlobal("document", documentSurface);
  vi.stubGlobal("HTMLElement", ElementSurface);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
});

afterEach(async () => {
  for (const tool of tools.splice(0)) tool.dispose();
  await vi.runAllTimersAsync();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});

function pointer(target: EventTarget, type: string, x: number, y = 50) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, altKey: false });
  target.dispatchEvent(event);
  return event;
}

function fixture() {
  const canvas = new ElementSurface(), host = new ElementSurface();
  const mesh = new Object3D(), camera = new OrthographicCamera(0, 100, 100, 0, 1, 10);
  // The second visible center is in the next asynchronous scan chunk.
  const positions = new Float32Array(4097 * 3).fill(NaN);
  positions.set([20, 50, -2], 0); positions.set([80, 50, -2], 4096 * 3);
  const context = { identity: {}, mesh, count: 4097,
    getWeights: () => [{ jointId: "joint", weight: 0.2 }],
    getPositions: vi.fn((indices: number[]) => new Float32Array(indices.flatMap(index => [...positions.slice(index * 3, index * 3 + 3)]))),
  };
  let revision = 0;
  const busyChanges: boolean[] = [];
  const commit = vi.fn(), onMessage = vi.fn();
  const tool = createSkinWeightPaintTool(canvas as unknown as HTMLCanvasElement, host as unknown as HTMLElement, {
    available: () => true, showPreview: () => true, getContext: () => context,
    getCamera: () => camera, getRevision: () => revision,
    commit: (...args) => { expect(tool.busy).toBe(false); commit(...args); },
    onBusyChange: () => busyChanges.push(tool.busy), onMessage,
  });
  tools.push(tool);
  const settings: SkinWeightBrushSettings = { shapeId: "shape", jointId: "joint", radius: 5, strength: 1, value: 1, mode: "replace" };
  tool.setBrush(settings); context.getPositions.mockClear();
  return { canvas, host, mesh, tool, settings, context, commit, onMessage, busyChanges,
    changeRevision() { revision++; } };
}

describe("skin paint browser adapter", () => {
  it("freezes a stroke at release while its index is still pending", async () => {
    const f = fixture();
    pointer(f.canvas, "pointerdown", 20);
    expect(f.tool.busy).toBe(true);
    expect(f.context.getPositions.mock.calls[0][0]).toHaveLength(4096);
    expect(f.commit).not.toHaveBeenCalled();
    pointer(f.canvas, "pointerup", 30);
    f.canvas.dispatchEvent(new Event("lostpointercapture"));
    pointer(f.canvas, "pointermove", 80);
    expect(f.tool.busy).toBe(true); expect(f.commit).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.commit.mock.calls[0][1]).toEqual([{ index: 0, weight: 1 }]);
    expect(f.tool.busy).toBe(false); expect(f.busyChanges).toEqual([true, false]);
    expect(f.canvas.setPointerCapture).toHaveBeenCalledWith(1);
  });

  it("cancels a released but pending stroke with Escape without committing", async () => {
    const f = fixture();
    pointer(f.canvas, "pointerdown", 20); pointer(f.canvas, "pointerup", 80);
    const escape = new Event("keydown", { cancelable: true }); Object.assign(escape, { key: "Escape" });
    windowSurface.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true); expect(f.tool.busy).toBe(false);
    await vi.runAllTimersAsync();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.onMessage).toHaveBeenCalledWith("Paint stroke canceled.");
  });

  it("rejects a pending stroke when the scene revision changes", async () => {
    const f = fixture();
    pointer(f.canvas, "pointerdown", 20); pointer(f.canvas, "pointerup", 80);
    f.changeRevision();
    await vi.runAllTimersAsync();
    expect(f.commit).not.toHaveBeenCalled(); expect(f.tool.busy).toBe(false);
    expect(f.onMessage).toHaveBeenCalledWith("Paint stroke canceled because the scene or view changed.");
  });

  it("commits a focused field draft before taking the brush settings snapshot", async () => {
    const f = fixture(), field = new ElementSurface();
    field.onBlur = () => f.tool.setBrush({ ...f.settings, value: 0.75 });
    documentSurface.activeElement = field;
    pointer(f.canvas, "pointerdown", 20); pointer(f.canvas, "pointerup", 20);
    await vi.runAllTimersAsync();
    expect(field.blur).toHaveBeenCalledTimes(1);
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.commit.mock.calls[0][0].value).toBe(0.75);
    expect(f.commit.mock.calls[0][1]).toEqual([{ index: 0, weight: 0.75 }]);
  });

  it("disposes preview resources and suppresses pending callbacks on teardown", async () => {
    const f = fixture(), points = f.mesh.children[0] as Points;
    const geometryDispose = vi.fn(), materialDispose = vi.fn();
    points.geometry.addEventListener("dispose", geometryDispose);
    const material = Array.isArray(points.material) ? points.material[0] : points.material;
    material.addEventListener("dispose", materialDispose);
    pointer(f.canvas, "pointerdown", 20); pointer(f.canvas, "pointerup", 80);
    f.tool.dispose();
    await vi.runAllTimersAsync();
    expect(f.commit).not.toHaveBeenCalled(); expect(f.tool.busy).toBe(false);
    expect(f.mesh.children).toHaveLength(0); expect(f.host.children).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalledTimes(1); expect(materialDispose).toHaveBeenCalledTimes(1);
  });
});
