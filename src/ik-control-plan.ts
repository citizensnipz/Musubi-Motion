import type { SceneDocument } from "./scene-document.ts";

const cache = new WeakMap<SceneDocument, ReadonlySet<string>>();

/** Constraint prerequisites are structural: blend, enabled state and solver
 * changes must not move them between evaluation phases. This also reserves
 * disabled connections against feedback when they are enabled later. */
function buildTargets(doc: SceneDocument): ReadonlySet<string> {
  const handles = doc.ikHandles ?? [];
  if (!Array.isArray(handles)) throw Error("Invalid IK handles.");
  const linked = handles.filter(handle => {
    if (!handle || typeof handle !== "object") throw Error("Invalid IK handle.");
    return handle.targetControl !== undefined || handle.poleControl !== undefined;
  });
  if (!linked.length) return new Set();

  const nodes = new Map(Object.values(doc.nodes).filter(node => node.type === "transform").map(node => [node.id, { parentId: node.parentId }]));
  const joints = new Map((doc.joints ?? []).map(joint => [joint.id, joint]));
  for (const joint of joints.values()) {
    if (Object.hasOwn(doc.nodes, joint.id)) throw Error("Joint and object IDs must be distinct.");
    nodes.set(joint.id, { parentId: joint.parentId });
  }

  // All chains are protected, not just the chain owning a particular control.
  // Cross-IK dependencies need an operation graph and are deliberately deferred.
  const controlled = new Set<string>();
  for (const handle of handles) {
    if (!joints.has(handle.rootId) || !joints.has(handle.endId)) throw Error("IK control dependencies require existing root and end joints.");
    const visited = new Set<string>();
    let current: string | null = handle.endId;
    while (current !== null) {
      if (visited.has(current)) throw Error("Invalid joint hierarchy in IK control dependencies.");
      visited.add(current);
      const joint = joints.get(current);
      if (!joint) throw Error("Missing joint in IK control dependencies.");
      controlled.add(current);
      if (current === handle.rootId) break;
      current = joint.parentId;
    }
    if (current !== handle.rootId) throw Error("The IK end joint must descend from its root.");
  }

  const sources = new Map<string, string[]>();
  const constraints = doc.constraints ?? [];
  if (!Array.isArray(constraints)) throw Error("Invalid constraint dependencies.");
  for (const constraint of constraints) {
    if (!constraint || !nodes.has(constraint.targetId) || !nodes.has(constraint.sourceId)) throw Error("A constraint dependency target is missing.");
    const list = sources.get(constraint.targetId) ?? [];
    list.push(constraint.sourceId);
    sources.set(constraint.targetId, list);
  }

  const pending: string[] = [];
  for (const handle of linked) {
    for (const link of [handle.targetControl, handle.poleControl]) {
      if (link === undefined) continue;
      if (!link || typeof link.objectId !== "string" || !Object.hasOwn(doc.nodes, link.objectId) || doc.nodes[link.objectId].type !== "transform") {
        throw Error("An IK control must reference an existing object transform, not a shape or joint.");
      }
      pending.push(link.objectId);
    }
    const parentId = joints.get(handle.rootId)!.parentId;
    if (parentId !== null) pending.push(parentId);
  }

  const result = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    if (result.has(id)) continue;
    if (controlled.has(id)) {
      throw Error("IK control dependencies cannot read an IK chain or its descendants. Feedback and cross-IK control dependencies are not supported.");
    }
    const node = nodes.get(id);
    if (!node) throw Error("An IK control hierarchy dependency is missing.");
    result.add(id);
    if (node.parentId !== null) pending.push(node.parentId);
    pending.push(...sources.get(id) ?? []);
  }
  return result;
}

/** Node IDs whose constraints run before IK, including hierarchy ancestors and
 * sources needed to place both linked controls and linked chains' FK parents.
 * Documents are immutable; callers must not mutate the returned cached set. */
export function ikInputConstraintTargets(doc: SceneDocument): ReadonlySet<string> {
  let targets = cache.get(doc);
  if (!targets) { targets = buildTargets(doc); cache.set(doc, targets); }
  return targets;
}

/** Rebuild for validation, even if a caller has mutated its own document. */
export function validateIKControlDependencies(doc: SceneDocument): void {
  cache.delete(doc);
  cache.set(doc, buildTargets(doc));
}
