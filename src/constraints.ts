import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import type { AnimationPose } from "./animation.ts";
import type { SceneDocument, TransformChannels, Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export type ConstraintType = "point" | "orient" | "scale" | "parent";
export type Constraint = {
  id: string;
  name: string;
  type: ConstraintType;
  sourceId: string;
  targetId: string;
  enabled: boolean;
  maintainOffset: boolean;
  offset: { position: Vec3; rotation: [number, number, number, number]; scale: Vec3 };
};
type Node = { id: string; parentId: string | null; position: Vec3; rotation?: Vec3; scale?: Vec3 };
type Plan = { nodes: Map<string, Node>; order: string[]; byTarget: Map<string, Constraint[]> };
const planCache = new WeakMap<SceneDocument, Plan>();
const constraintTypes: ConstraintType[] = ["point", "orient", "scale", "parent"];
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12;
const vector = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(finite);
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

function nodesFor(doc: SceneDocument): Map<string, Node> {
  const nodes = new Map<string, Node>(Object.values(doc.nodes).filter(node => node.type === "transform").map(node => [node.id, node]));
  for (const joint of doc.joints ?? []) {
    if (nodes.has(joint.id)) throw Error("Joint and object IDs must be distinct.");
    nodes.set(joint.id, joint);
  }
  return nodes;
}
function groups(type: ConstraintType): (keyof TransformChannels)[] {
  if (type === "parent") return ["position", "rotation"];
  return [type === "point" ? "position" : type === "orient" ? "rotation" : "scale"];
}
function buildPlan(doc: SceneDocument, constraints: Constraint[]): Plan {
  const nodes = nodesFor(doc), outgoing = new Map<string, Set<string>>(), incoming = new Map<string, number>();
  const byTarget = new Map<string, Constraint[]>();
  for (const id of nodes.keys()) { outgoing.set(id, new Set()); incoming.set(id, 0); }
  function edge(from: string, to: string) {
    if (!nodes.has(from) || !nodes.has(to)) throw Error("A constraint or hierarchy target is missing.");
    if (outgoing.get(from)!.has(to)) return;
    outgoing.get(from)!.add(to); incoming.set(to, incoming.get(to)! + 1);
  }
  for (const node of nodes.values()) if (node.parentId) edge(node.parentId, node.id);
  // Include disabled constraints so enabling one never introduces latent cycles.
  for (const constraint of constraints) {
    edge(constraint.sourceId, constraint.targetId);
    const list = byTarget.get(constraint.targetId) ?? [];
    list.push(constraint); byTarget.set(constraint.targetId, list);
  }
  const order = [...nodes.keys()].filter(id => incoming.get(id) === 0).sort();
  for (let index = 0; index < order.length; index++) {
    for (const dependent of outgoing.get(order[index])!) {
      incoming.set(dependent, incoming.get(dependent)! - 1);
      if (incoming.get(dependent) === 0) order.push(dependent);
    }
  }
  if (order.length !== nodes.size) throw Error("Constraints and hierarchy cannot contain a dependency cycle.");
  for (const list of byTarget.values()) list.sort((a, b) => constraintTypes.indexOf(a.type) - constraintTypes.indexOf(b.type));
  return { nodes, order, byTarget };
}

export function validateConstraints(value: unknown, doc: SceneDocument): asserts value is Constraint[] {
  if (!Array.isArray(value) || value.length > 10000) throw Error("Invalid constraints.");
  const ids = new Set<string>(), owners = new Set<string>(), nodes = nodesFor(doc);
  for (const constraint of value as Constraint[]) {
    if (!constraint || typeof constraint !== "object" || !validId(constraint.id) || ids.has(constraint.id)
      || typeof constraint.name !== "string" || !constraint.name.trim() || constraint.name.length > 100
      || !constraintTypes.includes(constraint.type) || !validId(constraint.sourceId) || !validId(constraint.targetId)
      || constraint.sourceId === constraint.targetId || !nodes.has(constraint.sourceId) || !nodes.has(constraint.targetId)
      || typeof constraint.enabled !== "boolean" || typeof constraint.maintainOffset !== "boolean") throw Error("Invalid constraint or missing target.");
    if (constraint.type === "scale" && doc.joints?.some(joint => joint.id === constraint.targetId)) throw Error("Joint scale constraints are not supported.");
    const offset = constraint.offset;
    if (!offset || typeof offset !== "object" || !vector(offset.position) || !vector(offset.scale) || offset.scale.some(n => n <= 0)
      || !Array.isArray(offset.rotation) || offset.rotation.length !== 4 || !offset.rotation.every(finite)
      || Math.abs(offset.rotation.reduce((sum, value) => sum + value * value, 0) - 1) > 1e-6) throw Error("Invalid constraint offset.");
    for (const group of groups(constraint.type)) {
      const output = `${constraint.targetId}:${group}`;
      if (owners.has(output)) throw Error("Only one constraint can drive each position, rotation or scale group.");
      owners.add(output);
    }
    ids.add(constraint.id);
  }
  buildPlan(doc, value);
}

function poseFor(node: Node, poses?: ReadonlyMap<string, AnimationPose>): AnimationPose {
  const pose = poses?.get(node.id);
  return pose ?? { position: [...node.position], rotation: [...node.rotation ?? [0, 0, 0]], scale: [...node.scale ?? [1, 1, 1]], visibility: 1 };
}
function localMatrix(pose: AnimationPose): Matrix4 {
  return new Matrix4().compose(new Vector3(...pose.position),
    new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3, "XYZ")), new Vector3(...pose.scale));
}
function decompose(matrix: Matrix4) {
  const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
  matrix.decompose(position, rotation, scale); rotation.normalize();
  return { position, rotation, scale };
}
function getPlan(doc: SceneDocument): Plan {
  let plan = planCache.get(doc);
  if (!plan) { plan = buildPlan(doc, doc.constraints ?? []); planCache.set(doc, plan); }
  return plan;
}
export function constraintWorldMatrices(doc: SceneDocument, poses?: ReadonlyMap<string, AnimationPose>): Map<string, Matrix4> {
  const plan = getPlan(doc), world = new Map<string, Matrix4>();
  for (const id of plan.order) {
    const node = plan.nodes.get(id)!, matrix = localMatrix(poseFor(node, poses));
    if (node.parentId) matrix.premultiply(world.get(node.parentId)!);
    world.set(id, matrix);
  }
  return world;
}

/** Final pose stage after time animation, SDK and IK. Constraints override their
 * output groups; SDK/IK are not re-evaluated from these results (no feedback). */
export function evaluateConstraints(doc: SceneDocument, poses: Map<string, AnimationPose>): void {
  if (!doc.constraints?.some(constraint => constraint.enabled)) return;
  const plan = getPlan(doc), world = new Map<string, Matrix4>();
  for (const id of plan.order) {
    const node = plan.nodes.get(id)!, parent = node.parentId ? world.get(node.parentId)! : new Matrix4();
    let pose = poseFor(node, poses);
    const constraints = plan.byTarget.get(id)?.filter(constraint => constraint.enabled) ?? [];
    if (constraints.length) {
      const parentInverse = parent.clone().invert(), parentComponents = decompose(parent);
      for (const constraint of constraints) {
        const source = world.get(constraint.sourceId)!, sourceComponents = decompose(source), offset = constraint.offset;
        pose = { ...pose, position: [...pose.position], rotation: [...pose.rotation], scale: [...pose.scale] };
        if (constraint.type === "point" || constraint.type === "parent") {
          const desired = constraint.type === "parent" ? new Vector3(...offset.position).applyMatrix4(source)
            : sourceComponents.position.add(new Vector3(...offset.position));
          pose.position = desired.applyMatrix4(parentInverse).toArray() as Vec3;
        }
        if (constraint.type === "orient" || constraint.type === "parent") {
          const desired = sourceComponents.rotation.multiply(new Quaternion(...offset.rotation));
          const local = parentComponents.rotation.clone().invert().multiply(desired).normalize();
          const rotation = new Euler().setFromQuaternion(local, "XYZ");
          pose.rotation = [rotation.x, rotation.y, rotation.z].map(MathUtils.radToDeg) as Vec3;
        }
        if (constraint.type === "scale") {
          const desired = sourceComponents.scale.multiply(new Vector3(...offset.scale)).divide(parentComponents.scale);
          pose.scale = desired.toArray().map(value => Math.max(0.001, value)) as Vec3;
        }
      }
      poses.set(id, pose);
    }
    world.set(id, localMatrix(pose).premultiply(parent));
  }
}

function saveConstraints(store: SceneStore, constraints: Constraint[], editLabel: string) {
  const doc = store.getState().document;
  validateConstraints(constraints, doc);
  if (JSON.stringify(doc.constraints ?? []) === JSON.stringify(constraints)) return;
  store.setState({ document: { ...doc, constraints }, editLabel });
}
export function createConstraint(store: SceneStore, type: ConstraintType, sourceId: string, targetId: string, maintainOffset = true, poses?: ReadonlyMap<string, AnimationPose>): string {
  const doc = store.getState().document, matrices = constraintWorldMatrices(doc, poses);
  if (!matrices.has(sourceId) || !matrices.has(targetId)) throw Error("Choose a source and driven object or joint.");
  const source = matrices.get(sourceId)!, sourceComponents = decompose(source), targetComponents = decompose(matrices.get(targetId)!);
  const offset: Constraint["offset"] = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  if (maintainOffset) {
    if (type === "point") offset.position = targetComponents.position.clone().sub(sourceComponents.position).toArray() as Vec3;
    if (type === "parent") offset.position = targetComponents.position.clone().applyMatrix4(source.clone().invert()).toArray() as Vec3;
    if (type === "orient" || type === "parent") offset.rotation = sourceComponents.rotation.clone().invert().multiply(targetComponents.rotation).normalize().toArray();
    if (type === "scale") offset.scale = targetComponents.scale.clone().divide(sourceComponents.scale).toArray() as Vec3;
  }
  const id = crypto.randomUUID();
  const targetName = doc.nodes[targetId]?.name ?? doc.joints?.find(joint => joint.id === targetId)?.name ?? targetId;
  const name = `${targetName}_${type}`.slice(0, 100);
  const constraint: Constraint = { id, name, type, sourceId, targetId, enabled: true, maintainOffset, offset };
  saveConstraints(store, [...doc.constraints ?? [], constraint], `Create ${type} constraint`);
  return id;
}
export function updateConstraint(store: SceneStore, id: string, patch: { enabled?: boolean; name?: string }) {
  const constraints = store.getState().document.constraints ?? [];
  if (!constraints.some(constraint => constraint.id === id)) throw Error("Constraint does not exist.");
  // Offsets, ownership and endpoints are immutable after creation.
  const changes: typeof patch = {};
  if (patch.enabled !== undefined) changes.enabled = patch.enabled;
  if (patch.name !== undefined) changes.name = patch.name;
  saveConstraints(store, constraints.map(constraint => constraint.id === id ? { ...constraint, ...changes } : constraint), "Edit constraint");
}
export function deleteConstraint(store: SceneStore, id: string) {
  saveConstraints(store, (store.getState().document.constraints ?? []).filter(constraint => constraint.id !== id), "Delete constraint");
}
