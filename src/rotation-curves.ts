import { replaceTracks, editingTracks, type AnimationTrack, type CurveKey } from "./animation.ts";
import { unwrapEuler } from "./animation-edit.ts";
import type { SceneDocument, Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export type EulerFilterMode = "xyz" | "channels";
export type RotationInterpolation = CurveKey["interpolation"];
const axes = ["rotation.x", "rotation.y", "rotation.z"] as const;

function rotationTracks(doc: SceneDocument, targetIds: Iterable<string>): AnimationTrack[] {
  const ids = new Set(targetIds);
  if (ids.size > 100000) throw Error("Too many rotation targets.");
  for (const id of ids) if (doc.nodes[id]?.type !== "transform" && !doc.joints?.some(joint => joint.id === id))
    throw Error("Rotation target is missing or is not an object or joint.");
  return editingTracks(doc).filter(track => ids.has(track.targetId) && track.channel.startsWith("rotation."));
}

/** Explicit destructive cleanup: intentional turns may be removed. No runtime
 * wrapping occurs, so ordinary authoring and playback retain 360/720-degree spins.
 * XYZ filtering requires synchronized keys and preserves each keyed orientation.
 * Fixed tangents follow the chosen Euler branch; automatic presets recompute.
 */
export function filterEulerRotations(store: SceneStore, targetIds: Iterable<string>, mode: EulerFilterMode = "xyz"): number {
  if (mode !== "xyz" && mode !== "channels") throw Error("Invalid Euler filter mode.");
  const tracks = rotationTracks(store.getState().document, targetIds), replacements: AnimationTrack[] = [];
  let changed = 0;
  if (mode === "channels") {
    for (const track of tracks) {
      let previous: number | undefined;
      const keys = track.keys.map(key => {
        const value = previous === undefined ? key.value : key.value + 360 * Math.round((previous - key.value) / 360);
        previous = value;
        if (value === key.value) return key;
        changed++; return { ...key, value };
      });
      replacements.push({ ...track, keys });
    }
  } else {
    const groups = new Map<string, AnimationTrack[]>();
    for (const track of tracks) groups.set(track.targetId, [...groups.get(track.targetId) ?? [], track]);
    for (const group of groups.values()) {
      const ordered = axes.map(axis => group.find(track => track.channel === axis));
      if (ordered.some(track => !track) || ordered.some(track => track!.keys.length !== ordered[0]!.keys.length
        || track!.keys.some((key, index) => key.time !== ordered[0]!.keys[index].time)))
        throw Error("XYZ filtering requires all three rotation curves with matching key times. Use Channel unwrap for independently keyed axes.");
      const output = ordered.map(track => ({ ...track!, keys: [...track!.keys] }));
      let previous: Vec3 | undefined;
      for (let index = 0; index < output[0].keys.length; index++) {
        const raw = ordered.map(track => track!.keys[index].value) as Vec3;
        const next = previous ? unwrapEuler(raw, previous) : raw;
        // Alternate XYZ representation negates the middle-angle derivative.
        const alternate = Math.abs((next[0] - raw[0]) / 360 - Math.round((next[0] - raw[0]) / 360)) > 0.25;
        for (let axis = 0; axis < 3; axis++) {
          const key = ordered[axis]!.keys[index], flipSlope = axis === 1 && alternate && key.tangentMode === "fixed";
          if (next[axis] === key.value && !flipSlope) continue;
          changed++;
          output[axis].keys[index] = { ...key, value: next[axis], ...(flipSlope ? {
            ...(key.inSlope !== undefined ? { inSlope: -key.inSlope } : {}),
            ...(key.outSlope !== undefined ? { outSlope: -key.outSlope } : {}),
          } : {}) };
        }
        previous = next;
      }
      replacements.push(...output);
    }
  }
  if (changed) replaceTracks(store, replacements, "Filter Euler rotations");
  return changed;
}

/** Interpolation is per scalar Euler channel in degrees, with XYZ composition.
 * Bézier uses existing tangents; linear retains authored turns; step holds keys.
 */
export function setRotationInterpolation(store: SceneStore, targetIds: Iterable<string>, interpolation: RotationInterpolation): void {
  if (!["step", "linear", "bezier"].includes(interpolation)) throw Error("Invalid rotation interpolation.");
  const tracks = rotationTracks(store.getState().document, targetIds);
  if (!tracks.length) return;
  replaceTracks(store, tracks.map(track => ({ ...track, keys: track.keys.map(key => ({ ...key, interpolation })) })), "Set Euler rotation interpolation");
}
