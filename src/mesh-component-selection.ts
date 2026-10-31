import { Frustum, Line3, Matrix4, Plane, Raycaster, Vector2, Vector3, Vector4, WebGPUCoordinateSystem, type Camera, type Mesh } from "three";
import { meshEdges } from "./mesh-modeling.ts";
import type { MeshShapeNode } from "./scene-document.ts";

export type MeshComponentMode = "vertex" | "edge" | "face";
export type MeshComponentPickOptions = {
  shape: MeshShapeNode;
  mesh: Mesh;
  triangleFaceIds: readonly string[];
  camera: Camera;
  width: number;
  height: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
  mode: MeshComponentMode;
};

const MAX_SELECTION = 20_000;
const CLICK_RADIUS_SQUARED = 8 ** 2;

/** Stable authored component IDs. Marquees are X-ray; face clicks hit actual triangles. */
export function pickMeshComponents(options: MeshComponentPickOptions): string[] {
  const { shape, mesh, camera, width, height, start, end, mode } = options;
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw Error("Mesh picking needs a finite, positive viewport size.");
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) throw Error("Mesh selection coordinates must be finite canvas pixels.");
  if (!["vertex", "edge", "face"].includes(mode)) throw Error("Choose vertex, edge or face selection.");
  if (!camera?.isCamera || !mesh?.isMesh) throw Error("Mesh picking needs a camera and a mesh.");
  camera.updateWorldMatrix(true, false);
  mesh.updateWorldMatrix(true, false);
  for (const matrix of [mesh.matrixWorld, camera.matrixWorldInverse, camera.projectionMatrix]) {
    if (!matrix.elements.every(Number.isFinite)) throw Error("Mesh picking matrices must contain finite values.");
  }

  const view = new Matrix4().multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
  const minimumDepth = camera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1;
  const clip = new Vector4();
  const cameraPoint = new Vector3();
  const projectCameraPoint = (point: Vector3, target: Vector3, clippedEndpoint = false): boolean => {
    if (![point.x, point.y, point.z].every(Number.isFinite) || point.z > 0) return false;
    clip.set(point.x, point.y, point.z, 1).applyMatrix4(camera.projectionMatrix);
    if (![clip.x, clip.y, clip.z, clip.w].every(Number.isFinite) || clip.w <= 0) return false;
    const x = clip.x / clip.w, y = clip.y / clip.w, z = clip.z / clip.w;
    const tolerance = clippedEndpoint ? 1e-10 : 0;
    if (x < -1 - tolerance || x > 1 + tolerance || y < -1 - tolerance || y > 1 + tolerance || z < minimumDepth - tolerance || z > 1 + tolerance) return false;
    target.set((Math.max(-1, Math.min(1, x)) + 1) * width / 2, (1 - Math.max(-1, Math.min(1, y))) * height / 2, Math.max(minimumDepth, Math.min(1, z)));
    return true;
  };
  const project = (point: Vector3, target: Vector3): boolean => projectCameraPoint(cameraPoint.copy(point).applyMatrix4(view), target);
  const click = Math.hypot(end.x - start.x, end.y - start.y) < 4;

  if (click && mode === "face") {
    const supported = camera as Camera & { isPerspectiveCamera?: boolean; isOrthographicCamera?: boolean };
    if (!supported.isPerspectiveCamera && !supported.isOrthographicCamera) throw Error("Face picking needs a perspective or orthographic camera.");
    if (end.x < 0 || end.x > width || end.y < 0 || end.y > height) return [];
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(end.x / width * 2 - 1, 1 - end.y / height * 2), camera);
    const faceIds = new Set(shape.faces.map(face => face.id));
    const screen = new Vector3();
    for (const hit of raycaster.intersectObject(mesh, false)) {
      // Raycaster does not inherit the camera's clipping planes.
      if (!projectCameraPoint(cameraPoint.copy(hit.point).applyMatrix4(camera.matrixWorldInverse), screen)) continue;
      const id = hit.faceIndex == null ? undefined : options.triangleFaceIds[hit.faceIndex];
      if (id === undefined || !faceIds.has(id)) throw Error("Mesh face picking data is out of date. Refresh the mesh before selecting.");
      return [id];
    }
    return [];
  }

  const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y);
  const selected: string[] = [];
  let nearestId: string | undefined, nearestDistance = Infinity, nearestDepth = Infinity;
  const consider = (id: string, screen: Vector3, distance?: number) => {
    if (click) {
      const squaredDistance = distance ?? (screen.x - end.x) ** 2 + (screen.y - end.y) ** 2;
      if (squaredDistance <= CLICK_RADIUS_SQUARED && (squaredDistance < nearestDistance ||
        (squaredDistance === nearestDistance && (screen.z < nearestDepth ||
          (screen.z === nearestDepth && (nearestId === undefined || id < nearestId)))))) {
        nearestId = id; nearestDistance = squaredDistance; nearestDepth = screen.z;
      }
    } else if (screen.x >= left && screen.x <= right && screen.y >= top && screen.y <= bottom) {
      if (selected.length >= MAX_SELECTION) throw Error("Mesh selection exceeds the 20,000 component limit. Select a smaller region.");
      selected.push(id);
    }
  };
  const point = new Vector3(), screen = new Vector3();
  if (mode === "vertex") {
    for (const vertex of shape.vertices) if (project(point.fromArray(vertex.position), screen)) consider(vertex.id, screen);
  } else {
    const vertices = new Map(shape.vertices.map(vertex => [vertex.id, vertex.position]));
    const position = (id: string, target: Vector3) => {
      const value = vertices.get(id);
      if (!value) throw Error("Mesh component references a missing vertex.");
      return target.fromArray(value);
    };
    if (mode === "face") {
      const corner = new Vector3();
      for (const face of shape.faces) {
        if (!face.vertices.length) continue;
        point.set(0, 0, 0);
        for (const id of face.vertices) point.add(position(id, corner));
        point.divideScalar(face.vertices.length);
        if (project(point, screen)) consider(face.id, screen);
      }
    } else {
      const a = new Vector3(), b = new Vector3();
      const screenA = new Vector3(), screenB = new Vector3();
      const cameraSegment = new Line3(), screenSegment = new Line3();
      const intersection = new Vector3(), cursor = new Vector3(end.x, end.y, 0), closest = new Vector3();
      // Clip in camera space using Three's planes, including behind-camera rejection
      // for orthographic cameras whose near distance may be negative.
      const planes = [...new Frustum().setFromProjectionMatrix(camera.projectionMatrix, camera.coordinateSystem).planes,
        new Plane(new Vector3(0, 0, -1), 0)];
      for (const edge of meshEdges(shape)) {
        position(edge.vertices[0], a); position(edge.vertices[1], b);
        if (!click) {
          point.addVectors(a, b).multiplyScalar(0.5);
          if (project(point, screen)) consider(edge.id, screen);
          continue;
        }
        cameraSegment.set(a.applyMatrix4(view), b.applyMatrix4(view));
        if (![...cameraSegment.start.toArray(), ...cameraSegment.end.toArray()].every(Number.isFinite)) continue;
        let visible = true;
        for (const plane of planes) {
          const da = plane.distanceToPoint(cameraSegment.start), db = plane.distanceToPoint(cameraSegment.end);
          if (da < 0 && db < 0) { visible = false; break; }
          if (da < 0 || db < 0) {
            if (!plane.intersectLine(cameraSegment, intersection)) { visible = false; break; }
            (da < 0 ? cameraSegment.start : cameraSegment.end).copy(intersection);
          }
        }
        if (!visible || !projectCameraPoint(cameraSegment.start, screenA, true) || !projectCameraPoint(cameraSegment.end, screenB, true)) continue;
        const depthA = screenA.z, depthB = screenB.z;
        screenSegment.set(screenA.setZ(0), screenB.setZ(0));
        const collapsed = screenSegment.distanceSq() === 0;
        if (collapsed) closest.copy(screenSegment.start);
        else screenSegment.closestPointToPoint(cursor, true, closest);
        const distance = closest.distanceToSquared(cursor);
        const t = collapsed ? 0 : screenSegment.closestPointToPointParameter(cursor, true);
        closest.z = collapsed ? Math.min(depthA, depthB) : depthA + (depthB - depthA) * t;
        consider(edge.id, closest, distance);
      }
    }
  }
  return click ? nearestId === undefined ? [] : [nearestId] : selected.sort();
}
