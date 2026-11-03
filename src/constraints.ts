import { Matrix4, Quaternion, Vector3 } from "three";
import type { AnimationPose } from "./animation.ts";
import type { SceneDocument, TransformChannels, Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import { validateIKControlDependencies } from "./ik-control-plan.ts";
import { jointLocalQuaternion, jointRotationFromQuaternion } from "./joint-transform.ts";
import { objectGeometryPosition, objectLocalMatrix, objectPivotPosition } from "./object-pivot.ts";

export type ConstraintType = "point" | "orient" | "scale" | "parent" | "aim";
export type SignedAxis = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
export type AimOptions = { aimAxis?: SignedAxis; worldUpAxis?: SignedAxis };
export type Constraint = {
  id: string;
  name: string;
  type: ConstraintType;
  sourceId: string;
  targetId: string;
  enabled: boolean;
  maintainOffset: boolean;
  aimAxis?: SignedAxis;
  worldUpAxis?: SignedAxis;
  offset: { position: Vec3; rotation: [number, number, number, number]; scale: Vec3 };
};
type Node = { id: string; type?: string; parentId: string | null; position: Vec3; rotation?: Vec3; scale?: Vec3; orientation?: Vec3; pivot?: Vec3; pivotCompensation?: Vec3; affine?: number[] };
type Plan = { nodes: Map<string, Node>; order: string[]; byTarget: Map<string, Constraint[]> };
const planCache = new WeakMap<SceneDocument, Plan>();
const constraintTypes: ConstraintType[] = ["point", "orient", "aim", "scale", "parent"];
const signedAxes: SignedAxis[] = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12;
const vector = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(finite);
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

function nodesFor(doc: SceneDocument): Map<string, Node> {
  const nodes = new Map<string, Node>(Object.values(doc.nodes).filter(node => node.type === "transform").map(node => [node.id, node]));
  for (const joint of doc.joints ?? []) {
    if (Object.hasOwn(doc.nodes, joint.id) || nodes.has(joint.id)) throw Error("Joint and object IDs must be distinct.");
    nodes.set(joint.id, joint);
  }
  return nodes;
}
function groups(type: ConstraintType): (keyof TransformChannels)[] {
  if (type === "parent") return ["position", "rotation"];
  return [type === "point" ? "position" : type === "orient" || type === "aim" ? "rotation" : "scale"];
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
    const target = doc.nodes[constraint?.targetId];
    if (target?.type === "transform" && target.affine && constraint.type !== "point") throw Error("Orientation and scale constraints on objects with affine world scaling are not supported. Remove the constraint before world-axis scaling.");
    if (!constraint || typeof constraint !== "object" || !validId(constraint.id) || ids.has(constraint.id)
      || typeof constraint.name !== "string" || !constraint.name.trim() || constraint.name.length > 100
      || !constraintTypes.includes(constraint.type) || !validId(constraint.sourceId) || !validId(constraint.targetId)
      || constraint.sourceId === constraint.targetId || !nodes.has(constraint.sourceId) || !nodes.has(constraint.targetId)
      || typeof constraint.enabled !== "boolean" || typeof constraint.maintainOffset !== "boolean") throw Error("Invalid constraint or missing target.");
    if (constraint.type === "scale" && doc.joints?.some(joint => joint.id === constraint.targetId)) throw Error("Joint scale constraints are not supported.");
    validateAimOptions(constraint);
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
  const plan = buildPlan(doc, value), world = worldMatricesForPlan(plan);
  for (const constraint of value as Constraint[]) if (constraint.enabled) {
    const parentId = plan.nodes.get(constraint.targetId)!.parentId;
    checkConstraintPose(constraint, world.get(constraint.sourceId)!, parentId ? world.get(parentId)! : new Matrix4());
  }
  validateIKControlDependencies(doc.constraints === value ? doc : { ...doc, constraints: value });
}

function poseFor(node: Node, poses?: ReadonlyMap<string, AnimationPose>): AnimationPose {
  const pose = poses?.get(node.id);
  return pose ?? { position: [...node.position], rotation: [...node.rotation ?? [0, 0, 0]], scale: [...node.scale ?? [1, 1, 1]], visibility: 1 };
}
function localMatrix(node: Node, pose: AnimationPose): Matrix4 {
  if (node.type === "transform") return objectLocalMatrix(node, pose);
  return new Matrix4().compose(new Vector3(...pose.position),
    jointLocalQuaternion(node, pose.rotation), new Vector3(...pose.scale));
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
function worldMatricesForPlan(plan: Plan, poses?: ReadonlyMap<string, AnimationPose>): Map<string, Matrix4> {
  const world = new Map<string, Matrix4>();
  for (const id of plan.order) {
    const node = plan.nodes.get(id)!, matrix = localMatrix(node, poseFor(node, poses));
    if (node.parentId) matrix.premultiply(world.get(node.parentId)!);
    world.set(id, matrix);
  }
  return world;
}
export function constraintWorldMatrices(doc: SceneDocument, poses?: ReadonlyMap<string, AnimationPose>): Map<string, Matrix4> {
  return worldMatricesForPlan(getPlan(doc), poses);
}

const AFFINE_TOLERANCE = 1e-6;
function basis(matrix: Matrix4) {
  const x = new Vector3().setFromMatrixColumn(matrix, 0), y = new Vector3().setFromMatrixColumn(matrix, 1), z = new Vector3().setFromMatrixColumn(matrix, 2);
  const lengths = [x.length(), y.length(), z.length()];
  x.normalize(); y.normalize(); z.normalize();
  return { lengths, orthogonal: Math.max(Math.abs(x.dot(y)), Math.abs(x.dot(z)), Math.abs(y.dot(z))) <= AFFINE_TOLERANCE };
}
function checkConstraintPose(constraint: Pick<Constraint, "type" | "name">, source: Matrix4, parent: Matrix4) {
  const prefix = `Unsupported pose for ${constraint.name}: `;
  const parentDeterminant = parent.determinant();
  if (!source.elements.every(Number.isFinite) || !parent.elements.every(Number.isFinite) || !Number.isFinite(parentDeterminant) || parentDeterminant === 0) {
    throw Error(`${prefix}the source or driven parent has a non-finite or singular transform. Restore finite, nonzero scales.`);
  }
  if (constraint.type === "point") return;
  const parentBasis = basis(parent), largest = Math.max(...parentBasis.lengths), smallest = Math.min(...parentBasis.lengths);
  if (!parentBasis.orthogonal || largest - smallest > largest * AFFINE_TOLERANCE) {
    throw Error(`${prefix}${constraint.type} constraints require a uniformly scaled driven parent. Set its ancestor scales to equal X, Y and Z values, or use a point constraint.`);
  }
  // Aim consumes only the source origin; source shear does not affect it.
  if (constraint.type === "aim") return;
  const sourceBasis = basis(source);
  if (!sourceBasis.orthogonal || sourceBasis.lengths.some(length => !Number.isFinite(length) || length === 0)) {
    throw Error(`${prefix}the source contains shear. Use uniform ancestor scales or remove the rotated nonuniform scaling.`);
  }
}

function validateAimOptions(options: AimOptions) {
  if ((options.aimAxis !== undefined && !signedAxes.includes(options.aimAxis)) || (options.worldUpAxis !== undefined && !signedAxes.includes(options.worldUpAxis))) {
    throw Error("Aim and world-up axes must be +X, -X, +Y, -Y, +Z or -Z.");
  }
}
function axisVector(axis: SignedAxis): Vector3 {
  const vector = new Vector3(); vector.setComponent("XYZ".indexOf(axis[1]), axis[0] === "+" ? 1 : -1); return vector;
}
function aimRotation(constraint: AimOptions & { name: string }, source: Vector3, target: Vector3): Quaternion {
  const distanceSquared = source.distanceToSquared(target);
  if (!Number.isFinite(distanceSquared)) throw Error(`Unsupported pose for ${constraint.name}: aim positions must be finite and within a representable distance.`);
  if (distanceSquared <= 1e-16) throw Error(`Unsupported pose for ${constraint.name}: the look-at source and driven object coincide. Separate their positions or disable the aim constraint.`);
  const axis = constraint.aimAxis ?? "+Z", worldUp = axisVector(constraint.worldUpAxis ?? "+Y");
  // Three's lookAt builds a +Z-facing frame. Convert the selected local aim
  // axis into that frame, keeping +Y local up (+Z when aiming along ±Y).
  // Its built-in deterministic perturbation handles an up/aim parallel pole;
  // this is not a history-dependent roll-continuity or object-up solver.
  const localUp = axis[1] === "Y" ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const localFrame = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(axisVector(axis), new Vector3(), localUp));
  const worldFrame = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(source, target, worldUp));
  return worldFrame.multiply(localFrame.invert()).normalize();
}

/** Evaluate selected constraints atomically. Unselected nodes still contribute
 * their supplied local poses to world matrices. The default evaluates all
 * constraints; linked IK controls use complementary early and final subsets. */
export function evaluateConstraints(doc: SceneDocument, poses: Map<string, AnimationPose>, options: {
  includeTargets?: ReadonlySet<string>;
  excludeTargets?: ReadonlySet<string>;
} = {}): void {
  const selected = (id: string) => (!options.includeTargets || options.includeTargets.has(id)) && !options.excludeTargets?.has(id);
  if (!doc.constraints?.some(constraint => constraint.enabled && selected(constraint.targetId))) return;
  const plan = getPlan(doc), world = new Map<string, Matrix4>(), updates = new Map<string, AnimationPose>();
  for (const id of plan.order) {
    const node = plan.nodes.get(id)!, parent = node.parentId ? world.get(node.parentId)! : new Matrix4();
    let pose = poseFor(node, poses);
    const constraints = selected(id) ? plan.byTarget.get(id)?.filter(constraint => constraint.enabled) ?? [] : [];
    if (constraints.length) {
      const parentInverse = parent.clone().invert(), parentComponents = decompose(parent);
      let desiredGeometryPosition: Vector3 | undefined;
      for (const constraint of constraints) {
        const source = world.get(constraint.sourceId)!;
        checkConstraintPose(constraint, source, parent);
        const sourceComponents = decompose(source), offset = constraint.offset;
        pose = { ...pose, position: [...pose.position], rotation: [...pose.rotation], scale: [...pose.scale] };
        if (constraint.type === "point" || constraint.type === "parent") {
          const desired = constraint.type === "parent" ? new Vector3(...offset.position).applyMatrix4(source)
            : sourceComponents.position.add(new Vector3(...offset.position));
          desiredGeometryPosition = desired.applyMatrix4(parentInverse);
          const shift = node.type === "transform" ? objectGeometryPosition(node, { ...pose, position: [0, 0, 0] }) : new Vector3();
          pose.position = desiredGeometryPosition.clone().sub(shift).toArray() as Vec3;
        }
        if (constraint.type === "orient" || constraint.type === "parent" || constraint.type === "aim") {
          const desired = (constraint.type === "aim"
            ? aimRotation(constraint, sourceComponents.position, (desiredGeometryPosition?.clone() ?? objectPivotPosition(node, pose)).applyMatrix4(parent))
            : sourceComponents.rotation).multiply(new Quaternion(...offset.rotation));
          const local = parentComponents.rotation.clone().invert().multiply(desired).normalize();
          pose.rotation = jointRotationFromQuaternion(node, local);
        }
        if (constraint.type === "scale") {
          const desired = sourceComponents.scale.multiply(new Vector3(...offset.scale)).divide(parentComponents.scale);
          pose.scale = desired.toArray().map(value => Math.max(0.001, value)) as Vec3;
        }
      }
      // Rotation/scale constraints alter the pivot shift after a point or parent
      // constraint has established the driven geometry's desired origin.
      if (desiredGeometryPosition && node.type === "transform") {
        const shift = objectGeometryPosition(node, { ...pose, position: [0, 0, 0] });
        pose.position = desiredGeometryPosition.sub(shift).toArray() as Vec3;
      }
      updates.set(id, pose);
    }
    world.set(id, localMatrix(node, pose).premultiply(parent));
  }
  // Failed evaluation must not expose a half-constrained scene to the host.
  for (const [id, pose] of updates) poses.set(id, pose);
}

function saveConstraints(store: SceneStore, constraints: Constraint[], editLabel: string) {
  const doc = store.getState().document;
  const next = { ...doc, constraints };
  validateConstraints(constraints, next);
  if (JSON.stringify(doc.constraints ?? []) === JSON.stringify(constraints)) return;
  store.setState({ document: next, editLabel });
}
export function createConstraint(store: SceneStore, type: ConstraintType, sourceId: string, targetId: string, maintainOffset = true, poses?: ReadonlyMap<string, AnimationPose>, aimOptions: AimOptions = {}): string {
  validateAimOptions(aimOptions);
  const doc = store.getState().document, matrices = constraintWorldMatrices(doc, poses);
  if (!matrices.has(sourceId) || !matrices.has(targetId)) throw Error("Choose a source and driven object or joint.");
  const source = matrices.get(sourceId)!, targetParentId = nodesFor(doc).get(targetId)!.parentId;
  checkConstraintPose({ type, name: `${type} constraint` }, source, targetParentId ? matrices.get(targetParentId)! : new Matrix4());
  const sourceComponents = decompose(source), targetComponents = decompose(matrices.get(targetId)!);
  const aimSettings: AimOptions = type === "aim" ? { aimAxis: aimOptions.aimAxis ?? "+Z", worldUpAxis: aimOptions.worldUpAxis ?? "+Y" } : {};
  const targetNode = nodesFor(doc).get(targetId)!;
  const targetPivot = new Vector3(...targetNode.pivot ?? [0, 0, 0]).applyMatrix4(matrices.get(targetId)!);
  const initialAim = type === "aim" ? aimRotation({ ...aimSettings, name: "aim constraint" }, sourceComponents.position, targetPivot) : undefined;
  const offset: Constraint["offset"] = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  if (maintainOffset) {
    if (type === "point") offset.position = targetComponents.position.clone().sub(sourceComponents.position).toArray() as Vec3;
    if (type === "parent") offset.position = targetComponents.position.clone().applyMatrix4(source.clone().invert()).toArray() as Vec3;
    if (type === "orient" || type === "parent") offset.rotation = sourceComponents.rotation.clone().invert().multiply(targetComponents.rotation).normalize().toArray();
    if (initialAim) offset.rotation = initialAim.clone().invert().multiply(targetComponents.rotation).normalize().toArray();
    if (type === "scale") offset.scale = targetComponents.scale.clone().divide(sourceComponents.scale).toArray() as Vec3;
  }
  const id = crypto.randomUUID();
  const targetName = doc.nodes[targetId]?.name ?? doc.joints?.find(joint => joint.id === targetId)?.name ?? targetId;
  const name = `${targetName}_${type}`.slice(0, 100);
  const constraint: Constraint = { id, name, type, sourceId, targetId, enabled: true, maintainOffset, offset, ...aimSettings };
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
