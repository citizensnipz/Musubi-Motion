import { Matrix4, Vector3 } from "three";
import { baseChannels, evaluateSceneAnimation, setKeys, type AnimationPose } from "./animation.ts";
import { constraintWorldMatrices } from "./constraints.ts";
import { createController } from "./controller-curves.ts";
import { evaluateDrivenKeys } from "./driven-keys.ts";
import { defaultPoleTarget, evaluateRigStages, getIKTargetPoints, ikChain, jointWorldMatrices, updateIKHandle, type IKHandle } from "./ik.ts";
import type { SceneDocument, Vec3 } from "./scene-document.ts";
import { createSceneStore, type SceneStore } from "./scene-store.ts";

export type IKControlKind = "target" | "pole";
function handleFor(doc: SceneDocument, id: string): IKHandle {
  const handle = doc.ikHandles?.find(item => item.id === id);
  if (!handle) throw Error("Select an existing IK handle.");
  return handle;
}
function validKind(kind: IKControlKind) {
  if (kind !== "target" && kind !== "pole") throw Error("Choose a target or pole control.");
}
function point(value: readonly number[]): Vec3 {
  if (value.length !== 3 || ![0, 1, 2].every(index => Number.isFinite(value[index]) && Math.abs(value[index]) <= 1e6))
    throw Error("IK control positions and offsets must be finite XYZ values within ±1,000,000.");
  return [...value] as Vec3;
}
function checkedWorld(matrix: Matrix4 | undefined): Matrix4 {
  if (!matrix || !matrix.elements.every(Number.isFinite) || !Number.isFinite(matrix.determinant()) || matrix.determinant() === 0)
    throw Error("IK controls require finite, invertible world transforms. Restore nonzero parent scales before matching.");
  return matrix;
}
function evaluated(doc: SceneDocument, frame: number, fk: boolean): Map<string, AnimationPose> {
  const poses = evaluateSceneAnimation(doc, frame); evaluateDrivenKeys(doc, poses);
  const stages = evaluateRigStages(doc, poses, fk);
  return fk ? stages.fkPoses! : poses;
}
function resolved(doc: SceneDocument, handle: IKHandle, kind: IKControlKind, poses: ReadonlyMap<string, AnimationPose>): Vec3 {
  const points = getIKTargetPoints(doc, poses).get(handle.id)!;
  const value = kind === "target" ? points.target : points.poleTarget;
  if (!value) throw Error("Choose an analytic two-bone handle before creating or linking a pole control.");
  return point(value);
}
function commitStaging(store: SceneStore, staged: SceneStore, label: string) {
  const next = staged.getState().document;
  if (JSON.stringify(next) !== JSON.stringify(store.getState().document)) store.setState({ document: next, editLabel: label });
}

/** Link a transform origin plus a world-space offset; unlink freezes its current point. */
export function setIKControl(store: SceneStore, handleId: string, kind: IKControlKind,
  objectId: string | undefined, maintainOffset: boolean, poses?: ReadonlyMap<string, AnimationPose>): void {
  validKind(kind);
  const doc = store.getState().document, handle = handleFor(doc, handleId), key = kind === "target" ? "targetControl" : "poleControl";
  if (typeof maintainOffset !== "boolean") throw Error("Maintain offset must be enabled or disabled.");
  if (objectId === undefined && !handle[key]) return;
  if (objectId !== undefined && doc.nodes[objectId]?.type !== "transform") throw Error("Choose a scene transform as the IK control.");
  const displayed = poses ?? evaluated(doc, 0, false), target = resolved(doc, handle, kind, displayed);
  if (objectId === undefined) {
    updateIKHandle(store, handleId, { [key]: undefined, [kind === "target" ? "target" : "poleTarget"]: target });
    return;
  }
  const origin = new Vector3().setFromMatrixPosition(checkedWorld(constraintWorldMatrices(doc, displayed).get(objectId)));
  const offset = maintainOffset ? point(new Vector3(...target).sub(origin).toArray()) : [0, 0, 0] as Vec3;
  const fallback = maintainOffset ? target : point(origin.toArray());
  updateIKHandle(store, handleId, { [key]: { objectId, offset }, [kind === "target" ? "target" : "poleTarget"]: fallback });
}

/** Create and link a regular editable NURBS control with one live undo record. */
export function createIKControl(store: SceneStore, handleId: string, kind: IKControlKind,
  poses?: ReadonlyMap<string, AnimationPose>): string {
  validKind(kind);
  const doc = store.getState().document, handle = handleFor(doc, handleId), displayed = poses ?? evaluated(doc, 0, false);
  const position = resolved(doc, handle, kind, displayed), staged = createSceneStore(doc);
  const id = createController(staged, kind === "target" ? "circle" : "arrow", {
    name: `${handle.name}${kind === "target" ? "Target" : "Pole"}Control`, position, size: .35, plane: "XZ",
  });
  updateIKHandle(staged, handleId, {
    [kind === "target" ? "targetControl" : "poleControl"]: { objectId: id, offset: [0, 0, 0] },
    [kind === "target" ? "target" : "poleTarget"]: position,
  });
  commitStaging(store, staged, "Create IK control");
  return id;
}

/** Match linked controls by keying their local positions, retaining offsets and FK pose. */
export function matchIKControlsToFKAndKey(store: SceneStore, handleId: string, frame: number,
  fkPoses?: ReadonlyMap<string, AnimationPose>): void {
  if (!Number.isFinite(frame) || Math.abs(frame) > 1e6) throw Error("The match frame must be finite and within ±1,000,000.");
  const doc = store.getState().document, handle = handleFor(doc, handleId), fk = fkPoses ?? evaluated(doc, frame, true);
  const originalWorlds = jointWorldMatrices(doc, fk), endWorld = checkedWorld(originalWorlds.get(handle.endId));
  const desired: { kind: IKControlKind; position: Vec3 }[] = [{ kind: "target", position: point(new Vector3().setFromMatrixPosition(endWorld).toArray()) }];
  if (handle.solver === "two-bone") desired.push({ kind: "pole", position: point(defaultPoleTarget(doc, handle.rootId, handle.endId, fk)) });
  const requests = new Map<string, Vec3>(), literal: Partial<Omit<IKHandle, "id">> = {};
  for (const { kind, position } of desired) {
    const link = kind === "target" ? handle.targetControl : handle.poleControl;
    if (!link) { literal[kind === "target" ? "target" : "poleTarget"] = position; continue; }
    const object = doc.nodes[link.objectId]; if (object?.type !== "transform") throw Error("An IK control transform no longer exists.");
    if (doc.drivenKeys?.some(relation => relation.driven.targetId === object.id && relation.driven.channel.startsWith("position.")))
      throw Error("An IK control position is owned by Set Driven Keys. Remove those position relationships before matching and keying.");
    if (doc.constraints?.some(constraint => constraint.enabled && constraint.targetId === object.id && ["point", "parent"].includes(constraint.type)))
      throw Error("An IK control position is owned by a Point or Parent constraint. Disable or remove it before matching and keying.");
    // Local channels and resolved IK points are bounded; an origin composed
    // through several parents can legitimately lie outside that local range.
    const origin = new Vector3(...position).sub(new Vector3(...link.offset)).toArray() as Vec3, existing = requests.get(object.id);
    if (existing && new Vector3(...origin).distanceTo(new Vector3(...existing)) > 1e-7)
      throw Error("The same control cannot match incompatible target and pole positions. Use separate controls or compatible offsets.");
    requests.set(object.id, origin);
  }
  const working = new Map(fk), keyed = new Map<string, AnimationPose>();
  function depth(id: string) {
    let result = 0, parent = doc.nodes[id]?.parentId; const seen = new Set<string>();
    while (parent) { if (seen.has(parent)) throw Error("An IK control has a cyclic parent hierarchy."); seen.add(parent); result++; parent = doc.nodes[parent]?.parentId; }
    return result;
  }
  // If both linked controls have an ancestor/child relationship, compute child
  // locals against the already-requested ancestor position rather than its old pose.
  for (const [id, origin] of [...requests].sort(([a], [b]) => depth(a) - depth(b))) {
    const node = doc.nodes[id]; if (node.type !== "transform") throw Error("An IK control transform no longer exists.");
    const worlds = constraintWorldMatrices(doc, working); checkedWorld(worlds.get(id));
    const parent = node.parentId ? checkedWorld(worlds.get(node.parentId)) : new Matrix4();
    const position = point(new Vector3(...origin).applyMatrix4(parent.clone().invert()).toArray());
    const pose = { ...(working.get(id) ?? baseChannels(doc, id)), position };
    keyed.set(id, pose); working.set(id, pose);
  }
  const staged = createSceneStore(doc);
  if (keyed.size) setKeys(staged, keyed.keys(), frame, keyed, ["position.x", "position.y", "position.z"]);
  if (Object.keys(literal).length) updateIKHandle(staged, handleId, literal);
  // Catch previews or driven dependencies that cannot be preserved by only
  // position keys, before either the keys or literal targets reach live history.
  const candidate = staged.getState().document, verified = evaluated(candidate, frame, true);
  const points = getIKTargetPoints(candidate, verified).get(handleId)!;
  for (const { kind, position } of desired) {
    const actual = kind === "target" ? points.target : points.poleTarget;
    if (!actual || new Vector3(...actual).distanceTo(new Vector3(...position)) > 1e-6 + new Vector3(...position).length() * 1e-10)
      throw Error("Matching would shift the IK control because of an unkeyed parent preview or driven dependency. Key the parent pose or resolve its dependencies first.");
  }
  // A control may itself drive an FK joint through SDK. Reaching the requested
  // target is insufficient if those new keys move the chain being matched.
  const verifiedWorlds = jointWorldMatrices(candidate, verified);
  for (const id of ikChain(doc, handle.rootId, handle.endId)) {
    const before = checkedWorld(originalWorlds.get(id)), after = checkedWorld(verifiedWorlds.get(id));
    if (before.elements.some((value, index) => Math.abs(value - after.elements[index]) >
      (index >= 12 && index <= 14 ? 1e-6 + Math.abs(value) * 1e-10 : 1e-7))) {
      throw Error("Matching controls would change the prepared FK chain through Set Driven Key, another dependency, or an unkeyed preview. Resolve the dependency or key the FK pose before matching.");
    }
  }
  commitStaging(store, staged, "Match IK controls to FK and key");
}
