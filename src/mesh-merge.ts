import { Vector3 } from "three";
import { setMeshTopology } from "./mesh-modeling.ts";
import { faceCycle } from "./mesh-topology-utils.ts";
import type { MeshFace, Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

/** Weld selected vertices to their local centroid, preserving stable surviving component IDs. */
export function mergeMeshVerticesToCenter(store: SceneStore, shapeId: string, vertexIds: readonly string[]): string {
  const shape = store.getState().document.nodes[shapeId];
  if (typeof shapeId !== "string" || shape?.type !== "meshShape") throw Error("Choose a polygon mesh shape.");
  if (!Array.isArray(vertexIds) || vertexIds.length > 100_000 || vertexIds.some(id => typeof id !== "string" || !id)) {
    throw Error("Choose at most 100,000 existing mesh vertex IDs to merge.");
  }
  const requested = new Set(vertexIds);
  const selected = shape.vertices.filter(vertex => requested.has(vertex.id));
  if (selected.length !== requested.size) throw Error("A selected mesh vertex no longer exists. Select vertices again.");
  if (selected.length < 2) throw Error("Select at least two distinct vertices to merge to center.");
  const survivor = selected[0].id, center = new Vector3();
  for (const vertex of selected) center.add(new Vector3(...vertex.position));
  center.divideScalar(selected.length);
  const vertices = shape.vertices.filter(vertex => vertex.id === survivor || !requested.has(vertex.id))
    .map(vertex => vertex.id === survivor ? { ...vertex, position: center.toArray() as Vec3 } : vertex);
  const faces: MeshFace[] = [], cycles = new Set<string>();
  for (const face of shape.faces) {
    const corners: string[] = [];
    for (const id of face.vertices) {
      const next = requested.has(id) ? survivor : id;
      if (corners[corners.length - 1] !== next) corners.push(next);
    }
    if (corners.length > 1 && corners[0] === corners[corners.length - 1]) corners.pop();
    if (corners.length < 3) continue;
    if (new Set(corners).size !== corners.length) throw Error("Merging these vertices would pinch a face. Select adjacent corners instead.");
    const cycle = faceCycle(corners);
    if (cycles.has(cycle)) throw Error("Merging these vertices would create duplicate faces. Adjust the selection or remove overlapping faces first.");
    cycles.add(cycle);
    faces.push(corners.length === face.vertices.length && corners.every((id, index) => id === face.vertices[index])
      ? face : { ...face, vertices: corners });
  }
  setMeshTopology(store, shape.id, { vertices, faces }, "Merge vertices to center");
  return survivor;
}
