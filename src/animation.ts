import { CubicBezierCurve, Vector2 } from "three";
import { validateParticleEmitters } from "./particle-emitter.ts";
import type { SceneDocument, TransformChannels } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export const ANIMATION_CHANNELS = [
  "position.x", "position.y", "position.z", "rotation.x", "rotation.y", "rotation.z",
  "scale.x", "scale.y", "scale.z", "visibility",
] as const;
export type AnimationChannel = typeof ANIMATION_CHANNELS[number];
export type CurveKey = {
  id: string;
  time: number;
  value: number;
  interpolation: "step" | "linear" | "bezier";
  tangentMode: "auto" | "clamped" | "flat" | "spline" | "fixed";
  inSlope?: number;
  outSlope?: number;
  /** Handle length as a fraction of its adjoining segment's duration. */
  inWeight?: number;
  outWeight?: number;
  broken?: boolean;
};
export type AnimationTrack = { id: string; targetId: string; channel: AnimationChannel; keys: CurveKey[] };
export type AnimationData = { fps: number; start: number; end: number; loop: boolean; tracks: AnimationTrack[] };
export type AnimationPose = TransformChannels & { visibility: number };
export type KeyClipboard = { tracks: AnimationTrack[]; origin: number };

export function defaultAnimation(): AnimationData {
  return { fps: 24, start: 0, end: 288, loop: true, tracks: [] };
}

function finite(value: unknown, bound = 1e12): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= bound;
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validateCurveKeys(value: unknown): asserts value is CurveKey[] {
  if (!Array.isArray(value) || value.length > 100000) throw Error("Invalid animation keys.");
  const ids = new Set<string>();
  let previous = -Infinity;
  for (const key of value) {
    if (!record(key) || !validId(key.id) || ids.has(key.id) || !finite(key.time, 1e6) || key.time <= previous || !finite(key.value)
      || !["step", "linear", "bezier"].includes(key.interpolation as string)
      || !["auto", "clamped", "flat", "spline", "fixed"].includes(key.tangentMode as string)) throw Error("Invalid animation key or duplicate key time.");
    for (const name of ["inSlope", "outSlope"] as const) if (key[name] !== undefined && !finite(key[name])) throw Error("Invalid tangent slope.");
    for (const name of ["inWeight", "outWeight"] as const) if (key[name] !== undefined && (!finite(key[name]) || key[name] < 0 || key[name] > 1)) throw Error("Tangent weights must be between zero and one.");
    if (key.broken !== undefined && typeof key.broken !== "boolean") throw Error("Invalid tangent linking.");
    ids.add(key.id); previous = key.time;
  }
}

export function validateAnimation(value: unknown, doc: SceneDocument): asserts value is AnimationData {
  if (doc.joints?.some(joint => Object.hasOwn(doc.nodes, joint.id))) throw Error("Joint and object IDs must be distinct.");
  if (!record(value) || !finite(value.fps, 240) || value.fps < 1 || !finite(value.start, 1e6) || !finite(value.end, 1e6)
    || value.end <= value.start || typeof value.loop !== "boolean" || !Array.isArray(value.tracks) || value.tracks.length > 100000) throw Error("Invalid animation settings.");
  const trackIds = new Set<string>(), keyIds = new Set<string>(), channels = new Set<string>();
  const driven = new Set((doc.drivenKeys ?? []).map(relation => `${relation.driven.targetId}:${relation.driven.channel}`));
  let totalKeys = 0;
  for (const track of value.tracks) {
    if (!record(track) || !validId(track.id) || trackIds.has(track.id) || !validId(track.targetId)
      || !ANIMATION_CHANNELS.includes(track.channel as AnimationChannel)) throw Error("Invalid animation track.");
    const node = doc.nodes[track.targetId], joint = doc.joints?.find(j => j.id === track.targetId);
    if (node?.type !== "transform" && !joint) throw Error("Animation target is missing.");
    if (joint && (track.channel as string).startsWith("scale.")) throw Error("Joint scale animation is not supported.");
    const channelKey = `${track.targetId}:${track.channel}`;
    if (channels.has(channelKey)) throw Error("Duplicate animated channel.");
    if (driven.has(channelKey)) throw Error("A channel cannot have both time keys and driven keys.");
    validateCurveKeys(track.keys);
    totalKeys += track.keys.length;
    if (totalKeys > 100000) throw Error("Too many animation keys.");
    for (const key of track.keys) {
      if (keyIds.has(key.id)) throw Error("Duplicate animation key ID.");
      keyIds.add(key.id);
    }
    trackIds.add(track.id); channels.add(channelKey);
  }
}

function secant(a: CurveKey, b: CurveKey): number { return (b.value - a.value) / (b.time - a.time); }
const segmentCache = new WeakMap<readonly CurveKey[], Map<number, CubicBezierCurve>>();

/** Slopes are value units per frame (degrees per frame for Euler channels). */
export function tangentSlope(keys: readonly CurveKey[], index: number, side: "in" | "out"): number {
  const key = keys[index], previous = keys[index - 1], next = keys[index + 1];
  if (!key || key.tangentMode === "flat") return 0;
  if (key.tangentMode === "fixed") return (side === "in" ? key.inSlope : key.outSlope) ?? 0;
  if (!previous && !next) return 0;
  if (!previous) return secant(key, next);
  if (!next) return secant(previous, key);
  const before = secant(previous, key), after = secant(key, next);
  const slope = secant(previous, next);
  if (key.tangentMode === "spline") return slope;
  // Clamped tangents flatten plateaus. Auto also flattens extrema and limits
  // slopes to avoid crossing neighboring key values on monotonic segments.
  if (before === 0 || after === 0 || (key.tangentMode === "auto" && before * after <= 0)) return 0;
  if (key.tangentMode === "clamped") return slope;
  return Math.sign(slope) * Math.min(Math.abs(slope), 3 * Math.abs(before), 3 * Math.abs(after));
}

/** Freeze effective preset slopes before editing a handle, keeping the other
 * side intact for broken tangents and aligning slopes for linked tangents. */
export function withTangent(keys: readonly CurveKey[], index: number, side: "in" | "out", slope: number, weight?: number): CurveKey {
  const key = keys[index];
  if (!key || !finite(slope) || (weight !== undefined && (!finite(weight) || weight < 0 || weight > 1))) throw Error("Invalid tangent edit.");
  const next: CurveKey = { ...key, interpolation: "bezier", tangentMode: "fixed", inSlope: tangentSlope(keys, index, "in"), outSlope: tangentSlope(keys, index, "out") };
  if (side === "in" || !key.broken) next.inSlope = slope;
  if (side === "out" || !key.broken) next.outSlope = slope;
  if (weight !== undefined) {
    if (side === "in") next.inWeight = weight; else next.outWeight = weight;
  }
  return next;
}

function bezierSegment(keys: readonly CurveKey[], index: number): CubicBezierCurve {
  const a = keys[index], b = keys[index + 1], duration = b.time - a.time;
  const outWeight = a.outWeight ?? 1 / 3, inWeight = b.inWeight ?? 1 / 3;
  let segments = segmentCache.get(keys);
  if (!segments) { segments = new Map(); segmentCache.set(keys, segments); }
  let curve = segments.get(index);
  if (!curve) {
    curve = new CubicBezierCurve(new Vector2(0, a.value),
      new Vector2(outWeight, a.value + tangentSlope(keys, index, "out") * duration * outWeight),
      new Vector2(1 - inWeight, b.value - tangentSlope(keys, index + 1, "in") * duration * inWeight), new Vector2(1, b.value));
    segments.set(index, curve);
  }
  return curve;
}
function bezierParameter(curve: CubicBezierCurve, fraction: number): number {
  // Three evaluates the cubic; bisection finds its monotonic time parameter.
  // Normalize time first to retain precision in scenes far from frame zero.
  if (Math.abs(curve.v1.x - 1 / 3) < 1e-12 && Math.abs(curve.v2.x - 2 / 3) < 1e-12) return fraction;
  let start = 0, end = 1, parameter = fraction;
  const point = new Vector2();
  for (let i = 0; i < 52; i++) {
    parameter = (start + end) / 2;
    const x = curve.getPoint(parameter, point).x;
    if (x === fraction) break;
    if (x < fraction) start = parameter; else end = parameter;
  }
  return parameter;
}

export function evaluateCurve(keys: readonly CurveKey[], time: number): number | undefined {
  if (!Number.isFinite(time)) throw Error("Curve time must be finite.");
  if (!keys.length) return undefined;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  let low = 0, high = keys.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (keys[middle].time <= time) low = middle; else high = middle;
  }
  const a = keys[low], b = keys[high];
  if (time === a.time || a.interpolation === "step") return a.value;
  const fraction = (time - a.time) / (b.time - a.time);
  if (a.interpolation === "linear") return a.value + (b.value - a.value) * fraction;
  const curve = bezierSegment(keys, low);
  return curve.getPoint(bezierParameter(curve, fraction)).y;
}

export function readChannel(channels: TransformChannels & { visibility?: number }, channel: AnimationChannel): number {
  if (!ANIMATION_CHANNELS.includes(channel)) throw Error("Unsupported animation channel.");
  if (channel === "visibility") return channels.visibility ?? 1;
  const [property, axis] = channel.split(".") as [keyof TransformChannels, string];
  return channels[property]["xyz".indexOf(axis)];
}
export function writeChannel(channels: TransformChannels & { visibility?: number }, channel: AnimationChannel, value: number): AnimationPose {
  if (!finite(value)) throw Error("Animation values must be finite.");
  const next: AnimationPose = { position: [...channels.position], rotation: [...channels.rotation], scale: [...channels.scale], visibility: channels.visibility ?? 1 };
  applyChannel(next, channel, value);
  return next;
}
function applyChannel(next: AnimationPose, channel: AnimationChannel, value: number) {
  if (!ANIMATION_CHANNELS.includes(channel)) throw Error("Unsupported animation channel.");
  if (channel === "visibility") next.visibility = value;
  else {
    const [property, axis] = channel.split(".") as [keyof TransformChannels, string];
    next[property]["xyz".indexOf(axis)] = property === "scale" ? Math.max(0.001, value) : value;
  }
}
export function baseChannels(doc: SceneDocument, id: string): AnimationPose {
  const node = doc.nodes[id], joint = doc.joints?.find(j => j.id === id);
  if (node?.type !== "transform" && !joint) throw Error("Animation target is missing.");
  return {
    position: [...(node?.type === "transform" ? node.position : joint!.position)],
    rotation: [...(node?.type === "transform" ? node.rotation : joint!.rotation ?? [0, 0, 0])],
    scale: node?.type === "transform" ? [...node.scale] : [1, 1, 1], visibility: 1,
  };
}

// Reuse the index while the immutable animation document is unchanged.
const trackIndexes = new WeakMap<AnimationData, Map<string, AnimationTrack[]>>();
function tracksFor(doc: SceneDocument, id: string): AnimationTrack[] {
  if (!doc.animation) return [];
  let index = trackIndexes.get(doc.animation);
  if (!index) {
    index = new Map();
    for (const track of doc.animation.tracks) {
      const tracks = index.get(track.targetId) ?? [];
      tracks.push(track); index.set(track.targetId, tracks);
    }
    trackIndexes.set(doc.animation, index);
  }
  return index.get(id) ?? [];
}
export function evaluateChannels(doc: SceneDocument, id: string, frame: number): AnimationPose {
  if (!Number.isFinite(frame)) throw Error("Animation frame must be finite.");
  const pose = baseChannels(doc, id);
  for (const track of tracksFor(doc, id)) {
    const value = track.channel === "visibility" ? evaluateVisibility(track.keys, frame) : evaluateCurve(track.keys, frame);
    if (value !== undefined) applyChannel(pose, track.channel, value);
  }
  return pose;
}

/** One fresh pose map per frame, linear in scene size and track count. */
export function evaluateSceneAnimation(doc: SceneDocument, frame: number): Map<string, AnimationPose> {
  if (!Number.isFinite(frame)) throw Error("Animation frame must be finite.");
  const poses = new Map<string, AnimationPose>();
  for (const node of Object.values(doc.nodes)) if (node.type === "transform") {
    poses.set(node.id, { position: [...node.position], rotation: [...node.rotation], scale: [...node.scale], visibility: 1 });
  }
  for (const joint of doc.joints ?? []) {
    poses.set(joint.id, { position: [...joint.position], rotation: [...joint.rotation ?? [0, 0, 0]], scale: [1, 1, 1], visibility: 1 });
  }
  for (const track of doc.animation?.tracks ?? []) {
    const pose = poses.get(track.targetId);
    if (!pose) continue;
    const value = track.channel === "visibility" ? evaluateVisibility(track.keys, frame) : evaluateCurve(track.keys, frame);
    if (value !== undefined) applyChannel(pose, track.channel, value);
  }
  return poses;
}

function evaluateVisibility(keys: CurveKey[], frame: number): number | undefined {
  if (!keys.length) return undefined;
  let low = 0, high = keys.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (keys[middle].time <= frame) low = middle; else high = middle;
  }
  return keys[low].value >= 0.5 ? 1 : 0;
}

function saveAnimation(store: SceneStore, animation: AnimationData, editLabel: string) {
  const doc = store.getState().document;
  validateAnimation(animation, doc);
  validateParticleEmitters({ ...doc, animation });
  if (JSON.stringify(doc.animation ?? defaultAnimation()) === JSON.stringify(animation)) return;
  store.setState({ document: { ...doc, animation }, editLabel });
}
function targetChannels(doc: SceneDocument, id: string): AnimationChannel[] {
  return ANIMATION_CHANNELS.filter(channel => channel !== "visibility" && (!doc.joints?.some(j => j.id === id) || !channel.startsWith("scale."))
    && !doc.drivenKeys?.some(relation => relation.driven.targetId === id && relation.driven.channel === channel));
}
function newKey(time: number, value: number): CurveKey {
  return { id: crypto.randomUUID(), time, value, interpolation: "bezier", tangentMode: "auto" };
}
function withKey(track: AnimationTrack, frame: number, value: number): AnimationTrack {
  const existing = track.keys.find(key => key.time === frame);
  return { ...track, keys: existing ? track.keys.map(key => key === existing ? { ...key, value } : key)
    : [...track.keys, newKey(frame, value)].sort((a, b) => a.time - b.time) };
}

/** Pure document update so a transform edit and Auto Key share one undo step. */
export function keyChannels(doc: SceneDocument, id: string, channels: TransformChannels & { visibility?: number }, frame: number, onlyExisting = true): SceneDocument {
  if (!finite(frame, 1e6)) throw Error("Invalid key frame.");
  baseChannels(doc, id);
  const animation = doc.animation ?? defaultAnimation();
  let tracks = [...animation.tracks];
  for (const channel of targetChannels(doc, id)) {
    const index = tracks.findIndex(track => track.targetId === id && track.channel === channel);
    if (index < 0 && onlyExisting) continue;
    const track = index < 0 ? { id: crypto.randomUUID(), targetId: id, channel, keys: [] } : tracks[index];
    if (onlyExisting && Math.abs((evaluateCurve(track.keys, frame) ?? readChannel(channels, channel)) - readChannel(channels, channel)) < 1e-10) continue;
    const next = withKey(track, frame, readChannel(channels, channel));
    if (index < 0) tracks.push(next); else tracks[index] = next;
  }
  if (JSON.stringify(animation.tracks) === JSON.stringify(tracks)) return doc;
  const nextAnimation = { ...animation, tracks };
  validateAnimation(nextAnimation, doc);
  return { ...doc, animation: nextAnimation };
}

export function setKeys(store: SceneStore, targetIds: Iterable<string>, frame: number,
  poses?: ReadonlyMap<string, TransformChannels & { visibility?: number }>, channels?: AnimationChannel[]) {
  const doc = store.getState().document, animation = doc.animation ?? defaultAnimation();
  if (!finite(frame, 1e6)) throw Error("Invalid key frame.");
  let tracks = [...animation.tracks];
  for (const targetId of new Set(targetIds)) {
    const pose = poses?.get(targetId) ?? evaluateChannels(doc, targetId, frame);
    for (const channel of channels ?? targetChannels(doc, targetId)) {
      const index = tracks.findIndex(track => track.targetId === targetId && track.channel === channel);
      const track = index < 0 ? { id: crypto.randomUUID(), targetId, channel, keys: [] } : tracks[index];
      const next = withKey(track, frame, readChannel(pose, channel));
      if (index < 0) tracks.push(next); else tracks[index] = next;
    }
  }
  saveAnimation(store, { ...animation, tracks }, "Set keyframe");
}

export function replaceTracks(store: SceneStore, replacements: AnimationTrack[], label = "Edit animation curves") {
  const animation = store.getState().document.animation ?? defaultAnimation();
  const byId = new Map(replacements.map(track => [track.id, structuredClone(track)]));
  if (byId.size !== replacements.length) throw Error("Duplicate animation track ID.");
  const tracks = animation.tracks.map(track => {
    const replacement = byId.get(track.id);
    byId.delete(track.id); return replacement ?? track;
  });
  tracks.push(...byId.values());
  saveAnimation(store, { ...animation, tracks }, label);
}
export function upsertTrack(store: SceneStore, track: AnimationTrack) { replaceTracks(store, [track]); }

/** Insert at the evaluated value without changing the curve. Existing keys are
 * returned unchanged. Adjacent presets become fixed tangents to retain shape. */
export function insertKey(store: SceneStore, trackId: string, time: number): string {
  if (!finite(time, 1e6)) throw Error("Invalid insert frame.");
  const animation = store.getState().document.animation ?? defaultAnimation();
  const track = animation.tracks.find(track => track.id === trackId);
  if (!track) throw Error("Select an existing animation curve.");
  const existing = track.keys.find(key => key.time === time);
  if (existing) return existing.id;
  if (!track.keys.length) throw Error("Set the first key before inserting into a curve.");
  const keys = [...track.keys], value = evaluateCurve(track.keys, time)!;
  const inserted: CurveKey = { ...newKey(time, value), tangentMode: "fixed", inSlope: 0, outSlope: 0 };
  const freeze = (index: number): CurveKey => ({ ...keys[index], tangentMode: "fixed",
    inSlope: tangentSlope(track.keys, index, "in"), outSlope: tangentSlope(track.keys, index, "out") });
  if (time < keys[0].time) {
    keys[0] = freeze(0); inserted.interpolation = "step"; keys.unshift(inserted);
  } else if (time > keys[keys.length - 1].time) {
    const last = keys.length - 1;
    keys[last] = { ...freeze(last), interpolation: "step" }; inserted.interpolation = "step"; keys.push(inserted);
  } else {
    const index = keys.findIndex(key => key.time > time) - 1;
    const a = freeze(index), b = freeze(index + 1), duration = b.time - a.time;
    // Visibility is discrete in scene evaluation even for legacy curves whose
    // serialized interpolation says Bezier. Preserve its held state.
    if (track.channel === "visibility") { a.interpolation = "step"; inserted.value = a.value; }
    inserted.interpolation = a.interpolation;
    if (a.interpolation === "linear") inserted.inSlope = inserted.outSlope = (b.value - a.value) / duration;
    if (a.interpolation === "bezier") {
      const curve = bezierSegment(track.keys, index), fraction = (time - a.time) / duration;
      const u = bezierParameter(curve, fraction);
      // De Casteljau splits the original control polygon using Three's vector
      // operations; the time parameter is the same one used by evaluation.
      const left1 = curve.v0.clone().lerp(curve.v1, u), center = curve.v1.clone().lerp(curve.v2, u), right2 = curve.v2.clone().lerp(curve.v3, u);
      const left2 = left1.clone().lerp(center, u), right1 = center.clone().lerp(right2, u);
      const split = left2.clone().lerp(right1, u);
      const failure = () => Error("This insertion needs a vertical or out-of-segment tangent. Adjust tangent weights before inserting here.");
      const weight = (value: number) => {
        if (!Number.isFinite(value) || value < -1e-10 || value > 1 + 1e-10) throw failure();
        return Math.max(0, Math.min(1, value));
      };
      const slope = (dx: number, dy: number) => {
        if (Math.abs(dx) < 1e-15) { if (Math.abs(dy) > 1e-12) throw failure(); return 0; }
        const result = dy / (dx * duration);
        if (!finite(result)) throw failure();
        return result;
      };
      inserted.value = split.y;
      a.outWeight = weight(left1.x / fraction);
      b.inWeight = weight((1 - right2.x) / (1 - fraction));
      inserted.inWeight = weight((fraction - left2.x) / fraction);
      inserted.outWeight = weight((right1.x - fraction) / (1 - fraction));
      inserted.inSlope = slope(fraction - left2.x, split.y - left2.y);
      inserted.outSlope = slope(right1.x - fraction, right1.y - split.y);
      // A zero-length handle has no effect; use the other side's slope so the
      // inserted key remains linked when a handle is subsequently extended.
      if (inserted.inWeight === 0) inserted.inSlope = inserted.outSlope;
      if (inserted.outWeight === 0) inserted.outSlope = inserted.inSlope;
      inserted.broken = false;
    }
    keys.splice(index, 2, a, inserted, b);
  }
  saveAnimation(store, { ...animation, tracks: animation.tracks.map(candidate => candidate.id === trackId ? { ...track, keys } : candidate) }, "Insert keyframe");
  return inserted.id;
}

export function deleteKeys(store: SceneStore, keyIds: Iterable<string>) {
  const animation = store.getState().document.animation ?? defaultAnimation(), selected = new Set(keyIds);
  saveAnimation(store, { ...animation, tracks: animation.tracks.map(track => ({ ...track, keys: track.keys.filter(key => !selected.has(key.id)) })).filter(track => track.keys.length) }, "Delete keyframes");
}
export function patchKeys(store: SceneStore, keyIds: Iterable<string>, patch: Partial<Omit<CurveKey, "id">>) {
  const animation = store.getState().document.animation ?? defaultAnimation(), selected = new Set(keyIds);
  const tracks = animation.tracks.map(track => ({ ...track, keys: track.keys.map(key => selected.has(key.id) ? { ...key, ...patch, id: key.id } : key).sort((a, b) => a.time - b.time) }));
  saveAnimation(store, { ...animation, tracks }, "Edit keyframes");
}
export function moveKeys(store: SceneStore, keyIds: Iterable<string>, timeDelta: number, valueDelta = 0) {
  if (!finite(timeDelta, 2e6) || !finite(valueDelta)) throw Error("Invalid keyframe movement.");
  const animation = store.getState().document.animation ?? defaultAnimation(), selected = new Set(keyIds);
  const tracks = animation.tracks.map(track => ({ ...track, keys: track.keys.map(key => selected.has(key.id)
    ? { ...key, time: key.time + timeDelta, value: key.value + valueDelta } : key).sort((a, b) => a.time - b.time) }));
  saveAnimation(store, { ...animation, tracks }, "Move keyframes");
}
/** Scale selected keys around a frame, snapping results to whole frames. */
export function scaleKeys(store: SceneStore, keyIds: Iterable<string>, factor: number, pivot?: number) {
  if (!finite(factor) || factor <= 0 || (pivot !== undefined && !finite(pivot, 1e6))) throw Error("Keyframe scale must be positive and finite.");
  const animation = store.getState().document.animation ?? defaultAnimation(), selected = new Set(keyIds);
  let origin = pivot ?? Infinity;
  if (pivot === undefined) for (const track of animation.tracks) for (const key of track.keys) if (selected.has(key.id)) origin = Math.min(origin, key.time);
  if (!Number.isFinite(origin)) return;
  const tracks = animation.tracks.map(track => ({ ...track, keys: track.keys.map((key, index) => {
    if (!selected.has(key.id)) return key;
    const next = { ...key, time: Math.round(origin + (key.time - origin) * factor) };
    // Only segments with both endpoints selected undergo uniform scaling.
    // Preserve their handle value offsets using the actual snapped duration.
    const previous = track.keys[index - 1], following = track.keys[index + 1];
    if (key.tangentMode === "fixed" && previous && selected.has(previous.id) && key.inSlope !== undefined) {
      const duration = next.time - Math.round(origin + (previous.time - origin) * factor);
      if (duration) next.inSlope = key.inSlope * (key.time - previous.time) / duration;
    }
    if (key.tangentMode === "fixed" && following && selected.has(following.id) && key.outSlope !== undefined) {
      const duration = Math.round(origin + (following.time - origin) * factor) - next.time;
      if (duration) next.outSlope = key.outSlope * (following.time - key.time) / duration;
    }
    return next;
  }).sort((a, b) => a.time - b.time) }));
  saveAnimation(store, { ...animation, tracks }, "Scale keyframes");
}
export function setAnimationSettings(store: SceneStore, settings: Partial<Omit<AnimationData, "tracks">>) {
  saveAnimation(store, { ...(store.getState().document.animation ?? defaultAnimation()), ...settings }, "Animation settings");
}
export function copyKeys(doc: SceneDocument, keyIds: Iterable<string>): KeyClipboard {
  const selected = new Set(keyIds), tracks = (doc.animation?.tracks ?? []).map(track => ({ ...track, keys: track.keys.filter(key => selected.has(key.id)) })).filter(track => track.keys.length);
  return { tracks: structuredClone(tracks), origin: tracks.length ? tracks.reduce((first, track) => Math.min(first, track.keys[0].time), Infinity) : 0 };
}
/** Paste replaces keys at matching times and preserves relative key timing. */
export function pasteKeys(store: SceneStore, clipboard: KeyClipboard, frame: number, targetId?: string): string[] {
  if (!finite(frame, 1e6) || !finite(clipboard.origin, 1e6)) throw Error("Invalid paste frame.");
  const animation = store.getState().document.animation ?? defaultAnimation(), tracks = [...animation.tracks], ids: string[] = [];
  for (const source of clipboard.tracks) {
    const destination = targetId ?? source.targetId;
    const index = tracks.findIndex(track => track.targetId === destination && track.channel === source.channel);
    const track = index < 0 ? { id: crypto.randomUUID(), targetId: destination, channel: source.channel, keys: [] } : tracks[index];
    const pasted = source.keys.map(key => ({ ...key, id: crypto.randomUUID(), time: frame + key.time - clipboard.origin }));
    ids.push(...pasted.map(key => key.id));
    const times = new Set(pasted.map(key => key.time));
    const next = { ...track, keys: [...track.keys.filter(key => !times.has(key.time)), ...pasted].sort((a, b) => a.time - b.time) };
    if (index < 0) tracks.push(next); else tracks[index] = next;
  }
  saveAnimation(store, { ...animation, tracks }, "Paste keyframes");
  return ids;
}
