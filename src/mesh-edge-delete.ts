import { meshEdges, setMeshTopology } from "./mesh-modeling.ts";
import { faceCycle } from "./mesh-topology-utils.ts";
import type { MeshFace } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

const MAX_SELECTED_EDGES = 20_000;
const edgeKey = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);
type MergeGroup = { firstFace: MeshFace; boundary: [string, string][] };

function boundaryLoop(group: MergeGroup): string[] {
  const { boundary } = group;
  if (!boundary.length) throw Error("Cannot delete edges across a closed shell with no boundary.");
  if (boundary.length > 64) throw Error("Deleting these edges would create a face with more than 64 corners.");
  const outgoing = new Map<string, string>(), incoming = new Set<string>();
  for (const [a, b] of boundary) {
    if (outgoing.has(a) || incoming.has(b)) throw Error("Deleting these edges would create repeated boundary vertices.");
    outgoing.set(a, b); incoming.add(b);
  }
  const first = boundary[0][0], visited = new Set<string>(), loop: string[] = [];
  let current = first;
  while (!visited.has(current)) {
    visited.add(current); loop.push(current);
    const next = outgoing.get(current);
    if (next === undefined) throw Error("Selected edges do not form a closed polygon boundary.");
    current = next;
  }
  if (current !== first || visited.size !== boundary.length) throw Error("Deleting these edges would create holes or multiple boundary loops.");
  if (loop.length < 3) throw Error("A merged polygon needs at least three distinct boundary vertices.");
  return loop;
}

/** Delete Edge dissolves interior edges, retaining vertex records. It does not
 * implement Delete Edge/Vertex cleanup. Mesh validation/triangulation remains in
 * the shared topology command; no state changes until every group is valid. */
export function deleteMeshEdges(store: SceneStore, shapeId: string, edgeIds: readonly string[]): string[] {
  const shape = store.getState().document.nodes[shapeId];
  if (shape?.type !== "meshShape") throw Error("Choose a polygon mesh shape.");
  if (!Array.isArray(edgeIds) || edgeIds.length === 0) throw Error("Select at least one mesh edge to delete.");
  if (edgeIds.length > MAX_SELECTED_EDGES) throw Error("Delete at most 20,000 selected mesh edges per operation.");
  const edges = meshEdges(shape), byId = new Map(edges.map(edge => [edge.id, edge]));
  const selected = new Set(edgeIds), adjacent = new Map<string, Set<string>>();
  for (const id of selected) {
    const edge = byId.get(id);
    if (!edge) throw Error("A selected mesh edge no longer exists.");
    if (edge.faceIds.length !== 2) throw Error("Delete Edge requires interior edges shared by two faces. Delete the adjacent face to remove a border edge.");
    const [a, b] = edge.faceIds;
    for (const [from, to] of [[a, b], [b, a]]) {
      const neighbors = adjacent.get(from) ?? new Set<string>();
      neighbors.add(to); adjacent.set(from, neighbors);
    }
  }

  // Visit in authored order so both surviving face IDs and the returned
  // selection are independent of the order in which edges were selected.
  const membership = new Map<string, MergeGroup>(), groups: MergeGroup[] = [];
  for (const face of shape.faces) {
    if (!adjacent.has(face.id) || membership.has(face.id)) continue;
    const group: MergeGroup = { firstFace: face, boundary: [] }, pending = [face.id];
    groups.push(group); membership.set(face.id, group);
    while (pending.length) {
      const current = pending.pop()!;
      for (const neighbor of adjacent.get(current) ?? []) {
        if (membership.has(neighbor)) continue;
        membership.set(neighbor, group); pending.push(neighbor);
      }
    }
  }
  for (const edge of edges) {
    if (edge.faceIds.length !== 2) continue;
    const group = membership.get(edge.faceIds[0]);
    if (group && group === membership.get(edge.faceIds[1]) && !selected.has(edge.id)) throw Error("This selection would also remove an unselected interior edge. Select every interior edge of each merged region.");
  }
  for (const face of shape.faces) {
    const group = membership.get(face.id);
    if (!group) continue;
    for (let i = 0; i < face.vertices.length; i++) {
      const a = face.vertices[i], b = face.vertices[(i + 1) % face.vertices.length];
      if (!selected.has(edgeKey(a, b))) group.boundary.push([a, b]);
    }
  }
  const merged = new Map(groups.map(group => [group.firstFace.id, { ...group.firstFace, vertices: boundaryLoop(group) }]));
  const faces = shape.faces.flatMap(face => {
    if (!membership.has(face.id)) return [face];
    const replacement = merged.get(face.id);
    return replacement ? [replacement] : [];
  });
  const cycles = new Set<string>();
  for (const face of faces) {
    const cycle = faceCycle(face.vertices);
    if (cycles.has(cycle)) throw Error("Deleting these edges would create duplicate faces. Adjust the selection or remove overlapping faces first.");
    cycles.add(cycle);
  }
  setMeshTopology(store, shapeId, { vertices: shape.vertices, faces }, "Delete mesh edges");
  return groups.map(group => group.firstFace.id);
}
