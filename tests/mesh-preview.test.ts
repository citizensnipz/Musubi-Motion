import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferAttribute, DynamicDrawUsage, Group, LineSegments, Vector3 } from "three";
import * as modeling from "../src/mesh-modeling.ts";
import { createMeshRenderable } from "../src/mesh-renderer.ts";
import type { MeshShapeNode, Vec3 } from "../src/scene-document.ts";

const renderers: ReturnType<typeof createMeshRenderable>[] = [];
afterEach(() => { renderers.splice(0).forEach(renderer => renderer.dispose()); vi.restoreAllMocks(); });
function fixture() {
  const shape: MeshShapeNode = {
    id: "shape", type: "meshShape", name: "Quad", parentId: "transform", color: "#8899aa", shading: "smooth", wireframe: true,
    vertices: [{ id: "a", position: [-1, -1, 0] }, { id: "b", position: [1, -1, 0] }, { id: "c", position: [1, 1, 0] }, { id: "d", position: [-1, 1, 0] }],
    faces: [{ id: "face", vertices: ["a", "b", "c", "d"] }],
  };
  const renderer = createMeshRenderable(shape); renderers.push(renderer);
  const geometry = renderer.mesh.geometry, wires = renderer.mesh.children[0] as LineSegments;
  const position = geometry.getAttribute("position") as BufferAttribute, normal = geometry.getAttribute("normal") as BufferAttribute;
  const wirePosition = wires.geometry.getAttribute("position") as BufferAttribute;
  return { shape, renderer, geometry, wires, position, normal, wirePosition };
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze); Object.freeze(value);
}
function xyz(attribute: BufferAttribute, index: number) { return [attribute.getX(index), attribute.getY(index), attribute.getZ(index)]; }

describe("mesh component gesture previews", () => {
  it("derives every preview from the committed shape without mutating document or caller arrays", () => {
    const { shape, renderer, position } = fixture(); freeze(shape);
    const changes = [{ id: "a", position: [-3, -2, .75] as Vec3 }], before = JSON.stringify(shape);
    freeze(changes);
    const first = renderer.previewVertices(changes);
    expect(first).not.toBe(shape); expect(first.vertices).not.toBe(shape.vertices); expect(first.faces).toBe(shape.faces);
    expect(first.vertices[0].position).toEqual([-3, -2, .75]); expect(first.vertices[0].position).not.toBe(changes[0].position);
    const second = renderer.previewVertices([{ id: "c", position: [4, 3, 2] }]);
    expect(xyz(position, 0)).toEqual(shape.vertices[0].position);
    expect(second.vertices[0]).toBe(shape.vertices[0]); expect(second.vertices[2].position).toEqual([4, 3, 2]);
    expect(first.vertices[0].position).toEqual([-3, -2, .75]); expect(JSON.stringify(shape)).toBe(before);
    expect(changes[0].position).toEqual([-3, -2, .75]);
  });

  it("reuses geometry, attributes, arrays and committed face triangulation throughout a gesture", () => {
    const { renderer, geometry, wires, position, normal, wirePosition } = fixture();
    const centers = renderer.centers, wireGeometry = wires.geometry, mapping = renderer.triangleFaceIds, indices = geometry.getIndex(), positionArray = position.array, normalArray = normal.array, wireArray = wirePosition.array;
    const triangulate = vi.spyOn(modeling, "triangulateMesh"), validate = vi.spyOn(modeling, "validateMeshShape");
    const disposed = [vi.spyOn(geometry, "dispose"), vi.spyOn(wireGeometry, "dispose")];
    const versions = [position.version, normal.version, wirePosition.version];
    for (let i = 0; i < 5; i++) renderer.previewVertices([{ id: "c", position: [2 + i, 2, i / 4] }]);
    expect(renderer.mesh.geometry).toBe(geometry); expect(wires.geometry).toBe(wireGeometry); expect(renderer.centers).toBe(centers);
    expect(renderer.triangleFaceIds).toBe(mapping); expect(geometry.getIndex()).toBe(indices);
    expect(geometry.getAttribute("position")).toBe(position); expect(geometry.getAttribute("normal")).toBe(normal); expect(wires.geometry.getAttribute("position")).toBe(wirePosition);
    expect(position.array).toBe(positionArray); expect(normal.array).toBe(normalArray); expect(wirePosition.array).toBe(wireArray);
    [position, normal, wirePosition].forEach((attribute, index) => { expect(attribute.usage).toBe(DynamicDrawUsage); expect(attribute.version).toBeGreaterThan(versions[index]); });
    expect(triangulate).not.toHaveBeenCalled(); expect(validate).not.toHaveBeenCalled(); disposed.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it("updates smooth normals, wire endpoints and surface/wire bounds in local space", () => {
    const { shape, renderer, geometry, wires, normal, wirePosition } = fixture();
    const oldNormals = Array.from(normal.array), oldRadius = geometry.boundingSphere!.radius;
    renderer.mesh.position.set(100, 200, 300); renderer.mesh.scale.set(3, 4, 5);
    const preview = renderer.previewVertices([{ id: "c", position: [5, 3, 4] }]);
    expect(renderer.bounds.max.toArray()).toEqual([5, 3, 4]); expect(renderer.bounds.min.toArray()).toEqual([-1, -1, 0]);
    expect(geometry.boundingBox!.equals(renderer.bounds)).toBe(true); expect(geometry.boundingSphere!.radius).toBeGreaterThan(oldRadius);
    expect(wires.geometry.boundingBox!.equals(renderer.bounds)).toBe(true); expect(wires.geometry.boundingSphere!.radius).toBeGreaterThan(oldRadius);
    expect(Array.from(normal.array)).not.toEqual(oldNormals);
    for (let i = 0; i < normal.count; i++) expect(new Vector3().fromBufferAttribute(normal, i).length()).toBeCloseTo(1, 6);
    const byId = new Map(preview.vertices.map(vertex => [vertex.id, vertex.position]));
    const expectedLines = modeling.meshEdges(shape).flatMap(edge => edge.vertices.flatMap(id => byId.get(id)!));
    expect(Array.from(wirePosition.array)).toEqual(expectedLines);
    expect(renderer.mesh.position.toArray()).toEqual([100, 200, 300]); expect(renderer.mesh.scale.toArray()).toEqual([3, 4, 5]);
  });

  it("rejects a whole invalid batch atomically while preserving an existing valid preview", () => {
    const { renderer, geometry, wires, position, normal, wirePosition } = fixture();
    renderer.previewVertices([{ id: "a", position: [-3, -4, 2] }]);
    const baseline = { positions: Array.from(position.array), normals: Array.from(normal.array), wires: Array.from(wirePosition.array), bounds: renderer.bounds.clone(), sphere: geometry.boundingSphere!.clone(), wireBounds: wires.geometry.boundingBox!.clone(), versions: [position.version, normal.version, wirePosition.version] };
    const invalid = [
      [{ id: "b", position: [2, 0, 0] }, { id: "absent", position: [0, 0, 0] }],
      [{ id: "b", position: [2, 0, 0] }, { id: "b", position: [0, 0, 0] }],
      [{ id: "b", position: [NaN, 0, 0] }], [{ id: "b", position: [Infinity, 0, 0] }],
      [{ id: "b", position: [0, -1_000_001, 0] }], [{ id: "b", position: [0, 0] }],
      [{ id: "b", position: ["2", 0, 0] }], [{ id: "b", position: new Array(3) }], [null], null,
    ];
    for (const changes of invalid) {
      expect(() => renderer.previewVertices(changes as any)).toThrow(/preview/);
      expect(Array.from(position.array)).toEqual(baseline.positions); expect(Array.from(normal.array)).toEqual(baseline.normals); expect(Array.from(wirePosition.array)).toEqual(baseline.wires);
      expect(renderer.bounds.equals(baseline.bounds)).toBe(true); expect(geometry.boundingSphere!.equals(baseline.sphere)).toBe(true); expect(wires.geometry.boundingBox!.equals(baseline.wireBounds)).toBe(true);
      expect([position.version, normal.version, wirePosition.version]).toEqual(baseline.versions);
    }
  });

  it("allows temporary collapsed or crossing faces without retessellating the committed topology", () => {
    const { shape, renderer, geometry, normal } = fixture();
    const indices = Array.from(geometry.getIndex()!.array);
    const preview = renderer.previewVertices(shape.vertices.map(vertex => ({ id: vertex.id, position: [0, 0, 0] as Vec3 })));
    expect(() => modeling.validateMeshShape(preview)).toThrow(/nonzero area/);
    expect(Array.from(geometry.getIndex()!.array)).toEqual(indices);
    expect(Array.from(normal.array).every(Number.isFinite)).toBe(true); expect(geometry.boundingSphere!.radius).toBe(0);
    renderer.clearPreview(); expect(Array.from(normal.array)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it("restores exact committed positions, normals and bounds on clear and empty preview", () => {
    const { shape, renderer, geometry, wires, position, normal, wirePosition } = fixture();
    const before = { positions: position.array.slice(), normals: normal.array.slice(), wires: wirePosition.array.slice(), bounds: renderer.bounds.clone(), box: geometry.boundingBox!.clone(), sphere: geometry.boundingSphere!.clone(), wireBox: wires.geometry.boundingBox!.clone(), wireSphere: wires.geometry.boundingSphere!.clone() };
    const boundsIdentity = renderer.bounds, boxIdentity = geometry.boundingBox, sphereIdentity = geometry.boundingSphere;
    for (const clear of [() => renderer.clearPreview(), () => renderer.previewVertices([])]) {
      renderer.previewVertices([{ id: "a", position: [-999999.875, -1e6, 1e6] }]); clear();
      expect(position.array).toEqual(before.positions); expect(normal.array).toEqual(before.normals); expect(wirePosition.array).toEqual(before.wires);
      expect(renderer.bounds).toBe(boundsIdentity); expect(geometry.boundingBox).toBe(boxIdentity); expect(geometry.boundingSphere).toBe(sphereIdentity);
      expect(renderer.bounds.equals(before.bounds)).toBe(true); expect(geometry.boundingBox!.equals(before.box)).toBe(true); expect(geometry.boundingSphere!.equals(before.sphere)).toBe(true);
      expect(wires.geometry.boundingBox!.equals(before.wireBox)).toBe(true); expect(wires.geometry.boundingSphere!.equals(before.wireSphere)).toBe(true);
    }
    const version = position.version; renderer.clearPreview(); expect(position.version).toBe(version); expect(shape.vertices[0].position).toEqual([-1, -1, 0]);
  });

  it("clears previews on same-object and appearance updates but leaves invalid updates atomic", () => {
    const { shape, renderer, geometry, position } = fixture();
    renderer.previewVertices([{ id: "a", position: [-5, -2, 1] }]);
    const pending = position.array.slice();
    expect(() => renderer.update({ ...shape, color: "broken" })).toThrow(/color/); expect(position.array).toEqual(pending);
    renderer.update(shape); expect(xyz(position, 0)).toEqual(shape.vertices[0].position); expect(renderer.mesh.geometry).toBe(geometry);
    renderer.previewVertices([{ id: "a", position: [-5, -2, 1] }]);
    renderer.update({ ...shape, name: "Renamed", color: "#ff0000" });
    expect(xyz(position, 0)).toEqual(shape.vertices[0].position); expect(renderer.mesh.name).toBe("Renamed"); expect(renderer.mesh.material.color.getHexString()).toBe("ff0000");
    const next = renderer.previewVertices([{ id: "b", position: [3, -1, 0] }]); expect(next.name).toBe("Renamed"); expect(next.color).toBe("#ff0000");
  });

  it("rebuilds mappings on a topology update and treats the new mesh as the preview baseline", () => {
    const { shape, renderer, geometry, wires } = fixture();
    const oldEdges = wires.geometry, oldGeometryDispose = vi.spyOn(geometry, "dispose"), oldEdgesDispose = vi.spyOn(oldEdges, "dispose");
    renderer.previewVertices([{ id: "a", position: [-10, -1, 0] }]);
    const next: MeshShapeNode = { ...shape, vertices: [shape.vertices[2], shape.vertices[0], shape.vertices[1]], faces: [{ id: "triangle", vertices: ["a", "b", "c"] }] };
    renderer.update(next);
    expect(oldGeometryDispose).toHaveBeenCalledTimes(1); expect(oldEdgesDispose).toHaveBeenCalledTimes(1); expect(renderer.triangleFaceIds).toEqual(["triangle"]);
    const newGeometry = renderer.mesh.geometry;
    renderer.previewVertices([{ id: "a", position: [-3, -2, 1] }]);
    expect(xyz(newGeometry.getAttribute("position") as BufferAttribute, 1)).toEqual([-3, -2, 1]);
    expect(() => renderer.previewVertices([{ id: "d", position: [0, 0, 0] }])).toThrow(/unknown/);
    renderer.clearPreview(); expect(xyz(newGeometry.getAttribute("position") as BufferAttribute, 1)).toEqual([-1, -1, 0]);
    expect(renderer.bounds.max.toArray()).toEqual([1, 1, 0]);
  });

  it("disposes active previews once, detaches the mesh and cannot revive disposed resources", () => {
    const { shape, renderer, geometry, wires, position } = fixture(), parent = new Group(); parent.add(renderer.mesh);
    const resources = [geometry, wires.geometry, renderer.mesh.material, wires.material as any], dispose = resources.map(resource => vi.spyOn(resource, "dispose"));
    renderer.previewVertices([{ id: "a", position: [-2, -1, 0] }]);
    renderer.dispose(); const version = position.version; renderer.clearPreview(); renderer.dispose();
    expect(position.version).toBe(version); expect(renderer.mesh.parent).toBeNull(); dispose.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    expect(() => renderer.previewVertices([])).toThrow(/disposed/); expect(() => renderer.update(shape)).toThrow(/disposed/);
  });
});
