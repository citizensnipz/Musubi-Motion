import { Box3, BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial } from "three";
import { meshEdges, triangulateMesh, validateMeshShape } from "./mesh-modeling.ts";
import type { MeshShapeNode, Vec3 } from "./scene-document.ts";

export type MeshVertexPreview = { id: string; position: Vec3 };

function geometryFor(shape: MeshShapeNode) {
  const data = triangulateMesh(shape), geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(data.positions, 3).setUsage(DynamicDrawUsage));
  geometry.setIndex(data.indices);
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const normals = geometry.getAttribute("normal") as BufferAttribute;
  normals.setUsage(DynamicDrawUsage);
  const vertexIndices = new Map(data.vertexIds.map((id, index) => [id, index]));
  const edgeVertexIndices = new Uint32Array(meshEdges(shape).flatMap(edge => edge.vertices.map(id => vertexIndices.get(id)!)));
  const lines = new Float32Array(edgeVertexIndices.length * 3);
  for (let i = 0; i < edgeVertexIndices.length; i++) lines.set(data.positions.subarray(edgeVertexIndices[i] * 3, edgeVertexIndices[i] * 3 + 3), i * 3);
  const edges = new BufferGeometry(); edges.setAttribute("position", new BufferAttribute(lines, 3).setUsage(DynamicDrawUsage));
  edges.computeBoundingBox(); edges.computeBoundingSphere();
  return { geometry, edges, ...data, vertexIndices, edgeVertexIndices,
    committedPositions: data.positions.slice(), committedNormals: (normals.array as Float32Array).slice(),
    committedBounds: geometry.boundingBox!.clone(), committedSphere: geometry.boundingSphere!.clone(),
    committedEdgeBounds: edges.boundingBox!.clone(), committedEdgeSphere: edges.boundingSphere!.clone() };
}

/** Document topology is separate from triangulated GPU buffers and face hit mapping. */
export function createMeshRenderable(shape: MeshShapeNode) {
  validateMeshShape(shape);
  let data = geometryFor(shape), previous = shape, disposed = false, previewing = false;
  const material = new MeshStandardMaterial({ color: shape.color, roughness: .8, metalness: 0,
    side: DoubleSide, flatShading: shape.shading === "flat", polygonOffset: shape.wireframe, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const mesh = new Mesh(data.geometry, material); mesh.name = shape.name;
  const lineMaterial = new LineBasicMaterial({ color: 0x252525, transparent: true, opacity: .75 });
  const edges = new LineSegments(data.edges, lineMaterial); edges.visible = shape.wireframe; mesh.add(edges);
  const bounds = data.geometry.boundingBox?.clone() ?? new Box3();

  function updateWirePositions(): void {
    const positions = edges.geometry.getAttribute("position") as BufferAttribute;
    for (let i = 0; i < data.edgeVertexIndices.length; i++) {
      const index = data.edgeVertexIndices[i] * 3;
      positions.setXYZ(i, data.positions[index], data.positions[index + 1], data.positions[index + 2]);
    }
    positions.needsUpdate = true;
  }

  function clearPreview(): void {
    if (disposed || !previewing) return;
    data.positions.set(data.committedPositions);
    const positions = mesh.geometry.getAttribute("position") as BufferAttribute, normals = mesh.geometry.getAttribute("normal") as BufferAttribute;
    normals.array.set(data.committedNormals);
    positions.needsUpdate = true; normals.needsUpdate = true;
    updateWirePositions();
    mesh.geometry.boundingBox!.copy(data.committedBounds); mesh.geometry.boundingSphere!.copy(data.committedSphere);
    edges.geometry.boundingBox!.copy(data.committedEdgeBounds); edges.geometry.boundingSphere!.copy(data.committedEdgeSphere);
    bounds.copy(data.committedBounds); previewing = false;
  }

  return {
    mesh, bounds,
    get centers() { return data.positions; },
    get triangleFaceIds() { return data.triangleFaceIds; },
    /** Transient absolute local edits use the committed tessellation throughout
     * a gesture. Full topology validation and retessellation belong to commit.
     * The returned shape is for overlays only and must not enter document state. */
    previewVertices(changes: readonly MeshVertexPreview[]): MeshShapeNode {
      if (disposed) throw Error("Cannot preview a disposed mesh renderer.");
      if (!Array.isArray(changes)) throw Error("Mesh preview changes must be an array.");
      const edits = new Map<string, Vec3>();
      for (const change of changes as readonly MeshVertexPreview[]) {
        if (!change || typeof change.id !== "string" || !data.vertexIndices.has(change.id)) throw Error("Mesh preview references an unknown vertex.");
        if (edits.has(change.id)) throw Error("Mesh preview vertex IDs must be unique.");
        if (!Array.isArray(change.position) || change.position.length !== 3 || ![0, 1, 2].every(index => typeof change.position[index] === "number" && Number.isFinite(change.position[index]) && Math.abs(change.position[index]) <= 1e6)) throw Error("Mesh preview positions must be finite XYZ values within ±1,000,000.");
        edits.set(change.id, [...change.position]);
      }
      // Finish allocating/validating the ephemeral document view before touching
      // any visible buffer, including a currently active preview.
      const preview: MeshShapeNode = { ...previous, vertices: previous.vertices.map(vertex => {
        const position = edits.get(vertex.id);
        return position ? { ...vertex, position } : vertex;
      }) };
      if (!changes.length) { clearPreview(); return preview; }
      data.positions.set(data.committedPositions);
      for (const [id, position] of edits) data.positions.set(position, data.vertexIndices.get(id)! * 3);
      (mesh.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
      mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
      updateWirePositions(); edges.geometry.computeBoundingBox(); edges.geometry.computeBoundingSphere();
      bounds.copy(mesh.geometry.boundingBox!); previewing = true;
      return preview;
    },
    clearPreview,
    update(next: MeshShapeNode) {
      if (disposed) throw Error("Cannot update a disposed mesh renderer.");
      validateMeshShape(next);
      if (next.vertices !== previous.vertices || next.faces !== previous.faces) {
        const replacement = geometryFor(next), oldGeometry = mesh.geometry, oldEdges = edges.geometry;
        mesh.geometry = replacement.geometry; edges.geometry = replacement.edges; data = replacement;
        bounds.copy(replacement.geometry.boundingBox!); previewing = false; oldGeometry.dispose(); oldEdges.dispose();
      } else clearPreview();
      const flatShading = next.shading === "flat";
      if (material.flatShading !== flatShading) { material.flatShading = flatShading; material.needsUpdate = true; }
      material.color.set(next.color); material.polygonOffset = next.wireframe;
      mesh.name = next.name; edges.visible = next.wireframe; previous = next;
    },
    dispose() {
      if (disposed) return; disposed = true;
      mesh.geometry.dispose(); edges.geometry.dispose(); material.dispose(); lineMaterial.dispose(); mesh.removeFromParent();
    },
  };
}
