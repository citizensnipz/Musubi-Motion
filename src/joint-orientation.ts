import { Euler, MathUtils } from "three";
import { baseChannels, type AnimationPose } from "./animation.ts";
import { validateConstraints } from "./constraints.ts";
import { ikChain, validateIKHandles } from "./ik.ts";
import { jointLocalQuaternion, jointRotationFromQuaternion, validateJointAngle } from "./joint-transform.ts";
import type { SceneDocument, Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import { validateJoints, type Joint } from "./skeleton.ts";

function selected(doc: SceneDocument, ids: readonly string[]): Joint[] {
  validateJoints(doc.joints ?? []);
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length)
    throw Error("Choose between 1 and 1,000 distinct joints.");
  return ids.map(id => {
    const joint = doc.joints?.find(joint => joint.id === id);
    if (!joint) throw Error("A selected joint no longer exists.");
    return joint;
  });
}
function commit(store: SceneStore, joints: Joint[], label: string) {
  const doc = store.getState().document, next = { ...doc, joints };
  validateJoints(joints);
  validateIKHandles(next.ikHandles ?? [], next);
  validateConstraints(next.constraints ?? [], next);
  if (JSON.stringify(joints) === JSON.stringify(doc.joints ?? [])) return;
  store.setState({ document: next, editLabel: label });
}
/** Change the static local frame; rotation channels retain their authored values. */
export function setJointOrientation(store: SceneStore, id: string, orientation: Vec3): void {
  const doc = store.getState().document;
  selected(doc, [id]); validateJointAngle(orientation);
  commit(store, doc.joints!.map(joint => joint.id === id ? { ...joint, orientation: [...orientation] } : joint), "Edit joint orientation");
}
/** Local axes follow the evaluated bone frame and are saved with the joint. */
export function setJointLocalAxes(store: SceneStore, id: string, visible: boolean): void {
  const doc = store.getState().document;
  const [joint] = selected(doc, [id]);
  if (typeof visible !== "boolean") throw Error("Local-axis visibility must be enabled or disabled.");
  if ((joint.showLocalAxes ?? false) === visible) return;
  commit(store, doc.joints!.map(joint => joint.id === id ? { ...joint, showLocalAxes: visible } : joint), "Show joint local axes");
}
/** Absorb prepared FK rotations into the static frame, preserving every local
 * matrix and descendant world pose at that input pose. Existing animation or
 * channel dependencies need rebaking before their coordinate frame can change. */
export function freezeJointRotations(store: SceneStore, ids: readonly string[], poses?: ReadonlyMap<string, AnimationPose>): void {
  const doc = store.getState().document, joints = selected(doc, ids), wanted = new Set(ids);
  const rotation = (channel: string) => channel.startsWith("rotation.");
  if (doc.animation?.tracks.some(track => wanted.has(track.targetId) && rotation(track.channel)))
    throw Error("Remove or bake selected joint rotation time curves before freezing rotations.");
  if (doc.drivenKeys?.some(relation => [relation.driver, relation.driven].some(property => wanted.has(property.targetId) && rotation(property.channel))))
    throw Error("Remove selected joint rotation driven-key dependencies before freezing rotations.");
  if (doc.constraints?.some(constraint => constraint.enabled && wanted.has(constraint.targetId) && ["orient", "aim", "parent"].includes(constraint.type)))
    throw Error("Disable selected joint rotation constraints before freezing rotations.");
  if (doc.ikHandles?.some(handle => handle.enabled && ikChain(doc, handle.rootId, handle.endId).some(id => wanted.has(id))))
    throw Error("Disable IK handles affecting selected joints before freezing rotations.");
  const changed = new Map<string, Joint>();
  for (const joint of joints) {
    const pose = poses?.get(joint.id) ?? (poses ? undefined : baseChannels(doc, joint.id));
    if (!pose) throw Error(`Missing prepared FK pose for ${joint.name}.`);
    validateJointAngle(pose.rotation, "prepared FK rotation");
    if (pose.rotation.every(value => value === 0)) continue;
    const quaternion = jointLocalQuaternion(joint, pose.rotation), euler = new Euler().setFromQuaternion(quaternion, "XYZ");
    const orientation = [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as Vec3;
    const next: Joint = { ...joint, orientation, rotation: [0, 0, 0] };
    // Preferred angles are also expressed in rotation-channel coordinates.
    if (joint.preferredAngle) next.preferredAngle = jointRotationFromQuaternion(next, jointLocalQuaternion(joint, joint.preferredAngle));
    changed.set(joint.id, next);
  }
  if (!changed.size) return;
  commit(store, doc.joints!.map(joint => changed.get(joint.id) ?? joint), "Freeze joint rotations");
}
