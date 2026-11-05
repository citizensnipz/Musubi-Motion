import { Vector4 } from "three";
import { NURBSCurve } from "three/addons/curves/NURBSCurve.js";
import { normalizedChannels, uniqueName, type CurveControlPoint, type CurveShapeNode, type SceneDocument, type TransformChannels, type TransformNode, type Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export type ControllerPreset = "circle" | "square" | "arrow";
export type ControllerPlane = "XY" | "XZ" | "YZ";
export type ControllerOptions = Partial<TransformChannels> & { name?: string; plane?: ControllerPlane; size?: number; color?: string };
export type ControllerShapePatch = Partial<Pick<CurveShapeNode, "degree" | "points" | "knots" | "closed" | "color">>;
export type { CurveControlPoint } from "./scene-document.ts";

export function validateCurveShape(value: unknown): asserts value is CurveShapeNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid controller curve.");
  const shape = value as CurveShapeNode;
  if (shape.type !== "curveShape" || ![1, 2, 3].includes(shape.degree)) throw Error("Controller curve degree must be 1, 2, or 3.");
  if (!Array.isArray(shape.points) || shape.points.length < shape.degree + 1 || shape.points.length > 128) throw Error("A controller curve needs degree + 1 through 128 control points.");
  for (const point of shape.points) {
    if (!Array.isArray(point) || point.length !== 4 || !point.every(n => typeof n === "number" && Number.isFinite(n))
      || point.slice(0, 3).some(n => Math.abs(n) > 1e6) || point[3] < 1e-6 || point[3] > 1e6) {
      throw Error("Controller control points require finite XYZ within ±1,000,000 and weights from 0.000001 to 1,000,000.");
    }
  }
  if (!Array.isArray(shape.knots) || shape.knots.length !== shape.points.length + shape.degree + 1
    || !shape.knots.every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e6)) throw Error("Invalid controller knot count or values.");
  let repeat = 1;
  for (let index = 1; index < shape.knots.length; index++) {
    const gap = shape.knots[index] - shape.knots[index - 1];
    if (gap < 0 || (gap > 0 && gap < 1e-9)) throw Error("Controller knots must be ordered, with distinct knots at least 0.000000001 apart.");
    repeat = gap === 0 ? repeat + 1 : 1;
    if (repeat > shape.degree + 1) throw Error("A controller knot cannot repeat more than degree + 1 times.");
    if (repeat > shape.degree && shape.knots[index] > shape.knots[shape.degree] && shape.knots[index] < shape.knots[shape.points.length]) {
      throw Error("Interior controller knots cannot repeat more than the degree because that disconnects the curve. Rebuild its knots to keep a continuous controller.");
    }
  }
  if (!(shape.knots[shape.degree] < shape.knots[shape.points.length])) throw Error("Controller knots need a nonempty active interval.");
  if (typeof shape.closed !== "boolean" || typeof shape.color !== "string" || !/^#[0-9a-f]{6}$/i.test(shape.color)) throw Error("Controller closure and #rrggbb color are required.");
}

export function clampedUniformKnots(count: number, degree: 1 | 2 | 3): number[] {
  if (![1, 2, 3].includes(degree) || !Number.isInteger(count) || count < degree + 1 || count > 128) throw Error("Choose degree 1–3 and degree + 1 through 128 control points.");
  return Array.from({ length: count + degree + 1 }, (_, index) => index <= degree ? 0 : index >= count ? 1 : (index - degree) / (count - degree));
}

export function findControllerShape(doc: SceneDocument, id: string): CurveShapeNode | undefined {
  const node = doc.nodes[id];
  return node?.type === "curveShape" ? node : Object.values(doc.nodes).find((shape): shape is CurveShapeNode => shape.type === "curveShape" && shape.parentId === id);
}

/** Samples the active NURBS interval, including knots so degree-one corners stay sharp. */
export function sampleControllerCurve(shape: CurveShapeNode, segments = 128): Vec3[] {
  validateCurveShape(shape);
  if (!Number.isInteger(segments) || segments < 2 || segments > 4096) throw Error("Curve sample count must be between 2 and 4096.");
  const curve = new NURBSCurve(shape.degree, shape.knots, shape.points.map(point => new Vector4(...point)), shape.degree, shape.points.length);
  const start = shape.knots[shape.degree], end = shape.knots[shape.points.length];
  const parameters = new Set(Array.from({ length: segments + 1 }, (_, index) => index / segments));
  for (const knot of shape.knots) if (knot > start && knot < end) parameters.add((knot - start) / (end - start));
  const points = [...parameters].sort((a, b) => a - b).map(time => curve.getPoint(time).toArray() as Vec3);
  if (points.some(point => !point.every(Number.isFinite))) throw Error("Controller knots and weights produced an invalid curve; rebuild its knots.");
  if (shape.closed && points[0].some((value, axis) => value !== points.at(-1)![axis])) points.push([...points[0]]);
  return points;
}

export function createController(store: SceneStore, preset: ControllerPreset, options: ControllerOptions = {}): string {
  if (!["circle", "square", "arrow"].includes(preset)) throw Error("Unknown controller preset.");
  const size = options.size ?? 1, plane = options.plane ?? "XZ";
  if (!Number.isFinite(size) || size <= 0 || size > 1e6) throw Error("Controller size must be positive and at most 1,000,000.");
  if (!["XY", "XZ", "YZ"].includes(plane)) throw Error("Unknown controller plane.");
  const doc = store.getState().document, id = crypto.randomUUID(), shapeId = crypto.randomUUID();
  const name = uniqueName(doc, options.name ?? `${preset}Control`);
  const channels = normalizedChannels({ position: options.position ?? [0, 0, 0], rotation: options.rotation ?? [0, 0, 0], scale: options.scale ?? [1, 1, 1] });
  const node: TransformNode = { id, type: "transform", name, parentId: null, rotationOrder: "XYZ", ...channels };
  const w = Math.SQRT1_2;
  const planar: [number, number, number][] = preset === "circle"
    ? [[1, 0, 1], [1, 1, w], [0, 1, 1], [-1, 1, w], [-1, 0, 1], [-1, -1, w], [0, -1, 1], [1, -1, w], [1, 0, 1]]
    : preset === "square" ? [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]
      : [[-0.3, -1, 1], [0.3, -1, 1], [0.3, 0.2, 1], [0.8, 0.2, 1], [0, 1, 1], [-0.8, 0.2, 1], [-0.3, 0.2, 1]];
  const points: CurveControlPoint[] = planar.map(([a, b, weight]) => plane === "XY" ? [a * size, b * size, 0, weight] : plane === "XZ" ? [a * size, 0, b * size, weight] : [0, a * size, b * size, weight]);
  const shape: CurveShapeNode = { id: shapeId, type: "curveShape", name: `${name}Shape`, parentId: id,
    degree: preset === "circle" ? 2 : 1, points, knots: preset === "circle" ? [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1] : clampedUniformKnots(points.length, 1),
    closed: true, color: options.color ?? "#e4b84b" };
  validateCurveShape(shape);
  store.setState({ document: { ...doc, rootIds: [...doc.rootIds, id], nodes: { ...doc.nodes, [id]: node, [shapeId]: shape } }, editLabel: "Create curve controller" });
  return id;
}

export function updateControllerShape(store: SceneStore, shapeId: string, patch: ControllerShapePatch): void {
  const doc = store.getState().document, shape = doc.nodes[shapeId];
  if (shape?.type !== "curveShape") throw Error("Controller curve does not exist.");
  const next = patchedControllerShape(shape, patch);
  if (JSON.stringify(next) === JSON.stringify(shape)) return;
  store.setState({ document: { ...doc, nodes: { ...doc.nodes, [shapeId]: next } }, editLabel: "Edit controller curve" });
}

/** Validate a display-only draft without changing the authored document or undo history. */
export function patchedControllerShape(shape: CurveShapeNode, patch: ControllerShapePatch): CurveShapeNode {
  const next: CurveShapeNode = { ...shape,
    ...(patch.degree !== undefined ? { degree: patch.degree } : {}), ...(patch.closed !== undefined ? { closed: patch.closed } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}), ...(patch.points !== undefined ? { points: patch.points.map(point => [...point] as CurveControlPoint) } : {}),
    ...(patch.knots !== undefined ? { knots: [...patch.knots] } : {}) };
  validateCurveShape(next); sampleControllerCurve(next, 32);
  return next;
}

/** Rebuild changes the shape: CVs and weights remain, while custom knots are replaced. */
export function rebuildControllerCurve(store: SceneStore, shapeId: string, degree: 1 | 2 | 3, points?: CurveControlPoint[]): void {
  const shape = store.getState().document.nodes[shapeId];
  if (shape?.type !== "curveShape") throw Error("Controller curve does not exist.");
  const nextPoints = points ?? shape.points;
  updateControllerShape(store, shapeId, { degree, points: nextPoints, knots: clampedUniformKnots(nextPoints.length, degree) });
}
