import { describe, expect, it } from "vitest";
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, Object3D, OrthographicCamera, PerspectiveCamera, WebGPUCoordinateSystem } from "three";
import { pickMeshComponents, type MeshComponentPickOptions } from "../src/mesh-component-selection.ts";
import type { MeshShapeNode, Vec3 } from "../src/scene-document.ts";

function setup(points: Vec3[], faces: string[][] = [], patch: Partial<MeshComponentPickOptions> = {}): MeshComponentPickOptions {
  const shape: MeshShapeNode = {
    id: "shape", type: "meshShape", name: "Mesh", parentId: "transform", color: "#888888", shading: "flat", wireframe: false,
    vertices: points.map((position, index) => ({ id: `v${index}`, position })),
    faces: faces.map((vertices, index) => ({ id: `f${index}`, vertices })),
  };
  const geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points.flat(), 3));
  const triangles: number[] = [], triangleFaceIds: string[] = [];
  for (const face of shape.faces) for (let index = 1; index + 1 < face.vertices.length; index++) {
    triangles.push(...[face.vertices[0], face.vertices[index], face.vertices[index + 1]].map(id => Number(id.slice(1))));
    triangleFaceIds.push(face.id);
  }
  geometry.setIndex(triangles);
  return {
    shape, mesh: new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide })), triangleFaceIds,
    camera: new OrthographicCamera(-50, 50, 50, -50, 1, 100), width: 100, height: 100,
    start: { x: 50, y: 50 }, end: { x: 50, y: 50 }, mode: "vertex", ...patch,
  };
}
const edgeId = (a: number, b: number) => JSON.stringify([`v${a}`, `v${b}`].sort());
const rectangle = { start: { x: 40, y: 40 }, end: { x: 60, y: 60 } };

describe("mesh component selection", () => {
  it("picks the nearest vertex within eight CSS pixels, with depth and ID tie breaks", () => {
    const options = setup([[0, 0, -8], [0, 0, -2], [0, 0, -2], [1, 0, -1]]);
    expect(pickMeshComponents(options)).toEqual(["v1"]);
    options.shape.vertices.reverse();
    expect(pickMeshComponents(options)).toEqual(["v1"]);
    expect(pickMeshComponents(setup([[8, 0, -2], [9, 0, -2]]))).toEqual(["v0"]);
    expect(pickMeshComponents(setup([[8.01, 0, -2]]))).toEqual([]);
  });

  it("selects noncontiguous vertex IDs through geometry with reversed inclusive rectangles", () => {
    const options = setup([[-10, 10, -2], [30, 0, -2], [10, -10, -90], [0, 0, -4]], [], {
      start: rectangle.end, end: rectangle.start,
    });
    expect(pickMeshComponents(options)).toEqual(["v0", "v2", "v3"]);
  });

  it("applies mesh and camera parents without requiring prior matrix updates", () => {
    const options = setup([[0, 0, 0], [30, 0, 0]]);
    const parent = new Object3D(); parent.position.set(2, 3, 0); parent.rotation.z = Math.PI / 2;
    options.mesh.position.set(1, 0, -4); parent.add(options.mesh);
    const cameraParent = new Object3D(); cameraParent.position.set(2, 4, 0); cameraParent.add(options.camera);
    expect(pickMeshComponents(options)).toEqual(["v0"]);
  });

  it("excludes nonfinite, offscreen, near/far clipped and behind-camera centers", () => {
    const camera = new PerspectiveCamera(90, 1, 1, 10);
    const points: Vec3[] = [[0, 0, -2], [0, 0, -0.5], [0, 0, -11], [10, 0, -2], [0, 0, 2], [NaN, 0, -2], [0, Infinity, -2]];
    const largeRectangle = { start: { x: -1000, y: -1000 }, end: { x: 1000, y: 1000 } };
    expect(pickMeshComponents(setup(points, [], { camera, ...largeRectangle }))).toEqual(["v0"]);
    camera.coordinateSystem = WebGPUCoordinateSystem; camera.updateProjectionMatrix();
    expect(pickMeshComponents(setup(points, [], { camera, ...largeRectangle }))).toEqual(["v0"]);
    expect(pickMeshComponents(setup([[0, 0, 2], [0, 0, -2]], [], {
      camera: new OrthographicCamera(-50, 50, 50, -50, -5, 10), ...largeRectangle,
    }))).toEqual(["v1"]);
  });

  it("picks the visible edge segment rather than its center or endpoints", () => {
    const options = setup([[-40, 0, -2], [40, 0, -2], [40, -40, -2]], [["v0", "v1", "v2"]], {
      mode: "edge", start: { x: 20, y: 44 }, end: { x: 20, y: 44 },
    });
    expect(pickMeshComponents(options)).toEqual([edgeId(0, 1)]);
    options.start = options.end = { x: 20, y: 41 };
    expect(pickMeshComponents(options)).toEqual([]);
  });

  it("clips crossing edges to the frustum and rejects segments wholly behind the camera", () => {
    const options = setup([[-100, 0, -2], [100, 0, -2], [100, -100, -2]], [["v0", "v1", "v2"]], { mode: "edge" });
    expect(pickMeshComponents(options)).toEqual([edgeId(0, 1)]);
    const behind = setup([[-10, 0, 2], [10, 0, 2], [10, -10, 2]], [["v0", "v1", "v2"]], {
      mode: "edge", camera: new OrthographicCamera(-50, 50, 50, -50, -5, 10),
    });
    expect(pickMeshComponents(behind)).toEqual([]);
    const nearCrossing = setup([[0, 0, 1], [0, 0, -4], [4, -4, -4]], [["v0", "v1", "v2"]], {
      mode: "edge", camera: new PerspectiveCamera(90, 1, 1, 10),
    });
    expect(pickMeshComponents(nearCrossing)).toEqual([edgeId(0, 1)]);
  });

  it("uses depth to resolve overlapping edge clicks", () => {
    const options = setup([[-20, 0, -8], [20, 0, -8], [20, -40, -8], [-20, 0, -2], [20, 0, -2], [20, -40, -2]],
      [["v0", "v1", "v2"], ["v3", "v4", "v5"]], { mode: "edge" });
    expect(pickMeshComponents(options)).toEqual([edgeId(3, 4)]);
  });

  it("marquees edge midpoints and face averages, including occluded faces", () => {
    const options = setup([[-20, 0, -2], [20, 0, -2], [20, -40, -2], [-20, 0, -8], [20, 0, -8], [0, 10, -8]],
      [["v0", "v1", "v2"], ["v3", "v4", "v5"]], { mode: "edge", ...rectangle });
    expect(pickMeshComponents(options)).toEqual([edgeId(0, 1), edgeId(3, 4), edgeId(3, 5), edgeId(4, 5)].sort());
    expect(pickMeshComponents({ ...options, mode: "face" })).toEqual(["f1"]);
  });

  it("raycasts actual triangles to the closest authored face and supports backfaces", () => {
    const options = setup([[-20, -20, -8], [20, -20, -8], [20, 20, -8], [-20, 20, -8], [-20, -20, -2], [20, -20, -2], [0, 20, -2]],
      [["v0", "v1", "v2", "v3"], ["v6", "v5", "v4"]], { mode: "face" });
    expect(pickMeshComponents(options)).toEqual(["f1"]);
    options.start = options.end = { x: 35, y: 35 };
    expect(pickMeshComponents(options)).toEqual(["f0"]);
    options.start = options.end = { x: 90, y: 10 };
    expect(pickMeshComponents(options)).toEqual([]);
  });

  it("raycasts transformed meshes, filters camera clipping and detects stale face mapping", () => {
    const options = setup([[-10, -10, 0], [10, -10, 0], [0, 10, 0]], [["v0", "v1", "v2"]], { mode: "face" });
    const parent = new Object3D(); parent.position.set(10, 5, -2); parent.rotation.z = Math.PI / 2; parent.add(options.mesh);
    options.start = options.end = { x: 60, y: 45 };
    expect(pickMeshComponents(options)).toEqual(["f0"]);
    expect(() => pickMeshComponents({ ...options, triangleFaceIds: [] })).toThrow(/out of date/);
    parent.position.z = -0.5;
    expect(pickMeshComponents(options)).toEqual([]);
    parent.position.z = -101;
    expect(pickMeshComponents(options)).toEqual([]);
  });

  it("uses the release location for short clicks and treats four pixels as a rectangle", () => {
    const options = setup([[0, 0, -2], [3, 0, -2]], [], { end: { x: 53, y: 50 } });
    expect(pickMeshComponents(options)).toEqual(["v1"]);
    expect(pickMeshComponents({ ...options, end: { x: 54, y: 50 } })).toEqual(["v0", "v1"]);
  });

  it("rejects overflow atomically without mutating the document or input selection", () => {
    const options = setup(Array.from({ length: 20_001 }, () => [0, 0, -2] as Vec3), [], rectangle);
    const before = JSON.stringify(options.shape);
    expect(() => pickMeshComponents(options)).toThrow(/20,000 component limit/);
    expect(JSON.stringify(options.shape)).toBe(before);
    expect(pickMeshComponents({ ...options, start: { x: 50, y: 50 }, end: { x: 50, y: 50 } })).toEqual(["v0"]);
  });

  it("rejects invalid viewport, coordinates and matrices", () => {
    const options = setup([[0, 0, -2]]);
    for (const patch of [{ width: 0 }, { height: Infinity }, { end: { x: NaN, y: 50 } }]) expect(() => pickMeshComponents({ ...options, ...patch })).toThrow();
    options.camera.projectionMatrix.elements[0] = NaN;
    expect(() => pickMeshComponents(options)).toThrow(/finite values/);
  });
});
