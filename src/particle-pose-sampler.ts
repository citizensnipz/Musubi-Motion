import type { Matrix4 } from "three";
import { evaluateSceneAnimation } from "./animation.ts";
import { evaluateDrivenKeys } from "./driven-keys.ts";
import { evaluateIK } from "./ik.ts";
import { constraintWorldMatrices, evaluateConstraints } from "./constraints.ts";
import type { SceneDocument } from "./scene-document.ts";

const MAX_CACHED_FRAMES = 256;

/** Samples one immutable authored document snapshot. Returned matrices belong
 * to the cache: callers must copy them before editing. Preview/turntable state
 * is deliberately absent. A new document revision requires a new sampler. */
export function createParticlePoseSampler(doc: SceneDocument): { worldAt(frame: number): ReadonlyMap<string, Matrix4> } {
  const cache = new Map<number, ReadonlyMap<string, Matrix4>>();
  let cachedMatrices = 0;
  return {
    worldAt(frame) {
      if (!Number.isFinite(frame)) throw Error("Particle pose frame must be finite.");
      const cached = cache.get(frame);
      if (cached) {
        cache.delete(frame); cache.set(frame, cached);
        return cached;
      }
      const poses = evaluateSceneAnimation(doc, frame);
      evaluateDrivenKeys(doc, poses);
      evaluateIK(doc, poses);
      evaluateConstraints(doc, poses);
      const world = constraintWorldMatrices(doc, poses);
      // Failed historical evaluations never enter or evict entries from the cache.
      cache.set(frame, world);
      cachedMatrices += world.size;
      while (cache.size > MAX_CACHED_FRAMES || (cachedMatrices > 32768 && cache.size > 1)) {
        const oldest = cache.keys().next().value!;
        cachedMatrices -= cache.get(oldest)!.size; cache.delete(oldest);
      }
      return world;
    },
  };
}
