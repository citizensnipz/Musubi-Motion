import { Box3, BufferAttribute, BufferGeometry, DoubleSide, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial } from "three";
import { meshEdges, triangulateMesh, validateMeshShape } from "./mesh-modeling.ts";
import type { MeshShapeNode } from "./scene-document.ts";

function geometryFor(shape: MeshShapeNode) {
  const data = triangulateMesh(shape), geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(data.positions, 3));
  geometry.setIndex(data.indices);
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const vertices = new Map(shape.vertices.map(vertex => [vertex.id, vertex.position]));
  const lines = new Float32Array(meshEdges(shape).flatMap(edge => edge.vertices.flatMap(id => vertices.get(id)!)));
  const edges = new BufferGeometry(); edges.setAttribute("position", new BufferAttribute(lines, 3));
  return { geometry, edges, ...data };
}

/** Document topology is separate from triangulated GPU buffers and face hit mapping. */
export function createMeshRenderable(shape: MeshShapeNode) {
  validateMeshShape(shape);
  let data = geometryFor(shape), previous = shape, disposed = false;
  const material = new MeshStandardMaterial({ color: shape.color, roughness: .8, metalness: 0,
    side: DoubleSide, flatShading: shape.shading === "flat", polygonOffset: shape.wireframe, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const mesh = new Mesh(data.geometry, material); mesh.name = shape.name;
  const lineMaterial = new LineBasicMaterial({ color: 0x252525, transparent: true, opacity: .75 });
  const edges = new LineSegments(data.edges, lineMaterial); edges.visible = shape.wireframe; mesh.add(edges);
  const bounds = data.geometry.boundingBox?.clone() ?? new Box3();
  return {
    mesh, bounds,
    get centers() { return data.positions; },
    get triangleFaceIds() { return data.triangleFaceIds; },
    update(next: MeshShapeNode) {
      if (disposed) throw Error("Cannot update a disposed mesh renderer.");
      validateMeshShape(next);
      if (next.vertices !== previous.vertices || next.faces !== previous.faces) {
        const replacement = geometryFor(next), oldGeometry = mesh.geometry, oldEdges = edges.geometry;
        mesh.geometry = replacement.geometry; edges.geometry = replacement.edges; data = replacement;
        bounds.copy(replacement.geometry.boundingBox!); oldGeometry.dispose(); oldEdges.dispose();
      }
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
