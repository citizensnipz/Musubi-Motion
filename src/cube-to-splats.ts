import { Color, Matrix4, Quaternion, Vector3 } from "three";
import { meshEdges, validateMeshShape } from "./mesh-modeling";
import type { MeshShapeNode } from "./scene-document";

export type CubeSplatSettings = { resolution: number; overlap: number; thickness: number; opacity: number; shading: boolean };
export const defaultCubeSplatSettings: CubeSplatSettings = { resolution: 32, overlap: .65, thickness: .05, opacity: .98, shading: true };

/** Validate the prototype's six square faces, using authored face normals rather than smooth vertex normals. */
export function cubeSplatFaces(shape: MeshShapeNode) {
  validateMeshShape(shape);
  const fail = () => { throw Error("Select an undeformed cube with six square faces and one solid color."); };
  if (shape.vertices.length !== 8 || shape.faces.length !== 6 || shape.skin || shape.morphTargets?.length || shape.materials?.length) fail();
  const edges = meshEdges(shape);
  if (edges.length !== 12 || edges.some(e => e.faceIds.length !== 2)) fail();
  const vertices = new Map(shape.vertices.map(v => [v.id, new Vector3(...v.position)]));
  const center = shape.vertices.reduce((sum, v) => sum.add(new Vector3(...v.position)), new Vector3()).multiplyScalar(1 / 8);
  let side = 0;
  return shape.faces.map(face => {
    if (face.vertices.length !== 4) fail();
    const [a, b, c, d] = face.vertices.map(id => vertices.get(id)!);
    const u = b.clone().sub(a), v = d.clone().sub(a), length = u.length();
    if (!side) side = length;
    const tolerance = side * 1e-5;
    if (!length || Math.abs(length - side) > tolerance || Math.abs(v.length() - side) > tolerance || Math.abs(u.dot(v)) > side * side * 1e-5 || a.clone().add(u).add(v).distanceTo(c) > tolerance) fail();
    const normal = u.clone().cross(v).normalize();
    if (normal.dot(a.clone().sub(center)) < 0) normal.negate();
    // Each plane must be a supporting plane of the closed convex cube.
    if ([...vertices.values()].some(p => p.clone().sub(a).dot(normal) > tolerance)) fail();
    return { a, u, v, normal, side };
  });
}

/** Standard 32-byte .splat records, also used as the embedded project asset. */
export function cubeToSplatBytes(shape: MeshShapeNode, settings: CubeSplatSettings): Uint8Array<ArrayBuffer> {
  const { resolution: n, overlap, thickness, opacity, shading } = settings;
  if (![16, 32, 64].includes(n) || !Number.isFinite(overlap) || overlap < .3 || overlap > 1.2 || !Number.isFinite(thickness) || thickness < .01 || thickness > .5 || !Number.isFinite(opacity) || opacity < .1 || opacity > 1) throw Error("Invalid cube conversion settings.");
  const faces = cubeSplatFaces(shape), bytes = new Uint8Array(6 * n * n * 32), view = new DataView(bytes.buffer);
  const light = new Vector3(-.4, .8, 1).normalize();
  let index = 0;
  for (const { a, u, v, normal, side } of faces) {
    const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(u.clone().normalize(), normal.clone().cross(u).normalize(), normal));
    const color = new Color(shape.color).multiplyScalar(shading ? .35 + .65 * Math.max(0, normal.dot(light)) : 1).convertLinearToSRGB();
    const spacing = side / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const position = a.clone().addScaledVector(u, (x + .5) / n).addScaledVector(v, (y + .5) / n), offset = index++ * 32;
      [position.x, position.y, position.z, spacing * overlap, spacing * overlap, spacing * thickness].forEach((value, axis) => view.setFloat32(offset + axis * 4, value, true));
      [color.r, color.g, color.b, opacity].forEach((value, axis) => { bytes[offset + 24 + axis] = Math.round(value * 255); });
      [rotation.w, rotation.x, rotation.y, rotation.z].forEach((value, axis) => { bytes[offset + 28 + axis] = Math.max(0, Math.min(255, Math.round(value * 128 + 128))); });
    }
  }
  return bytes;
}
