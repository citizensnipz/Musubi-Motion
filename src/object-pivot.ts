import { Euler, MathUtils, Matrix3, Matrix4, Quaternion, Vector3 } from "three";
import type { TransformChannels, TransformNode, Vec3 } from "./scene-document.ts";

export type PivotMetadata = { pivot?: Vec3; pivotCompensation?: Vec3; affine?: number[] };
const origin: Vec3 = [0, 0, 0];
function quaternion(pose: TransformChannels) {
  return new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3, "XYZ"));
}
function finiteVector(value: Vec3) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw Error("Pivot values must be finite XYZ coordinates.");
}

/** Parent-local location of the pivot handle, independent of its own rotation/scale. */
export function objectPivotPosition(node: PivotMetadata, pose: TransformChannels): Vector3 {
  return new Vector3(...pose.position).add(new Vector3(...node.pivotCompensation ?? origin)).add(new Vector3(...node.pivot ?? origin));
}

/** Parent-local geometry origin for T(position+comp+pivot) A R S T(-pivot). */
export function objectGeometryPosition(node: PivotMetadata, pose: TransformChannels): Vector3 {
  const rotatedPivot = new Vector3(...node.pivot ?? origin).multiply(new Vector3(...pose.scale)).applyQuaternion(quaternion(pose));
  if (node.affine) rotatedPivot.applyMatrix3(new Matrix3().fromArray(node.affine));
  return objectPivotPosition(node, pose).sub(rotatedPivot);
}

export function objectLocalMatrix(node: PivotMetadata, pose: TransformChannels): Matrix4 {
  const matrix = new Matrix4().compose(new Vector3(), quaternion(pose), new Vector3(...pose.scale));
  if (node.affine) matrix.premultiply(new Matrix4().setFromMatrix3(new Matrix3().fromArray(node.affine)));
  return matrix.setPosition(objectGeometryPosition(node, pose));
}

/** Convert a proxy in the object's parent space back to authored channels. */
export function channelsFromPivotProxy(node: PivotMetadata, proxy: TransformChannels): TransformChannels {
  const position = new Vector3(...proxy.position).sub(new Vector3(...node.pivotCompensation ?? origin)).sub(new Vector3(...node.pivot ?? origin)).toArray() as Vec3;
  finiteVector(position); finiteVector(proxy.rotation); finiteVector(proxy.scale);
  return { position, rotation: [...proxy.rotation], scale: [...proxy.scale] };
}

/** Relocate a geometric-local pivot without moving current geometry or descendants.
 * Compensation preserves this evaluated pose; future animated rotation/scale
 * intentionally use the newly authored pivot. Existing keys are unchanged. */
export function relocateObjectPivot(node: TransformNode, pose: TransformChannels, newPivot: Vec3): TransformNode {
  finiteVector(newPivot);
  const delta = new Vector3(...newPivot).sub(new Vector3(...node.pivot ?? origin));
  const correction = delta.clone().multiply(new Vector3(...pose.scale)).applyQuaternion(quaternion(pose));
  if (node.affine) correction.applyMatrix3(new Matrix3().fromArray(node.affine));
  correction.sub(delta);
  const compensation = new Vector3(...node.pivotCompensation ?? origin).add(correction).toArray() as Vec3;
  finiteVector(compensation);
  return { ...node, pivot: [...newPivot], pivotCompensation: compensation };
}
export const relocatePivot = relocateObjectPivot;

/** Apply a world-parented gizmo in its captured World or Object basis exactly. A rotated object scaled along
 * world axes can acquire shear, so retain its full linear transform instead of
 * throwing that information away through a TRS-only decomposition. */
export function globalObjectTransform(node: TransformNode, pose: TransformChannels, beforeWorld: Matrix4, parentWorld: Matrix4,
  proxy: { position: Vector3; quaternion: Quaternion; scale: Vector3 }, mode: string, initialOrientation = new Quaternion()) {
  const anchor = new Vector3(...node.pivot ?? origin).applyMatrix4(beforeWorld);
  const delta = new Matrix4().compose(proxy.position, proxy.quaternion, proxy.scale)
    .multiply(new Matrix4().compose(anchor, initialOrientation, new Vector3(1, 1, 1)).invert());
  const local = parentWorld.clone().invert().multiply(delta).multiply(beforeWorld);
  let rotation = [...pose.rotation] as Vec3;
  const scale = [...pose.scale] as Vec3;
  if (mode === "rotate") {
    const parentRotation = new Quaternion(); parentWorld.decompose(new Vector3(), parentRotation, new Vector3());
    const deltaRotation = proxy.quaternion.clone().multiply(initialOrientation.clone().invert());
    const next = parentRotation.clone().invert().multiply(deltaRotation).multiply(parentRotation).multiply(quaternion(pose));
    const euler = new Euler().setFromQuaternion(next.normalize(), "XYZ");
    rotation = [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as Vec3;
  }
  if (mode === "scale") { scale[0] = Math.max(.001, scale[0] * proxy.scale.x); scale[1] = Math.max(.001, scale[1] * proxy.scale.y); scale[2] = Math.max(.001, scale[2] * proxy.scale.z); }
  finiteVector(scale);
  const pivot = new Vector3(...node.pivot ?? origin).applyMatrix4(local);
  const position = pivot.sub(new Vector3(...node.pivotCompensation ?? origin)).sub(new Vector3(...node.pivot ?? origin)).toArray() as Vec3;
  const channels: TransformChannels = { position, rotation, scale };
  const nextNode = { ...node };
  if (mode !== "translate") {
    const desired = local.clone().setPosition(0, 0, 0);
    const authored = new Matrix4().compose(new Vector3(), quaternion(channels), new Vector3(...scale));
    const affine = new Matrix3().setFromMatrix4(desired.multiply(authored.invert())).toArray();
    if (affine.some((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) > 1e-10)) nextNode.affine = affine;
    else delete nextNode.affine;
  }
  return { node: nextNode, channels };
}
