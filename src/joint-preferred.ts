import { baseChannels, setKeys, type AnimationPose } from "./animation.ts";
import type { SceneDocument, Vec3 } from "./scene-document.ts";
import { createSceneStore, type SceneStore } from "./scene-store.ts";
import { validateJoints, type Joint } from "./skeleton.ts";

function angleCopy(value: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || ![0, 1, 2].every(index => Number.isFinite(value[index])))
    throw Error("A preferred angle needs three finite XYZ rotation values in degrees.");
  return [...value];
}

function requestedJoints(doc: SceneDocument, ids: readonly string[]): Joint[] {
  const joints = doc.joints ?? [];
  validateJoints(joints);
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000) throw Error("Choose between 1 and 1,000 joints.");
  if (Array.from(ids).some(id => typeof id !== "string")) throw Error("A selected joint no longer exists.");
  if (new Set(ids).size !== ids.length) throw Error("Choose each joint only once.");
  const byId = new Map(joints.map(joint => [joint.id, joint]));
  return ids.map(id => {
    const joint = byId.get(id);
    if (!joint) throw Error("A selected joint no longer exists.");
    return joint;
  });
}

/** Stable root-first preorder, independent of serialized joint-array order. */
export function preferredJointIds(doc: SceneDocument, rootId: string, includeDescendants: boolean): string[] {
  if (typeof includeDescendants !== "boolean") throw Error("Include descendants must be enabled or disabled.");
  requestedJoints(doc, [rootId]);
  if (!includeDescendants) return [rootId];
  const children = new Map<string, string[]>();
  for (const joint of doc.joints ?? []) if (joint.parentId !== null) {
    const list = children.get(joint.parentId) ?? [];
    list.push(joint.id); children.set(joint.parentId, list);
  }
  for (const list of children.values()) list.sort();
  const result: string[] = [], pending = [rootId];
  while (pending.length) {
    const id = pending.pop()!;
    result.push(id);
    const descendants = children.get(id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) pending.push(descendants[index]);
  }
  return result;
}

function commitPreferences(store: SceneStore, changes: ReadonlyMap<string, Vec3 | undefined>, label: string) {
  const doc = store.getState().document;
  let changed = false;
  const joints = (doc.joints ?? []).map(joint => {
    if (!changes.has(joint.id)) return joint;
    const preferredAngle = changes.get(joint.id);
    if (preferredAngle === undefined) {
      if (joint.preferredAngle === undefined) return joint;
      changed = true;
      const { preferredAngle: _removed, ...next } = joint;
      return next;
    }
    if (joint.preferredAngle?.every((value, index) => value === preferredAngle[index])) return joint;
    changed = true;
    return { ...joint, preferredAngle: angleCopy(preferredAngle) };
  });
  if (!changed) return;
  validateJoints(joints);
  store.setState({ document: { ...doc, joints }, editLabel: label });
}

export function setJointPreferredAngle(store: SceneStore, id: string, angle: Vec3): void {
  requestedJoints(store.getState().document, [id]);
  commitPreferences(store, new Map([[id, angleCopy(angle)]]), "Edit preferred angle");
}

/** Capture prepared FK input rotations. Without a supplied pose map, use the
 * authored joint rotations. A partial map is rejected rather than mixed. */
export function setPreferredAngles(store: SceneStore, ids: readonly string[], poses?: ReadonlyMap<string, AnimationPose>): void {
  const joints = requestedJoints(store.getState().document, ids), changes = new Map<string, Vec3>();
  for (const joint of joints) {
    const pose = poses?.get(joint.id);
    if (poses && !pose) throw Error(`The prepared FK pose for ${joint.name} is missing. Evaluate the selected joints before capturing preferred angles.`);
    changes.set(joint.id, angleCopy(pose ? pose.rotation : joint.rotation ?? [0, 0, 0]));
  }
  commitPreferences(store, changes, "Capture preferred angles");
}

export function clearPreferredAngles(store: SceneStore, ids: readonly string[]): void {
  const joints = requestedJoints(store.getState().document, ids);
  commitPreferences(store, new Map(joints.map(joint => [joint.id, undefined])), "Clear preferred angles");
}

/** Key only XYZ rotations. All requested joints need preferences; the normal
 * key validator enforces SDK ownership, frame bounds and animation budgets. */
export function keyPreferredAngles(store: SceneStore, ids: readonly string[], frame: number): void {
  const doc = store.getState().document, joints = requestedJoints(doc, ids), poses = new Map<string, AnimationPose>();
  for (const joint of joints) {
    if (joint.preferredAngle === undefined) throw Error(`Capture or enter a preferred angle for ${joint.name} before keying. Every selected joint needs a stored preference.`);
    poses.set(joint.id, { ...baseChannels(doc, joint.id), rotation: angleCopy(joint.preferredAngle) });
  }
  const staging = createSceneStore(doc);
  setKeys(staging, ids, frame, poses, ["rotation.x", "rotation.y", "rotation.z"]);
  const next = staging.getState().document;
  if (next === doc) return;
  store.setState({ document: next, editLabel: "Key preferred angles" });
}
