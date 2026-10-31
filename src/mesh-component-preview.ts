import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, Points, PointsMaterial, DoubleSide } from "three";
import { meshEdges } from "./mesh-modeling.ts";
import type { MeshShapeNode } from "./scene-document.ts";

export type MeshComponentMode = "vertex" | "edge" | "face";

/** Component overlays are temporary children of the mesh, never document data. */
export function createMeshComponentPreview() {
  const group = new Group(); group.name = "Mesh component selection";
  const allPoints = new Points(new BufferGeometry(), new PointsMaterial({ size: 4, sizeAttenuation: false,
    color: 0xc9d4dd, opacity: .7, depthTest: false, depthWrite: false, transparent: true }));
  const allLines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x8db6d0, opacity: .5,
    depthTest: false, depthWrite: false, transparent: true }));
  const points = new Points(new BufferGeometry(), new PointsMaterial({ size: 7, sizeAttenuation: false,
    color: 0xffbe64, depthTest: false, depthWrite: false, transparent: true }));
  const lines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xffbe64,
    depthTest: false, depthWrite: false, transparent: true }));
  const faces = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: 0xffbe64, opacity: .35,
    transparent: true, side: DoubleSide, depthTest: false, depthWrite: false }));
  for (const object of [points, lines, faces]) { object.renderOrder = 100005; object.frustumCulled = false; group.add(object); }
  for (const object of [allPoints, allLines]) { object.renderOrder = 100004; object.frustumCulled = false; group.add(object); }
  let previousShape: MeshShapeNode | undefined, previousMode: MeshComponentMode | undefined, signature = "";
  let previousIds: readonly string[] | undefined;
  function replace(object: Points | LineSegments | Mesh, values: number[]) {
    const old = object.geometry, geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(values), 3)); object.geometry = geometry; old.dispose();
  }
  return {
    update(shape: MeshShapeNode, mesh: Mesh, triangleFaceIds: readonly string[], mode: MeshComponentMode, ids: readonly string[]) {
      if (group.parent !== mesh) mesh.add(group);
      // The editor replaces its selection array; unchanged frames need no ID serialization.
      if (shape === previousShape && mode === previousMode && ids === previousIds) return;
      const key = JSON.stringify(ids);
      previousIds = ids;
      if (shape === previousShape && mode === previousMode && key === signature) return;
      const geometryChanged = shape !== previousShape || mode !== previousMode;
      previousShape = shape; previousMode = mode; signature = key;
      const selected = new Set(ids), vertices = new Map(shape.vertices.map(vertex => [vertex.id, vertex.position]));
      points.visible = mode === "vertex"; lines.visible = mode === "edge"; faces.visible = mode === "face";
      allPoints.visible = mode === "vertex"; allLines.visible = mode === "edge";
      if (geometryChanged && mode === "vertex") replace(allPoints, shape.vertices.flatMap(vertex => vertex.position));
      if (geometryChanged && mode === "edge") replace(allLines, meshEdges(shape).flatMap(edge => edge.vertices.flatMap(id => vertices.get(id)!)));
      if (mode === "vertex") replace(points, shape.vertices.filter(vertex => selected.has(vertex.id)).flatMap(vertex => vertex.position));
      if (mode === "edge") replace(lines, meshEdges(shape).filter(edge => selected.has(edge.id)).flatMap(edge => edge.vertices.flatMap(id => vertices.get(id)!)));
      if (mode === "face") {
        const values: number[] = [], position = mesh.geometry.getAttribute("position"), indices = mesh.geometry.getIndex()!;
        triangleFaceIds.forEach((id, triangle) => {
          if (!selected.has(id)) return;
          for (let corner = 0; corner < 3; corner++) {
            const index = indices.getX(triangle * 3 + corner);
            values.push(position.getX(index), position.getY(index), position.getZ(index));
          }
        });
        replace(faces, values);
      }
    },
    setVisible(visible: boolean) { group.visible = visible; },
    clear() { group.removeFromParent(); previousShape = undefined; previousMode = undefined; previousIds = undefined; signature = ""; },
    dispose() { group.removeFromParent(); for (const object of [points, lines, faces, allPoints, allLines]) { object.geometry.dispose(); object.material.dispose(); } },
  };
}
