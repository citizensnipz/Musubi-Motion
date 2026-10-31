import type { AnimationPose } from "./animation.ts";
import type { SceneDocument } from "./scene-document.ts";

type DraftSnapshot = { epoch: number; poses: Map<string, AnimationPose> };

function copyExistingPoses(document: SceneDocument, poses: ReadonlyMap<string, AnimationPose>) {
  const joints = new Set(document.joints?.map(joint => joint.id));
  const copy = new Map<string, AnimationPose>();
  for (const [id, pose] of poses) {
    if (document.nodes[id]?.type !== "transform" && !joints.has(id)) continue;
    copy.set(id, {
      position: [...pose.position], rotation: [...pose.rotation], scale: [...pose.scale], visibility: pose.visibility,
    });
  }
  return copy;
}

function retainsDraft(next: SceneDocument, previous: SceneDocument, label: string) {
  // Joint renames replace their array but do not change the evaluated pose.
  return label.startsWith("Rename") || (
    next.animation === previous.animation && next.joints === previous.joints &&
    next.drivenKeys === previous.drivenKeys && next.ikHandles === previous.ikHandles &&
    next.constraints === previous.constraints
  );
}

/**
 * Temporary unkeyed poses belong to a document revision and one continuous time
 * editing session. Call clear on scrub, playback, project replacement, or when a
 * pose is consumed by keying. Undo can restore a draft only within that session.
 *
 * Weak keys avoid retaining scene history after Zundo drops an old revision.
 */
export class PoseDrafts {
  private epoch = 0;
  private readonly snapshots = new WeakMap<SceneDocument, DraftSnapshot>();
  private readonly seen = new WeakSet<SceneDocument>();

  /** Capture before committing the corresponding immutable document revision. */
  capture(document: SceneDocument, poses: ReadonlyMap<string, AnimationPose>): void {
    this.snapshots.set(document, { epoch: this.epoch, poses: copyExistingPoses(document, poses) });
    this.seen.add(document);
  }

  /** Restore on a document transition; returned poses can safely be edited. */
  restore(next: SceneDocument, previous: SceneDocument, label: string): Map<string, AnimationPose> {
    // The first transition also records the initial, potentially draft-free,
    // document. Otherwise undoing to it could inherit the newer draft.
    this.seen.add(previous);
    let snapshot = this.snapshots.get(next);
    if (!this.seen.has(next) && !snapshot && retainsDraft(next, previous, label)) {
      const source = this.snapshots.get(previous);
      snapshot = {
        epoch: this.epoch,
        poses: source?.epoch === this.epoch ? copyExistingPoses(next, source.poses) : new Map(),
      };
      this.snapshots.set(next, snapshot);
    }
    this.seen.add(next);
    return snapshot?.epoch === this.epoch ? copyExistingPoses(next, snapshot.poses) : new Map();
  }

  /** Invalidate all historical poses without retaining or traversing documents. */
  clear(): void { this.epoch++; }
}
