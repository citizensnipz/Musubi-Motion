import { ikChain } from "./ik.ts";
import type { SceneDocument } from "./scene-document.ts";

export type IKBakeSettings = {
  start: number;
  end: number;
  step: number;
  preserveOutsideKeys: boolean;
  minimizeRotation: boolean;
};

const MAX_SAMPLES = 10_001;
const MAX_POSE_WORK = 2_000_000;
const MAX_KEYS = 100_000;
const MAX_TRACKS = 100_000;
const rotationChannels = new Set(["rotation.x", "rotation.y", "rotation.z"]);

/** Plan the exact samples and resulting animation budget before evaluating or
 * modifying a scene. The command must still verify sampled downstream poses. */
export function planIKBake(doc: SceneDocument, handleId: string, settings: IKBakeSettings): {
  frames: number[];
  chainIds: string[];
  keysWritten: number;
  resultKeyCount: number;
} {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw Error("Choose valid IK bake settings.");
  const { start, end, step, preserveOutsideKeys, minimizeRotation } = settings;
  if (!Number.isFinite(start) || !Number.isFinite(end) || Math.abs(start) > 1e6 || Math.abs(end) > 1e6)
    throw Error("Bake start and end must be finite frames within ±1,000,000.");
  if (end < start) throw Error("Bake end must be at or after the start frame.");
  if (!Number.isFinite(step) || step <= 0) throw Error("Bake sample step must be a finite number greater than zero.");
  if (typeof preserveOutsideKeys !== "boolean" || typeof minimizeRotation !== "boolean")
    throw Error("Preserve outside keys and minimize rotation must be enabled or disabled.");
  const handle = doc.ikHandles?.find(item => item.id === handleId);
  if (!handle) throw Error("Choose an existing IK handle to bake.");
  const chainIds = ikChain(doc, handle.rootId, handle.endId), chain = new Set(chainIds);
  if (doc.drivenKeys?.some(relation => chain.has(relation.driven.targetId) && rotationChannels.has(relation.driven.channel)))
    throw Error("A chain rotation is owned by Set Driven Keys. Remove those rotation relationships before baking IK.");
  if (doc.constraints?.some(constraint => constraint.enabled && chain.has(constraint.targetId) && ["orient", "aim", "parent"].includes(constraint.type)))
    throw Error("A chain rotation has an active Orient, Aim or Parent constraint. Disable or remove it before baking IK.");

  const frames = [start];
  if (start !== end) {
    for (let index = 1; ; index++) {
      // Multiplication avoids accumulating a rounding error on every step. The
      // endpoint is always the supplied end, including a shorter final interval.
      const candidate = start + index * step;
      // Snap arithmetic roundoff at an intended endpoint, but never absorb a
      // meaningful fraction of a tiny user-selected interval.
      const endTolerance = Math.min(step * 1e-6,
        Number.EPSILON * Math.max(1, Math.abs(start), Math.abs(end), Math.abs(candidate)) * 8);
      const frame = candidate >= end || end - candidate <= endTolerance ? end : candidate;
      if (frame <= frames[frames.length - 1])
        throw Error("Bake sample step is smaller than frame precision. Increase the step.");
      if (frames.length === MAX_SAMPLES)
        throw Error("Bake at most 10,001 samples. Increase the step or shorten the range.");
      frames.push(frame);
      if (frame === end) break;
    }
  }
  const poseWork = frames.length * (Object.keys(doc.nodes).length + (doc.joints?.length ?? 0));
  if (poseWork > MAX_POSE_WORK)
    throw Error("This bake exceeds 2,000,000 estimated pose evaluations. Shorten the range, increase the step or simplify the scene.");

  const tracks = doc.animation?.tracks ?? [];
  const layered = !!doc.animation?.layers?.length;
  if (layered && doc.animation!.layers!.length >= 1000) throw Error("Remove an animation layer before creating the IK bake override layer.");
  const outputs = new Set<string>();
  const keysWritten = frames.length * chainIds.length * 3;
  let resultKeyCount = keysWritten;
  for (const track of tracks) {
    if (!layered && chain.has(track.targetId) && rotationChannels.has(track.channel)) {
      outputs.add(`${track.targetId}:${track.channel}`);
      if (preserveOutsideKeys) for (const key of track.keys) if (key.time < start || key.time > end) resultKeyCount++;
    } else resultKeyCount += track.keys.length;
  }
  if (resultKeyCount > MAX_KEYS)
    throw Error("The bake would exceed 100,000 animation keys. Reduce samples, remove other keys or turn off Preserve outside keys.");
  const resultTrackCount = tracks.length + chainIds.length * 3 - outputs.size;
  if (resultTrackCount > MAX_TRACKS)
    throw Error("The bake would exceed 100,000 animation tracks. Remove unused animation tracks before baking.");
  return { frames, chainIds, keysWritten, resultKeyCount };
}
