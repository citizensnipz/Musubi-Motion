import {
  ANIMATION_CHANNELS, evaluateCurve, readChannel, validateCurveKeys, writeChannel,
  type AnimationChannel, type CurveKey,
} from "./animation.ts";
import type { SceneDocument, TransformChannels } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export type DrivenProperty = { targetId: string; channel: AnimationChannel };
export type DrivenKeyRelationship = {
  id: string;
  driver: DrivenProperty;
  driven: DrivenProperty;
  /** The curve's horizontal axis is the driver value, not scene time. */
  keys: CurveKey[];
};
export type EvaluatedPose = TransformChannels & { visibility: number };

const propertyKey = (property: DrivenProperty) => JSON.stringify([property.targetId, property.channel]);
const sameProperty = (a: DrivenProperty, b: DrivenProperty) => a.targetId === b.targetId && a.channel === b.channel;
const orderedCache = new WeakMap<DrivenKeyRelationship[], DrivenKeyRelationship[]>();

function validateProperty(value: unknown, doc: SceneDocument): asserts value is DrivenProperty {
  if (!value || typeof value !== "object") throw Error("Invalid driven-key property.");
  const property = value as DrivenProperty;
  if (typeof property.targetId !== "string" || !ANIMATION_CHANNELS.includes(property.channel))
    throw Error("Invalid driven-key property.");
  const node = doc.nodes[property.targetId];
  const joint = doc.joints?.find(j => j.id === property.targetId);
  if (node?.type !== "transform" && !joint) throw Error("Driven-key target does not exist.");
  if (joint && property.channel.startsWith("scale.")) throw Error("Joint scale is not supported.");
}

function evaluationOrder(relationships: DrivenKeyRelationship[]): DrivenKeyRelationship[] {
  const cached = orderedCache.get(relationships);
  if (cached) return cached;
  const owners = new Map(relationships.map(relation => [propertyKey(relation.driven), relation]));
  const pending = new Map(relationships.map(relation => [relation.id, 0]));
  const dependents = new Map<string, DrivenKeyRelationship[]>();
  for (const relation of relationships) {
    const owner = owners.get(propertyKey(relation.driver));
    if (!owner) continue;
    pending.set(relation.id, 1);
    const list = dependents.get(owner.id) ?? [];
    list.push(relation); dependents.set(owner.id, list);
  }
  const result = relationships.filter(relation => !pending.get(relation.id));
  for (let index = 0; index < result.length; index++) {
    for (const dependent of dependents.get(result[index].id) ?? []) {
      pending.set(dependent.id, pending.get(dependent.id)! - 1);
      if (!pending.get(dependent.id)) result.push(dependent);
    }
  }
  if (result.length !== relationships.length) throw Error("Driven-key relationships cannot contain a dependency cycle.");
  orderedCache.set(relationships, result);
  return result;
}

export function validateDrivenKeys(value: unknown, doc: SceneDocument): asserts value is DrivenKeyRelationship[] {
  if (!Array.isArray(value) || value.length > 10000) throw Error("Invalid driven-key relationships.");
  const ids = new Set<string>(), outputs = new Set<string>(), keyIds = new Set<string>();
  const animated = new Set((doc.animation?.tracks ?? []).map(track => propertyKey(track)));
  let totalKeys = 0;
  for (const relation of value as DrivenKeyRelationship[]) {
    if (!relation || typeof relation !== "object" || typeof relation.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(relation.id) || ids.has(relation.id))
      throw Error("Invalid or duplicate driven-key relationship ID.");
    ids.add(relation.id);
    validateProperty(relation.driver, doc); validateProperty(relation.driven, doc);
    const output = propertyKey(relation.driven);
    if (outputs.has(output)) throw Error("A driven channel can have only one driver.");
    if (animated.has(output)) throw Error("A channel cannot have both time keys and driven keys. Remove its time curve first.");
    outputs.add(output);
    validateCurveKeys(relation.keys);
    totalKeys += relation.keys.length;
    if (totalKeys > 100000) throw Error("Too many driven keys.");
    if (!relation.keys.length) throw Error("A driven relationship needs at least one key.");
    for (const key of relation.keys) {
      if (keyIds.has(key.id)) throw Error("Duplicate driven key ID.");
      keyIds.add(key.id);
      if (relation.driven.channel.startsWith("scale.") && key.value < 0.001) throw Error("Driven scale must be at least 0.001.");
      if (relation.driven.channel === "visibility" && (key.value < 0 || key.value > 1)) throw Error("Visibility must be between 0 and 1.");
    }
  }
  // Always validate a freshly supplied graph, including callers that mutated their own data.
  orderedCache.delete(value);
  evaluationOrder(value);
}

/** Evaluate after time curves, before joints, skinning and elasticity. No document/history changes. */
export function evaluateDrivenKeys(doc: SceneDocument, poses: Map<string, EvaluatedPose>): void {
  if (!doc.drivenKeys?.length) return;
  for (const relation of evaluationOrder(doc.drivenKeys)) {
    const driver = poses.get(relation.driver.targetId), driven = poses.get(relation.driven.targetId);
    if (!driver || !driven) throw Error("Missing evaluated pose for a driven-key relationship.");
    let value = evaluateCurve(relation.keys, readChannel(driver, relation.driver.channel));
    if (value === undefined) continue;
    if (relation.driven.channel.startsWith("scale.")) value = Math.max(0.001, value);
    if (relation.driven.channel === "visibility") value = Math.max(0, Math.min(1, value));
    poses.set(relation.driven.targetId, writeChannel(driven, relation.driven.channel, value));
  }
}

function commit(store: SceneStore, relationships: DrivenKeyRelationship[], editLabel: string) {
  const doc = store.getState().document;
  validateDrivenKeys(relationships, doc);
  if (JSON.stringify(relationships) === JSON.stringify(doc.drivenKeys ?? [])) return;
  store.setState({ document: { ...doc, drivenKeys: relationships }, editLabel });
}

export function upsertDrivenRelationship(store: SceneStore, relationship: DrivenKeyRelationship): void {
  const existing = store.getState().document.drivenKeys ?? [];
  const next = structuredClone(relationship);
  next.keys.sort((a, b) => a.time - b.time);
  commit(store, existing.some(relation => relation.id === next.id)
    ? existing.map(relation => relation.id === next.id ? next : relation)
    : [...existing, next], "Edit driven-key curve");
}

export function setDrivenKey(
  store: SceneStore, driver: DrivenProperty, driven: DrivenProperty, driverValue: number, drivenValue: number,
): void {
  const existing = (store.getState().document.drivenKeys ?? []).find(relation => sameProperty(relation.driven, driven));
  if (existing && !sameProperty(existing.driver, driver)) throw Error("This driven channel already has a different driver. Remove that relationship first.");
  const key = existing?.keys.find(item => item.time === driverValue);
  const next: CurveKey = key ? { ...key, value: drivenValue } : {
    id: crypto.randomUUID(), time: driverValue, value: drivenValue,
    interpolation: driven.channel === "visibility" ? "step" : "linear", tangentMode: "auto",
  };
  const relationship: DrivenKeyRelationship = existing ? {
    ...existing, keys: [...existing.keys.filter(item => item.id !== next.id), next],
  } : { id: crypto.randomUUID(), driver: { ...driver }, driven: { ...driven }, keys: [next] };
  upsertDrivenRelationship(store, relationship);
}

export function removeDrivenRelationship(store: SceneStore, id: string): void {
  commit(store, (store.getState().document.drivenKeys ?? []).filter(relation => relation.id !== id), "Remove driven-key relationship");
}

export function deleteDrivenKeys(store: SceneStore, relationshipId: string, keyIds: Iterable<string>): void {
  const ids = new Set(keyIds);
  const relationships = (store.getState().document.drivenKeys ?? []).map(relation => relation.id === relationshipId
    ? { ...relation, keys: relation.keys.filter(key => !ids.has(key.id)) } : relation).filter(relation => relation.keys.length);
  commit(store, relationships, "Delete driven keys");
}
