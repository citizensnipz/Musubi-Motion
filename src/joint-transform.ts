import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import type { Vec3 } from "./scene-document.ts";
import { unwrapEuler } from "./animation-edit.ts";

export type JointOrientation = { orientation?: Vec3 };
export function validateJointAngle(value: unknown, label = "joint orientation"): asserts value is Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || ![0, 1, 2].every(index => typeof value[index] === "number" && Number.isFinite(value[index])))
    throw Error(`Invalid ${label}: enter three finite XYZ angles in degrees.`);
}
export function angleQuaternion(rotation: Vec3): Quaternion {
  return new Quaternion().setFromEuler(new Euler(...rotation.map(MathUtils.degToRad) as Vec3, "XYZ"));
}
export function orientationQuaternion(joint: JointOrientation): Quaternion {
  return angleQuaternion(joint.orientation ?? [0, 0, 0]);
}
/** Joint orientation is a static parent-local frame, followed by animated XYZ channels. */
export function jointLocalQuaternion(joint: JointOrientation, rotation: Vec3): Quaternion {
  return orientationQuaternion(joint).multiply(angleQuaternion(rotation)).normalize();
}
export function jointRotationFromQuaternion(joint: JointOrientation, total: Quaternion, reference?: Vec3): Vec3 {
  const local = orientationQuaternion(joint).invert().multiply(total).normalize();
  const euler = new Euler().setFromQuaternion(local, "XYZ");
  const rotation = [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as Vec3;
  return reference ? unwrapEuler(rotation, reference) : rotation;
}
export function jointLocalMatrix(joint: JointOrientation, position: Vec3, rotation: Vec3): Matrix4 {
  return new Matrix4().compose(new Vector3(...position), jointLocalQuaternion(joint, rotation), new Vector3(1, 1, 1));
}
