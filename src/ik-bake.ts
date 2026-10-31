import { evaluateSceneAnimation, defaultAnimation, validateAnimation, type AnimationPose, type AnimationTrack, type CurveKey } from "./animation.ts";
import { unwrapEuler } from "./animation-edit.ts";
import { constraintWorldMatrices, validateConstraints } from "./constraints.ts";
import { evaluateDrivenKeys } from "./driven-keys.ts";
import { evaluateRigStages, validateIKHandles } from "./ik.ts";
import { planIKBake, type IKBakeSettings } from "./ik-bake-plan.ts";
import type { SceneDocument, Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export type { IKBakeSettings } from "./ik-bake-plan.ts";
export type IKBakeProgress = { phase: "sampling" | "verifying"; completed: number; total: number };
export type IKBakeControl = { signal?: AbortSignal; onProgress?: (progress: IKBakeProgress) => void; yieldTask?: () => Promise<void> };
export type IKBakeResult = { samples: number; keysWritten: number; start: number; end: number };

function sampledPose(doc: SceneDocument, frame: number, captureStages = false) {
  const poses = evaluateSceneAnimation(doc, frame);
  evaluateDrivenKeys(doc, poses);
  const stages = evaluateRigStages(doc, poses, captureStages, frame);
  return { poses, ...stages };
}

/** Sample the immutable source, construct all curves, then verify the complete
 * scene at every sample before one undoable commit. Between-sample motion is an
 * approximation; disabling the handle also affects frames outside this range. */
export async function bakeIKToFK(store: SceneStore, id: string, settings: IKBakeSettings, control: IKBakeControl = {}): Promise<IKBakeResult> {
  const original = store.getState().document;
  function check() {
    if (control.signal?.aborted) throw new DOMException("IK bake canceled.", "AbortError");
    if (store.getState().document !== original) throw Error("The scene changed during the IK bake. The bake was discarded; try again.");
  }
  check();
  const plan = planIKBake(original, id, settings), options = { ...settings };
  const animation = original.animation ?? defaultAnimation();
  const previous = new Map<string, Vec3>();
  const existing = new Map(animation.tracks.map(track => [`${track.targetId}:${track.channel}`, track]));
  const channels = ["rotation.x", "rotation.y", "rotation.z"] as const;
  const pending = plan.chainIds.flatMap(targetId => channels.map(channel => {
    const track = existing.get(`${targetId}:${channel}`);
    return { targetId, channel, track, originals: new Map((track?.keys ?? []).map(key => [key.time, key])), samples: [] as CurveKey[] };
  }));
  const byJoint = new Map(plan.chainIds.map((jointId, index) => [jointId, pending.slice(index * 3, index * 3 + 3)]));
  const yieldTask = control.yieldTask ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  let lastYield = performance.now(), completedSinceYield = 0;
  async function progress(phase: IKBakeProgress["phase"], completed: number) {
    check();
    control.onProgress?.({ phase, completed, total: plan.frames.length });
    check();
    if (++completedSinceYield >= 32 || performance.now() - lastYield >= 8) {
      check(); await yieldTask(); check();
      completedSinceYield = 0; lastYield = performance.now();
    }
  }
  await progress("sampling", 0);
  for (let index = 0; index < plan.frames.length; index++) {
    check();
    const frame = plan.frames[index], evaluated = sampledPose(original, frame, true);
    for (const jointId of plan.chainIds) {
      const solved = evaluated.solvedPoses!.get(jointId), fk = evaluated.fkPoses!.get(jointId);
      if (!solved || !fk) throw Error("The IK bake could not evaluate the complete joint chain.");
      const rotation = options.minimizeRotation ? unwrapEuler(solved.rotation, previous.get(jointId) ?? fk.rotation) : [...solved.rotation] as Vec3;
      previous.set(jointId, rotation);
      byJoint.get(jointId)!.forEach((entry, axis) => entry.samples.push({
        id: entry.originals.get(frame)?.id ?? crypto.randomUUID(), time: frame, value: rotation[axis], interpolation: "linear", tangentMode: "auto",
      }));
    }
    await progress("sampling", index + 1);
  }
  check();
  const replacements = new Map<string, AnimationTrack>();
  for (const entry of pending) {
    const outside = options.preserveOutsideKeys ? (entry.track?.keys ?? []).filter(key => key.time < options.start || key.time > options.end) : [];
    replacements.set(`${entry.targetId}:${entry.channel}`, {
      id: entry.track?.id ?? crypto.randomUUID(), targetId: entry.targetId, channel: entry.channel,
      keys: [...outside, ...entry.samples].sort((a, b) => a.time - b.time),
    });
  }
  const tracks = animation.tracks.map(track => {
    const key = `${track.targetId}:${track.channel}`, replacement = replacements.get(key);
    replacements.delete(key); return replacement ?? track;
  });
  tracks.push(...replacements.values());
  const candidate: SceneDocument = { ...original, animation: { ...animation, tracks },
    ikHandles: original.ikHandles!.map(handle => handle.id === id ? { ...handle, enabled: false } : handle) };
  validateIKHandles(candidate.ikHandles, candidate);
  validateAnimation(candidate.animation, candidate);
  validateConstraints(candidate.constraints ?? [], candidate);
  check();

  function sameScene(expected: Map<string, AnimationPose>, actual: Map<string, AnimationPose>, frame: number) {
    const before = constraintWorldMatrices(original, expected), after = constraintWorldMatrices(candidate, actual);
    for (const [objectId, matrix] of before) {
      const result = after.get(objectId), aVisibility = expected.get(objectId)?.visibility ?? 1, bVisibility = actual.get(objectId)?.visibility ?? 1;
      const failed = !result || matrix.elements.some((value, index) => {
        const next = result.elements[index];
        return !Number.isFinite(value) || !Number.isFinite(next) || Math.abs(value - next) > 1e-6 + Math.max(Math.abs(value), Math.abs(next)) * 1e-10;
      });
      if (failed || !Number.isFinite(aVisibility) || !Number.isFinite(bVisibility) || (aVisibility >= .5) !== (bVisibility >= .5) || Math.abs(aVisibility - bVisibility) > 1e-6) {
        throw Error(`Baking would change the evaluated pose or visibility of ${objectId} at frame ${frame}. Resolve driven-key or constraint dependencies before baking.`);
      }
    }
  }
  await progress("verifying", 0);
  for (let index = 0; index < plan.frames.length; index++) {
    check();
    const frame = plan.frames[index];
    sameScene(sampledPose(original, frame).poses, sampledPose(candidate, frame).poses, frame);
    await progress("verifying", index + 1);
  }
  check();
  store.setState({ document: candidate, editLabel: "Bake IK to FK" });
  return { samples: plan.frames.length, keysWritten: plan.keysWritten, start: options.start, end: options.end };
}
