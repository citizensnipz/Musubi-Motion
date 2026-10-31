import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import type { AnimationPose } from "./animation.ts";
import { constraintWorldMatrices } from "./constraints.ts";
import type { SceneDocument, TransformChannels, Vec3 } from "./scene-document.ts";

/** Root-level controller placement from the displayed world pose. */
export function controllerPlacement(doc: SceneDocument, poses: ReadonlyMap<string, AnimationPose>, id: string): TransformChannels {
  const matrix = constraintWorldMatrices(doc, poses).get(id);
  if (!matrix) throw Error("Select an object or joint to place the controller.");
  const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
  matrix.decompose(position, rotation, scale);
  if (![...position.toArray(), ...rotation.toArray(), ...scale.toArray()].every(Number.isFinite) || scale.toArray().some(value => value < 0.001)) {
    throw Error("The selected world pose has an unsupported scale. Create at the origin or restore positive scales of at least 0.001.");
  }
  const reconstructed = new Matrix4().compose(position, rotation, scale);
  if (matrix.elements.some((value, index) => Math.abs(value - reconstructed.elements[index]) > 1e-6 * Math.max(1, Math.abs(value)))) {
    throw Error("The selected world pose contains shear. Use uniform ancestor scales or create the controller at the origin.");
  }
  const angles = new Euler().setFromQuaternion(rotation.normalize(), "XYZ");
  return { position: position.toArray() as Vec3, rotation: [angles.x, angles.y, angles.z].map(MathUtils.radToDeg) as Vec3, scale: scale.toArray() as Vec3 };
}
