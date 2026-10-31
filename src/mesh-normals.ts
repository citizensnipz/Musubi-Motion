import { meshEdges, setMeshTopology } from "./mesh-modeling.ts";
import type { SceneStore } from "./scene-store.ts";

/** Reverse complete edge-connected shells, preserving consistent shared-edge winding. */
export function reverseMeshNormals(store: SceneStore, shapeId: string, faceIds?: readonly string[]): string[] {
  const shape = store.getState().document.nodes[shapeId];
  if (shape?.type !== "meshShape") throw Error("Choose a polygon mesh shape before reversing normals.");
  const existing = new Set(shape.faces.map(face => face.id));
  if (faceIds !== undefined && (!Array.isArray(faceIds) || !faceIds.length || faceIds.length > 100_000 || [...new Set(faceIds)].some(id => !existing.has(id))))
    throw Error("Select one or more existing mesh faces before reversing their shells.");
  if (!shape.faces.length) return [];

  const affected = faceIds === undefined ? existing : new Set<string>();
  if (faceIds !== undefined) {
    const neighbors = new Map(shape.faces.map(face => [face.id, new Set<string>()]));
    for (const edge of meshEdges(shape)) {
      for (const face of edge.faceIds) for (const other of edge.faceIds) if (face !== other) neighbors.get(face)!.add(other);
    }
    const pending = [...new Set(faceIds)];
    while (pending.length) {
      const id = pending.pop()!;
      if (affected.has(id)) continue;
      affected.add(id);
      for (const neighbor of neighbors.get(id)!) if (!affected.has(neighbor)) pending.push(neighbor);
    }
  }
  const changedIds = shape.faces.filter(face => affected.has(face.id)).map(face => face.id);
  const faces = shape.faces.map(face => affected.has(face.id) ? { ...face, vertices: [...face.vertices].reverse() } : face);
  setMeshTopology(store, shape.id, { vertices: shape.vertices, faces }, "Reverse mesh normals");
  return changedIds;
}
