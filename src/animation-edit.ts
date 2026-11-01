import { keyChannels, type AnimationPose } from "./animation.ts";
import type { SceneDocument, Vec3, TransformChannels } from "./scene-document.ts";
import type { Joint } from "./skeleton.ts";

/** Keep quaternion-derived gizmo angles on the nearest authored Euler revolution.
 * Numeric channel edits must bypass this: entering 720 degrees is intentional.
 * Also choose the nearest equivalent XYZ Euler branch around the middle-axis singularity.
 * This is continuity for individual edits, not a full animation Euler-filter operation.
 */
export function unwrapEuler(rotation: Vec3, reference: Vec3): Vec3 {
  if (!rotation.every(Number.isFinite) || !reference.every(Number.isFinite)) throw Error("Euler angles must be finite.");
  const nearest = (angles: Vec3) => angles.map((angle, axis) => angle + 360 * Math.round((reference[axis] - angle) / 360)) as Vec3;
  const primary = nearest(rotation);
  const alternate = nearest([rotation[0] + 180, 180 - rotation[1], rotation[2] + 180]);
  const distance = (angles: Vec3) => angles.reduce((sum, angle, axis) => sum + (angle - reference[axis]) ** 2, 0);
  return distance(alternate) < distance(primary) ? alternate : primary;
}

export function mergeJointPose(
  before: Joint, after: Joint, current: AnimationPose,
  kind: "position" | "rotation" | "transform", unwrapRotation = false,
): AnimationPose {
  const pose: AnimationPose = {
    position: [...current.position], rotation: [...current.rotation], scale: [...current.scale], visibility: current.visibility,
  };
  if (kind === "position") {
    // The legacy rigging fields report an authored joint with one changed axis.
    // Keep the other animated axes at their evaluated values for this edit preview.
    for (let axis = 0; axis < 3; axis++) if (before.position[axis] !== after.position[axis]) pose.position[axis] = after.position[axis];
  } else if (kind === "transform") {
    // Channel Box edits and translation gizmos already provide a complete displayed pose.
    pose.position = [...after.position];
  }
  if (kind === "rotation" || kind === "transform") {
    const rotation: Vec3 = [...(after.rotation ?? [0, 0, 0])];
    pose.rotation = unwrapRotation ? unwrapEuler(rotation, current.rotation) : rotation;
  }
  return pose;
}

/** Layered pose edits must not overwrite the authored fallback underneath the
 * layer stack. Unkeyed changes remain document-scoped previews until keyed. */
export function prepareTransformAnimationEdit(document: SceneDocument, id: string, pose: TransformChannels & { visibility: number }, frame: number, autoKey: boolean): SceneDocument {
  const node = document.nodes[id];
  if (node?.type !== "transform") throw Error("Transform target is missing.");
  let next = document.animation?.layers?.length ? { ...document } : {
    ...document, nodes: { ...document.nodes, [id]: { ...node, position: [...pose.position] as Vec3, rotation: [...pose.rotation] as Vec3, scale: [...pose.scale] as Vec3 } },
  };
  if (autoKey) next = keyChannels(next, id, pose, Math.round(frame));
  return next;
}

/** Prepare all joint edits and auto keys as one immutable document for one history commit. */
export function prepareJointAnimationEdit(
  document: SceneDocument, nextJoints: Joint[], label: string, frame: number, autoKey: boolean,
  currentPose: (id: string) => AnimationPose,
): { document: SceneDocument; overrides: Map<string, AnimationPose> } {
  const overrides = new Map<string, AnimationPose>();
  const kind = label === "Move joint" ? "position" : label === "Rotate selected joints" ? "rotation" : label === "Transform joint" ? "transform" : undefined;
  if (!kind) return { document: { ...document, joints: nextJoints }, overrides };
  const previous = new Map((document.joints ?? []).map(joint => [joint.id, joint]));
  const joints = nextJoints.map(joint => {
    const before = previous.get(joint.id);
    if (!before || before === joint) return joint;
    const pose = mergeJointPose(before, joint, currentPose(joint.id), kind, kind === "rotation");
    overrides.set(joint.id, pose);
    if (document.animation?.layers?.length) return before;
    return kind === "rotation" ? { ...joint, rotation: [...pose.rotation] as Vec3 } : joint;
  });
  let next: SceneDocument = { ...document, joints };
  if (autoKey) for (const [id, pose] of overrides) next = keyChannels(next, id, pose, Math.round(frame));
  return { document: next, overrides };
}
