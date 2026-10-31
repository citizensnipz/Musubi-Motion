import { BoxGeometry, CylinderGeometry, PlaneGeometry, ShapeUtils, SphereGeometry, Vector2, Vector3, type BufferGeometry } from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { normalizedChannels, uniqueName, type MeshFace, type MeshShapeNode, type MeshVertex, type SceneDocument, type TransformChannels, type TransformNode, type Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
export type { MeshFace, MeshShapeNode, MeshVertex } from "./scene-document.ts";
export type MeshPrimitive = "cube" | "plane" | "sphere" | "cylinder";
export type MeshPrimitiveOptions = Partial<TransformChannels> & { name?: string; size?: number; color?: string };
export type MeshEdge = { id: string; vertices: [string, string]; faceIds: string[] };
export type MeshTriangulation = { positions: Float32Array; indices: number[]; triangleFaceIds: string[]; vertexIds: string[] };
const MAX_COMPONENTS = 100_000;
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id);
const validPosition = (position: unknown): position is Vec3 => Array.isArray(position) && position.length === 3 && position.every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6);
const edgeKey = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);

export function findMeshShape(doc: SceneDocument, id: string): MeshShapeNode | undefined {
  const node = doc.nodes[id];
  return node?.type === "meshShape" ? node : Object.values(doc.nodes).find((shape): shape is MeshShapeNode => shape.type === "meshShape" && shape.parentId === id);
}
export function meshEdges(shape: MeshShapeNode): MeshEdge[] {
  const result = new Map<string, MeshEdge>();
  for (const face of shape.faces) for (let index = 0; index < face.vertices.length; index++) {
    const a = face.vertices[index], b = face.vertices[(index + 1) % face.vertices.length], id = edgeKey(a, b);
    let edge = result.get(id);
    if (!edge) { edge = { id, vertices: a < b ? [a, b] : [b, a], faceIds: [] }; result.set(id, edge); }
    edge.faceIds.push(face.id);
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// Newell's area-weighted polygon normal, expressed relative to one vertex to
// avoid cancellation when a small polygon is far from the local origin.
function polygonNormal(points: Vector3[]): Vector3 {
  const normal = new Vector3();
  for (let index = 1; index + 1 < points.length; index++) normal.add(new Vector3().crossVectors(points[index].clone().sub(points[0]), points[index + 1].clone().sub(points[0])));
  return normal;
}
/* Segment intersection validation adapts the bundled Earcut 3.0.1 predicate.
 * ISC License — Copyright (c) 2024, Mapbox
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
function intersects(a: Vector2, b: Vector2, c: Vector2, d: Vector2): boolean {
  const orientation = (p: Vector2, q: Vector2, r: Vector2) => Math.sign(q.clone().sub(p).cross(r.clone().sub(p)));
  const onSegment = (p: Vector2, q: Vector2, r: Vector2) => q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
  const abC = orientation(a, b, c), abD = orientation(a, b, d), cdA = orientation(c, d, a), cdB = orientation(c, d, b);
  return (abC !== abD && cdA !== cdB) || (abC === 0 && onSegment(a, c, b)) || (abD === 0 && onSegment(a, d, b)) || (cdA === 0 && onSegment(c, a, d)) || (cdB === 0 && onSegment(c, b, d));
}
function faceTriangles(face: MeshFace, vertices: ReadonlyMap<string, MeshVertex>): number[][] {
  const points = face.vertices.map(id => new Vector3(...vertices.get(id)!.position)), normal = polygonNormal(points);
  const extentSquared = Math.max(...points.map(point => point.distanceToSquared(points[0]))), areaTolerance = Math.max(1e-24, extentSquared * 1e-12);
  if (normal.length() <= areaTolerance) throw Error("Mesh faces must have nonzero area.");
  const axis = Math.abs(normal.x) > Math.abs(normal.y) ? Math.abs(normal.x) > Math.abs(normal.z) ? 0 : 2 : Math.abs(normal.y) > Math.abs(normal.z) ? 1 : 2;
  const projected = points.map(point => axis === 0 ? new Vector2(point.y - points[0].y, point.z - points[0].z) : axis === 1 ? new Vector2(point.x - points[0].x, point.z - points[0].z) : new Vector2(point.x - points[0].x, point.y - points[0].y));
  for (let a = 0; a < projected.length; a++) for (let b = a + 1; b < projected.length; b++) {
    if (b === a + 1 || (a === 0 && b === projected.length - 1)) continue;
    if (intersects(projected[a], projected[(a + 1) % projected.length], projected[b], projected[(b + 1) % projected.length])) throw Error("Mesh face folds or self-intersects in its dominant-plane projection.");
  }
  const triangles = ShapeUtils.triangulateShape(projected, []);
  if (triangles.length !== points.length - 2) throw Error("Mesh face cannot be triangulated without degenerate corners.");
  for (const triangle of triangles) {
    const cross = new Vector3().crossVectors(points[triangle[1]].clone().sub(points[triangle[0]]), points[triangle[2]].clone().sub(points[triangle[0]]));
    if (cross.length() <= areaTolerance || Math.abs(cross.dot(normal)) <= areaTolerance * normal.length()) throw Error("Mesh face contains a degenerate or folded triangle.");
    if (cross.dot(normal) < 0) [triangle[1], triangle[2]] = [triangle[2], triangle[1]];
  }
  return triangles;
}

export function triangulateMesh(shape: MeshShapeNode): MeshTriangulation {
  const vertices = new Map(shape.vertices.map(vertex => [vertex.id, vertex])), indicesById = new Map(shape.vertices.map((vertex, index) => [vertex.id, index]));
  const indices: number[] = [], triangleFaceIds: string[] = [];
  for (const face of shape.faces) for (const triangle of faceTriangles(face, vertices)) {
    indices.push(...triangle.map(index => indicesById.get(face.vertices[index])!)); triangleFaceIds.push(face.id);
  }
  return { positions: new Float32Array(shape.vertices.flatMap(vertex => vertex.position)), indices, triangleFaceIds, vertexIds: shape.vertices.map(vertex => vertex.id) };
}

export function validateMeshShape(value: unknown): asserts value is MeshShapeNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid polygon mesh.");
  const shape = value as MeshShapeNode;
  if (shape.type !== "meshShape" || !Array.isArray(shape.vertices) || !Array.isArray(shape.faces) || shape.vertices.length > MAX_COMPONENTS || shape.faces.length > MAX_COMPONENTS) throw Error("Meshes support at most 100,000 vertices and 100,000 faces.");
  if (typeof shape.color !== "string" || !/^#[0-9a-f]{6}$/i.test(shape.color) || !["flat", "smooth"].includes(shape.shading) || typeof shape.wireframe !== "boolean") throw Error("Invalid mesh color, shading or wireframe setting.");
  const vertices = new Map<string, MeshVertex>(), faceIds = new Set<string>(), directed = new Set<string>(), incident = new Map<string, string[]>();
  for (const vertex of shape.vertices) {
    if (!vertex || !validId(vertex.id) || vertices.has(vertex.id) || !validPosition(vertex.position)) throw Error("Mesh vertices need unique IDs and finite positions within ±1,000,000.");
    vertices.set(vertex.id, vertex);
  }
  for (const face of shape.faces) {
    if (!face || !validId(face.id) || faceIds.has(face.id) || vertices.has(face.id) || !Array.isArray(face.vertices) || face.vertices.length < 3 || face.vertices.length > 64 || new Set(face.vertices).size !== face.vertices.length || face.vertices.some(id => !vertices.has(id))) throw Error("Mesh faces need unique IDs and 3–64 distinct existing vertex IDs.");
    faceIds.add(face.id); faceTriangles(face, vertices);
    for (let index = 0; index < face.vertices.length; index++) {
      const a = face.vertices[index], b = face.vertices[(index + 1) % face.vertices.length], key = JSON.stringify([a, b]);
      if (directed.has(key)) throw Error("Mesh edges must have consistent face winding and at most two adjacent faces.");
      directed.add(key); const faces = incident.get(a) ?? []; faces.push(face.id); incident.set(a, faces);
    }
  }
  const adjacency = new Map<string, Map<string, Set<string>>>();
  for (const edge of meshEdges(shape)) {
    if (edge.faceIds.length > 2) throw Error("Nonmanifold mesh edges are unsupported.");
    if (edge.faceIds.length === 2) for (const vertex of edge.vertices) {
      const map = adjacency.get(vertex) ?? new Map<string, Set<string>>(); adjacency.set(vertex, map);
      for (const [a, b] of [edge.faceIds, [...edge.faceIds].reverse()]) { const neighbors = map.get(a) ?? new Set<string>(); neighbors.add(b); map.set(a, neighbors); }
    }
  }
  for (const [vertex, faces] of incident) {
    const pending = [faces[0]], visited = new Set<string>();
    while (pending.length) { const face = pending.pop()!; if (visited.has(face)) continue; visited.add(face); pending.push(...adjacency.get(vertex)?.get(face) ?? []); }
    if (visited.size !== faces.length) throw Error("Nonmanifold mesh vertices cannot join disconnected face fans.");
  }
}

function pruneVertices(shape: MeshShapeNode): MeshShapeNode {
  const used = new Set(shape.faces.flatMap(face => face.vertices)); return { ...shape, vertices: shape.vertices.filter(vertex => used.has(vertex.id)) };
}
function commitShape(store: SceneStore, shape: MeshShapeNode, editLabel: string) {
  validateMeshShape(shape);
  const doc = store.getState().document;
  if (JSON.stringify(shape) === JSON.stringify(doc.nodes[shape.id])) return;
  store.setState({ document: { ...doc, nodes: { ...doc.nodes, [shape.id]: shape } }, editLabel });
}
function selectedShape(store: SceneStore, id: string): MeshShapeNode {
  const shape = store.getState().document.nodes[id]; if (shape?.type !== "meshShape") throw Error("Choose a polygon mesh shape."); return shape;
}
function selectedFaces(shape: MeshShapeNode, ids: string[]): MeshFace[] {
  const requested = new Set(ids), faces = shape.faces.filter(face => requested.has(face.id));
  if (faces.length !== requested.size) throw Error("A selected mesh face no longer exists."); return faces;
}

function outline(indices: number[]): number[] {
  const boundary = new Map<string, [number, number]>();
  for (let index = 0; index < indices.length; index += 3) for (let side = 0; side < 3; side++) {
    const a = indices[index + side], b = indices[index + (side + 1) % 3], key = JSON.stringify([Math.min(a, b), Math.max(a, b)]);
    if (boundary.has(key)) boundary.delete(key); else boundary.set(key, [a, b]);
  }
  const next = new Map([...boundary.values()]), result: number[] = [], first = next.keys().next().value as number;
  let current = first;
  do { result.push(current); const following = next.get(current); if (following === undefined || result.length > boundary.size) throw Error("Invalid primitive boundary."); current = following; } while (current !== first);
  return result;
}

export function createMeshPrimitive(store: SceneStore, preset: MeshPrimitive, options: MeshPrimitiveOptions = {}): string {
  const size = options.size ?? 1;
  if (!Number.isFinite(size) || size <= 0 || size > 1e6) throw Error("Mesh size must be positive and at most 1,000,000.");
  let geometry: BufferGeometry;
  if (preset === "cube") geometry = new BoxGeometry(size, size, size);
  else if (preset === "plane") geometry = new PlaneGeometry(size, size).rotateX(-Math.PI / 2);
  else if (preset === "sphere") geometry = new SphereGeometry(size / 2, 16, 12);
  else if (preset === "cylinder") geometry = new CylinderGeometry(size / 2, size / 2, size, 16, 1);
  else throw Error("Unknown mesh primitive.");
  // Reuse Three primitives and welding; discard normals/UV seams so adjacent
  // polygons share authored topology. Appearance normals are derived later.
  geometry.deleteAttribute("normal"); geometry.deleteAttribute("uv");
  const welded = mergeVertices(geometry, size * 1e-7); geometry.dispose();
  const positions = welded.getAttribute("position"), indices = Array.from(welded.getIndex()!.array);
  const vertices: MeshVertex[] = Array.from({ length: positions.count }, (_, index) => ({ id: crypto.randomUUID(), position: [positions.getX(index), positions.getY(index), positions.getZ(index)] }));
  const polygons: number[][] = [];
  if (preset === "cube") for (const group of welded.groups) polygons.push(outline(indices.slice(group.start, group.start + group.count)));
  else if (preset === "plane") polygons.push(outline(indices));
  else if (preset === "cylinder") for (const group of welded.groups) {
    if (group.materialIndex === 0) for (let index = group.start; index < group.start + group.count; index += 6) polygons.push(outline(indices.slice(index, index + 6)));
    else polygons.push(outline(indices.slice(group.start, group.start + group.count)));
  } else for (let index = 0; index < indices.length; index += 3) polygons.push(indices.slice(index, index + 3));
  welded.dispose();
  const doc = store.getState().document, id = crypto.randomUUID(), shapeId = crypto.randomUUID(), name = uniqueName(doc, options.name ?? preset);
  const node: TransformNode = { id, type: "transform", parentId: null, name, rotationOrder: "XYZ", ...normalizedChannels({ position: options.position ?? [0, 0, 0], rotation: options.rotation ?? [0, 0, 0], scale: options.scale ?? [1, 1, 1] }) };
  const shape = pruneVertices({ id: shapeId, type: "meshShape", parentId: id, name: `${name}Shape`, vertices, faces: polygons.map(polygon => ({ id: crypto.randomUUID(), vertices: polygon.map(index => vertices[index].id) })), color: options.color ?? "#9aa8b8", shading: "flat", wireframe: false });
  validateMeshShape(shape);
  store.setState({ document: { ...doc, rootIds: [...doc.rootIds, id], nodes: { ...doc.nodes, [id]: node, [shapeId]: shape } }, editLabel: "Create polygon mesh" }); return id;
}

export function setMeshVertexPositions(store: SceneStore, shapeId: string, changes: { id: string; position: Vec3 }[]): void {
  const shape = selectedShape(store, shapeId), replacements = new Map<string, Vec3>();
  for (const change of changes) {
    if (!change || !validPosition(change.position) || replacements.has(change.id)) throw Error("Vertex edits need unique IDs and finite positions within ±1,000,000.");
    replacements.set(change.id, [...change.position]);
  }
  const existingIds = new Set(shape.vertices.map(vertex => vertex.id));
  if ([...replacements.keys()].some(id => !existingIds.has(id))) throw Error("A selected mesh vertex no longer exists.");
  commitShape(store, { ...shape, vertices: shape.vertices.map(vertex => replacements.has(vertex.id) ? { ...vertex, position: replacements.get(vertex.id)! } : vertex) }, "Move mesh vertices");
}
export function updateMeshAppearance(store: SceneStore, shapeId: string, patch: Partial<Pick<MeshShapeNode, "color" | "shading" | "wireframe">>): void {
  const shape = selectedShape(store, shapeId);
  commitShape(store, { ...shape, ...(patch.color !== undefined ? { color: patch.color } : {}), ...(patch.shading !== undefined ? { shading: patch.shading } : {}), ...(patch.wireframe !== undefined ? { wireframe: patch.wireframe } : {}) }, "Edit mesh appearance");
}
export function deleteMeshFaces(store: SceneStore, shapeId: string, faceIds: string[]): void {
  const shape = selectedShape(store, shapeId); selectedFaces(shape, faceIds); const removed = new Set(faceIds);
  commitShape(store, pruneVertices({ ...shape, faces: shape.faces.filter(face => !removed.has(face.id)) }), "Delete mesh faces");
}
export function extrudeMeshFaces(store: SceneStore, shapeId: string, faceIds: string[], distance: number): string[] {
  const shape = selectedShape(store, shapeId), faces = selectedFaces(shape, faceIds), selected = new Set(faces.map(face => face.id));
  if (!faces.length) throw Error("Select an edge-connected face region to extrude.");
  if (!Number.isFinite(distance) || distance === 0 || Math.abs(distance) > 1e6) throw Error("Extrusion distance must be nonzero and within ±1,000,000.");
  const edges = meshEdges(shape), neighbors = new Map(faces.map(face => [face.id, new Set<string>()]));
  for (const edge of edges) if (edge.faceIds.length === 2 && edge.faceIds.every(id => selected.has(id))) { neighbors.get(edge.faceIds[0])!.add(edge.faceIds[1]); neighbors.get(edge.faceIds[1])!.add(edge.faceIds[0]); }
  const pending = [faces[0].id], visited = new Set<string>();
  while (pending.length) { const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id); pending.push(...neighbors.get(id)!); }
  if (visited.size !== faces.length) throw Error("Extrude one edge-connected face region at a time.");
  const boundaryIds = new Set(edges.filter(edge => edge.faceIds.filter(id => selected.has(id)).length === 1).map(edge => edge.id));
  if (!boundaryIds.size) throw Error("A closed whole mesh has no region boundary to extrude.");
  const vertices = new Map(shape.vertices.map(vertex => [vertex.id, vertex])), normal = new Vector3(); let area = 0;
  for (const face of faces) { const weighted = polygonNormal(face.vertices.map(id => new Vector3(...vertices.get(id)!.position))); normal.add(weighted); area += weighted.length(); }
  if (normal.length() <= Math.max(1e-24, area * 1e-12)) throw Error("The selected region has no stable average normal to extrude.");
  const offset = normal.normalize().multiplyScalar(distance), copied = new Map<string, MeshVertex>();
  for (const face of faces) for (const id of face.vertices) if (!copied.has(id)) copied.set(id, { id: crypto.randomUUID(), position: new Vector3(...vertices.get(id)!.position).add(offset).toArray() as Vec3 });
  const topFaces = faces.map(face => ({ id: crypto.randomUUID(), vertices: face.vertices.map(id => copied.get(id)!.id) })), walls: MeshFace[] = [];
  // Shared topology equivalent of Three ExtrudeGeometry's boundary sidewalls:
  // connect each old boundary edge to its translated pair; internal edges get no walls.
  for (const face of faces) for (let index = 0; index < face.vertices.length; index++) {
    const a = face.vertices[index], b = face.vertices[(index + 1) % face.vertices.length];
    if (boundaryIds.has(edgeKey(a, b))) walls.push({ id: crypto.randomUUID(), vertices: [a, b, copied.get(b)!.id, copied.get(a)!.id] });
  }
  commitShape(store, pruneVertices({ ...shape, vertices: [...shape.vertices, ...copied.values()], faces: [...shape.faces.filter(face => !selected.has(face.id)), ...topFaces, ...walls] }), "Extrude mesh faces");
  return topFaces.map(face => face.id);
}
