import { Bone, BufferGeometry, Euler, MathUtils, Matrix4, MeshBasicMaterial, Quaternion, Skeleton, SkinnedMesh, Vector3 } from "three";
import { CCDIKSolver, type IK } from "three/addons/animation/CCDIKSolver.js";
import { baseChannels, type AnimationPose } from "./animation.ts";
import type { SceneDocument, Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import type { Joint } from "./skeleton.ts";

export type IKHandle = {
  id: string;
  name: string;
  rootId: string;
  endId: string;
  /** A world-space target in scene units. */
  target: Vec3;
  enabled: boolean;
  iterations: number;
  /** Zero retains FK; one applies the full solution. */
  blend: number;
};

const vector = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e6);
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

/** Ordered root to effector, including both endpoints. */
export function ikChain(doc: SceneDocument, rootId: string, endId: string): string[] {
  const joints = new Map((doc.joints ?? []).map(joint => [joint.id, joint]));
  if (rootId === endId || !joints.has(rootId) || !joints.has(endId)) throw Error("Choose different root and end joints.");
  const path: string[] = [], visited = new Set<string>();
  let current: string | null = endId;
  while (current) {
    if (visited.has(current) || path.length > 64) throw Error("Invalid or oversized IK chain.");
    visited.add(current); path.push(current);
    if (current === rootId) return path.reverse();
    current = joints.get(current)?.parentId ?? null;
  }
  throw Error("The end joint must be a descendant of the root joint.");
}

export function validateIKHandles(value: unknown, doc: SceneDocument): asserts value is IKHandle[] {
  if (!Array.isArray(value) || value.length > 128) throw Error("Invalid IK handles.");
  const ids = new Set<string>(), occupied = new Map<string, string>();
  const joints = new Map((doc.joints ?? []).map(joint => [joint.id, joint]));
  for (const handle of value as IKHandle[]) {
    if (!handle || typeof handle !== "object" || !validId(handle.id) || ids.has(handle.id) || typeof handle.name !== "string" || !handle.name.trim() || handle.name.length > 100
      || !validId(handle.rootId) || !validId(handle.endId) || !vector(handle.target) || typeof handle.enabled !== "boolean"
      || !Number.isInteger(handle.iterations) || handle.iterations < 1 || handle.iterations > 128
      || typeof handle.blend !== "number" || !Number.isFinite(handle.blend) || handle.blend < 0 || handle.blend > 1) throw Error("Invalid IK handle settings.");
    const chain = ikChain(doc, handle.rootId, handle.endId);
    for (let index = 0; index < chain.length; index++) {
      const id = chain[index];
      if (occupied.has(id)) throw Error("IK chains cannot share joints. Remove the overlapping handle first.");
      if (index > 0 && new Vector3(...joints.get(id)!.position).lengthSq() < 1e-12) throw Error("IK requires nonzero bone lengths.");
      occupied.set(id, handle.id);
    }
    ids.add(handle.id);
  }
  // A solver on an ancestor can move a second chain even when their explicit
  // paths do not intersect. Reject that order-dependent configuration too.
  for (const handle of value as IKHandle[]) {
    const visited = new Set<string>();
    let parent = joints.get(handle.rootId)?.parentId;
    while (parent) {
      if (visited.has(parent)) throw Error("Invalid joint hierarchy.");
      visited.add(parent);
      if (occupied.has(parent) && occupied.get(parent) !== handle.id) throw Error("IK chains cannot control ancestors of another chain.");
      parent = joints.get(parent)?.parentId;
    }
  }
}

type Rig = { mesh: SkinnedMesh; bones: Map<string, Bone>; indices: Map<string, number>; target: Bone };
const rigs = new WeakMap<Joint[], Rig>();
function rigFor(doc: SceneDocument): Rig {
  const joints = doc.joints ?? [];
  let rig = rigs.get(joints);
  if (rig) return rig;
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  const bones = new Map<string, Bone>(), indices = new Map<string, number>();
  for (const joint of joints) {
    const bone = new Bone(); bone.name = joint.name;
    indices.set(joint.id, bones.size); bones.set(joint.id, bone);
  }
  for (const joint of joints) {
    const parent = joint.parentId ? bones.get(joint.parentId) : mesh;
    if (!parent) throw Error("Missing joint parent.");
    parent.add(bones.get(joint.id)!);
  }
  const target = new Bone(); target.name = "IK target"; mesh.add(target);
  mesh.skeleton = new Skeleton([...bones.values(), target]);
  rig = { mesh, bones, indices, target }; rigs.set(joints, rig);
  return rig;
}

function resetRig(doc: SceneDocument, poses?: ReadonlyMap<string, AnimationPose>): Rig {
  const rig = rigFor(doc);
  for (const joint of doc.joints ?? []) {
    const pose = poses?.get(joint.id), bone = rig.bones.get(joint.id)!;
    bone.position.fromArray(pose?.position ?? joint.position);
    const rotation = pose?.rotation ?? joint.rotation ?? [0, 0, 0];
    bone.rotation.set(...rotation.map(MathUtils.degToRad) as Vec3, "XYZ");
    bone.scale.set(1, 1, 1);
  }
  rig.mesh.updateMatrixWorld(true);
  return rig;
}

/** Fresh world matrices, suitable for FK matching and viewport target placement. */
export function jointWorldMatrices(doc: SceneDocument, poses?: ReadonlyMap<string, AnimationPose>): Map<string, Matrix4> {
  const rig = resetRig(doc, poses);
  return new Map([...rig.bones].map(([id, bone]) => [id, bone.matrixWorld.clone()]));
}

/** Evaluate after animation/driven keys, before skinning. No scene edits/history. */
export function evaluateIK(doc: SceneDocument, poses: Map<string, AnimationPose>): void {
  const handles = doc.ikHandles?.filter(handle => handle.enabled && handle.blend > 0) ?? [];
  if (!handles.length) return;
  const rig = resetRig(doc, poses);
  const targetPosition = new Vector3(), rootPosition = new Vector3(), endPosition = new Vector3(), localAxis = new Vector3();
  const axis = new Vector3(), direction = new Vector3(), delta = new Quaternion(), worldRotation = new Quaternion();
  for (const handle of handles) {
    const chain = ikChain(doc, handle.rootId, handle.endId);
    // Animation can collapse a segment even though the authored rest pose is valid.
    if (chain.slice(1).some(id => rig.bones.get(id)!.position.lengthSq() < 1e-12)) continue;
    const links = chain.slice(0, -1).reverse(), end = rig.bones.get(handle.endId)!;
    const originals = new Map(links.map(id => [id, rig.bones.get(id)!.quaternion.clone()]));
    targetPosition.fromArray(handle.target);
    rig.target.position.copy(targetPosition); rig.target.updateMatrixWorld(true);
    rootPosition.setFromMatrixPosition(rig.bones.get(handle.rootId)!.matrixWorld);
    endPosition.setFromMatrixPosition(end.matrixWorld);
    // CCD has no bend direction at a collinear singularity. A small, fixed
    // perpendicular seed makes straight/reversed chains deterministic. It is
    // discarded if solving fails, and blend zero always preserves exact FK.
    const rootToEnd = endPosition.clone().sub(rootPosition), rootToTarget = targetPosition.clone().sub(rootPosition);
    if (endPosition.distanceToSquared(targetPosition) > 1e-12 && new Vector3().crossVectors(rootToEnd, rootToTarget).lengthSq() < 1e-12) {
      direction.copy(rootToEnd).normalize();
      if (direction.lengthSq() < 1e-12) direction.set(0, 1, 0);
      axis.crossVectors(direction, Math.abs(direction.x) < 0.8 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
      for (let index = 0; index < links.length; index++) {
        const bone = rig.bones.get(links[index])!;
        bone.getWorldQuaternion(worldRotation).invert();
        localAxis.copy(axis).applyQuaternion(worldRotation);
        bone.quaternion.multiply(delta.setFromAxisAngle(localAxis, 0.02 * (index + 1))).normalize();
        bone.updateMatrixWorld(true);
      }
    }
    const ik: IK = { target: rig.bones.size, effector: rig.indices.get(handle.endId)!,
      links: links.map(id => ({ index: rig.indices.get(id)! })), iteration: 1, maxAngle: Math.PI / 3 };
    const solver = new CCDIKSolver(rig.mesh, [ik]);
    for (let iteration = 0; iteration < handle.iterations; iteration++) {
      // At an exact target/link coincidence its direction is undefined. Stop
      // there while still allowing the descendant links to fold toward it.
      for (let index = 0; index < links.length; index++) {
        rootPosition.setFromMatrixPosition(rig.bones.get(links[index])!.matrixWorld);
        ik.links[index].enabled = rootPosition.distanceToSquared(targetPosition) > 1e-16;
      }
      solver.update();
      for (const id of links) rig.bones.get(id)!.quaternion.normalize();
      rig.mesh.updateMatrixWorld(true);
      endPosition.setFromMatrixPosition(end.matrixWorld);
      if (endPosition.distanceToSquared(targetPosition) < 1e-10) break;
    }
    for (const id of links) {
      const bone = rig.bones.get(id)!, original = originals.get(id)!;
      if (!bone.quaternion.toArray().every(Number.isFinite)) bone.quaternion.copy(original);
      if (handle.blend < 1) bone.quaternion.copy(original.clone().slerp(bone.quaternion, handle.blend));
      const rotation = new Euler().setFromQuaternion(bone.quaternion, "XYZ");
      const pose = poses.get(id) ?? baseChannels(doc, id);
      poses.set(id, { ...pose, rotation: [rotation.x, rotation.y, rotation.z].map(MathUtils.radToDeg) as Vec3 });
    }
    rig.mesh.updateMatrixWorld(true);
  }
}

function saveHandles(store: SceneStore, handles: IKHandle[], editLabel: string) {
  const doc = store.getState().document;
  validateIKHandles(handles, doc);
  if (JSON.stringify(doc.ikHandles ?? []) === JSON.stringify(handles)) return;
  store.setState({ document: { ...doc, ikHandles: handles }, editLabel });
}
export function createIKHandle(store: SceneStore, rootId: string, endId: string, target?: Vec3): string {
  const doc = store.getState().document;
  ikChain(doc, rootId, endId);
  const endpoint = new Vector3().setFromMatrixPosition(jointWorldMatrices(doc).get(endId)!);
  const id = crypto.randomUUID();
  const handle: IKHandle = { id, name: `ikHandle${(doc.ikHandles?.length ?? 0) + 1}`, rootId, endId,
    target: target ? [...target] : endpoint.toArray() as Vec3, enabled: true, iterations: 64, blend: 1 };
  saveHandles(store, [...doc.ikHandles ?? [], handle], "Create IK handle");
  return id;
}
export function updateIKHandle(store: SceneStore, id: string, patch: Partial<Omit<IKHandle, "id">>) {
  const handles = store.getState().document.ikHandles ?? [];
  if (!handles.some(handle => handle.id === id)) throw Error("IK handle does not exist.");
  saveHandles(store, handles.map(handle => handle.id === id ? { ...handle, ...structuredClone(patch), id } : handle), "Edit IK handle");
}
export function deleteIKHandle(store: SceneStore, id: string) {
  saveHandles(store, (store.getState().document.ikHandles ?? []).filter(handle => handle.id !== id), "Delete IK handle");
}
export function matchIKToFK(store: SceneStore, id: string, poses?: ReadonlyMap<string, AnimationPose>) {
  const doc = store.getState().document, handle = doc.ikHandles?.find(handle => handle.id === id);
  if (!handle) throw Error("IK handle does not exist.");
  const target = new Vector3().setFromMatrixPosition(jointWorldMatrices(doc, poses).get(handle.endId)!).toArray() as Vec3;
  updateIKHandle(store, id, { target });
}
