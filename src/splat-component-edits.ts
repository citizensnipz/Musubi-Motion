import type { SceneDocument } from "./scene-document.ts";
import type { SplatSelectionIdentity, SplatSelectionIndices } from "./splat-component-selection.ts";
import type { SceneStore } from "./scene-store.ts";

/** Each consecutive pair is an inclusive start, exclusive end in original source order. */
export type SplatComponentEdits = {
  version: 1;
  sourceCount: number;
  hidden: readonly number[];
  deleted: readonly number[];
};
export type SplatEditAction = "hide" | "show" | "delete" | "restore";
export const SPLAT_EDIT_LABELS: Record<SplatEditAction, string> = {
  hide: "Hide Selected Splats", show: "Show Hidden Splats",
  delete: "Delete Selected Splats", restore: "Restore Deleted Splats",
};
export const SPLAT_EDIT_RUN_LIMIT = 16_384;
// At this ceiling the renderer's per-instance bit mask is at most 16 MiB.
export const SPLAT_EDIT_SOURCE_LIMIT = 134_217_728;
const EMPTY: readonly number[] = Object.freeze([]);

export function validateSplatComponentEdits(value: unknown, decodedCount?: number): asserts value is SplatComponentEdits {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid splat component edits.");
  const { version, sourceCount, hidden, deleted } = value as Partial<SplatComponentEdits>;
  if (version !== 1) throw Error("Unsupported splat component edits version. This build opens edit version 1.");
  if (typeof sourceCount !== "number" || !Number.isSafeInteger(sourceCount) || sourceCount < 1 || sourceCount > SPLAT_EDIT_SOURCE_LIMIT)
    throw Error("Invalid original splat count in component edits.");
  if (decodedCount !== undefined && sourceCount !== decodedCount)
    throw Error("Splat component edits do not match the original asset's decoded splat count.");
  if (!Array.isArray(hidden) || !Array.isArray(deleted) || (hidden.length + deleted.length) === 0
    || (hidden.length + deleted.length) / 2 > SPLAT_EDIT_RUN_LIMIT)
    throw Error("Invalid or excessive splat component edit ranges.");
  for (const ranges of [hidden, deleted]) {
    if (ranges.length % 2) throw Error("Splat component edit ranges need a start and end.");
    let previousEnd = -1;
    for (let i = 0; i < ranges.length; i += 2) {
      const start = ranges[i], end = ranges[i + 1];
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= previousEnd
        || end <= start || end > sourceCount)
        throw Error("Splat component edit ranges must be ordered, separate, and within the original asset.");
      previousEnd = end;
    }
  }
  let h = 0, d = 0;
  while (h < hidden.length && d < deleted.length) {
    if (hidden[h + 1] <= deleted[d]) h += 2;
    else if (deleted[d + 1] <= hidden[h]) d += 2;
    else throw Error("A splat cannot be both hidden and deleted.");
  }
}

export function splatRunCount(ranges: readonly number[] | undefined): number {
  let total = 0;
  if (ranges) for (let i = 0; i < ranges.length; i += 2) total += ranges[i + 1] - ranges[i];
  return total;
}

function contains(ranges: readonly number[], index: number): boolean {
  let lo = 0, hi = ranges.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1, i = mid * 2;
    if (index < ranges[i]) hi = mid;
    else if (index >= ranges[i + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export function isSplatComponentActive(edits: SplatComponentEdits | undefined, index: number): boolean {
  return !edits || !(contains(edits.hidden, index) || contains(edits.deleted, index));
}

function union(a: readonly number[], b: readonly number[]): readonly number[] {
  const ranges: number[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    let start: number, end: number;
    if (j >= b.length || (i < a.length && a[i] <= b[j])) { start = a[i]; end = a[i + 1]; i += 2; }
    else { start = b[j]; end = b[j + 1]; j += 2; }
    if (ranges.length && start <= ranges[ranges.length - 1]) ranges[ranges.length - 1] = Math.max(ranges[ranges.length - 1], end);
    else ranges.push(start, end);
    if (ranges.length / 2 > SPLAT_EDIT_RUN_LIMIT)
      throw Error("This edit would exceed 16,384 separate splat ranges. Select a less fragmented region; nothing changed.");
  }
  return ranges;
}

export function editSplatComponents(
  doc: SceneDocument, identity: SplatSelectionIdentity, action: SplatEditAction, selected: SplatSelectionIndices = EMPTY,
): SceneDocument {
  const { shapeId, assetId, count } = identity;
  const shape = doc.nodes[shapeId];
  if (shape?.type !== "splatShape" || shape.assetId !== assetId || !Object.hasOwn(doc.assets, assetId))
    throw Error("The active splat shape or source asset changed.");
  if (!Number.isSafeInteger(count) || count < 1 || count > SPLAT_EDIT_SOURCE_LIMIT)
    throw Error("Component editing supports up to 134,217,728 original splats per object.");
  const current = shape.componentEdits;
  if (current && current.sourceCount !== count) throw Error("The original splat count changed.");
  let hidden = current?.hidden ?? EMPTY, deleted = current?.deleted ?? EMPTY;
  if (action === "show") {
    if (!hidden.length) return doc;
    hidden = EMPTY;
  } else if (action === "restore") {
    if (!deleted.length) return doc;
    deleted = EMPTY;
  } else {
    if (action !== "hide" && action !== "delete") throw Error("Unknown splat component edit.");
    if (selected.length > 1_000_000) throw Error("Component edits accept up to 1,000,000 selected splats.");
    // Validate every ID before constructing any authored change, even when earlier IDs are active.
    for (const index of selected) if (!Number.isSafeInteger(index) || index < 0 || index >= count)
      throw Error("Splat edit contains an invalid original index.");
    const indices = Uint32Array.from(selected).sort(), runs: number[] = [];
    let h = 0, d = 0;
    for (const index of indices) {
      while (hidden[h + 1] <= index) h += 2;
      while (deleted[d + 1] <= index) d += 2;
      if (hidden[h] <= index || deleted[d] <= index) continue;
      const end = runs[runs.length - 1];
      if (index < end) continue; // duplicate ID
      if (index === end) runs[runs.length - 1]++;
      else runs.push(index, index + 1);
    }
    if (!runs.length) return doc;
    if (action === "hide") hidden = union(hidden, runs);
    else deleted = union(deleted, runs);
  }
  const next = { ...shape };
  if (!hidden.length && !deleted.length) delete next.componentEdits;
  else {
    if ((hidden.length + deleted.length) / 2 > SPLAT_EDIT_RUN_LIMIT)
      throw Error("This edit would exceed 16,384 separate splat ranges. Show or restore existing edits first; nothing changed.");
    next.componentEdits = { version: 1, sourceCount: count, hidden, deleted };
  }
  return { ...doc, nodes: { ...doc.nodes, [shapeId]: next } };
}

export function commitSplatComponentEdit(store: SceneStore, identity: SplatSelectionIdentity, action: SplatEditAction, selected?: SplatSelectionIndices): boolean {
  const before = store.getState().document, document = editSplatComponents(before, identity, action, selected);
  if (before === document) return false;
  store.setState({ document, editLabel: SPLAT_EDIT_LABELS[action] });
  return true;
}
