import { defaultAnimation, validateAnimation, type AnimationData, type AnimationLayer } from "./animation.ts";
import { validateParticleEmitters } from "./particle-emitter.ts";
import type { SceneStore } from "./scene-store.ts";

function save(store: SceneStore, animation: AnimationData, editLabel: string) {
  const doc = store.getState().document;
  validateAnimation(animation, doc); validateParticleEmitters({ ...doc, animation });
  if (JSON.stringify(doc.animation ?? defaultAnimation()) === JSON.stringify(animation)) return;
  store.setState({ document: { ...doc, animation }, editLabel });
}
function layerName(name: string): string {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 200) throw Error("Layer name must contain 1–200 characters.");
  return name.trim();
}

/** Layer selection is persisted and undoable, but has no effect on evaluation. */
export function setActiveAnimationLayer(store: SceneStore, id?: string): void {
  const animation = store.getState().document.animation ?? defaultAnimation();
  if (id !== undefined && !animation.layers?.some(layer => layer.id === id)) throw Error("Animation layer is missing.");
  const { activeLayerId: _, ...rest } = animation;
  save(store, id === undefined ? rest : { ...rest, activeLayerId: id }, "Select animation layer");
}

export function addAnimationLayer(store: SceneStore, name = "Animation layer", mode: AnimationLayer["mode"] = "additive"): string {
  const animation = store.getState().document.animation ?? defaultAnimation(), id = crypto.randomUUID();
  const layer: AnimationLayer = { id, name: layerName(name), mode, weight: 1, mute: false, solo: false, locked: false };
  save(store, { ...animation, layers: [...animation.layers ?? [], layer], activeLayerId: id }, "Add animation layer");
  return id;
}

export function updateAnimationLayer(store: SceneStore, id: string, patch: Partial<Omit<AnimationLayer, "id">>): void {
  const animation = store.getState().document.animation ?? defaultAnimation();
  if (!animation.layers?.some(layer => layer.id === id)) throw Error("Animation layer is missing.");
  if (Object.keys(patch).some(key => !["name", "mode", "weight", "mute", "solo", "locked"].includes(key))) throw Error("Unsupported animation layer setting.");
  const settings = { ...patch, ...(patch.name !== undefined ? { name: layerName(patch.name) } : {}) };
  save(store, { ...animation, layers: animation.layers.map(layer => layer.id === id ? { ...layer, ...settings, id } : layer) }, "Edit animation layer");
}

export function reorderAnimationLayer(store: SceneStore, id: string, index: number): void {
  const animation = store.getState().document.animation ?? defaultAnimation(), layers = [...animation.layers ?? []], previous = layers.findIndex(layer => layer.id === id);
  if (previous < 0) throw Error("Animation layer is missing.");
  if (!Number.isInteger(index) || index < 0 || index >= layers.length) throw Error("Invalid animation layer order.");
  layers.splice(index, 0, layers.splice(previous, 1)[0]);
  save(store, { ...animation, layers }, "Reorder animation layers");
}

export function removeAnimationLayer(store: SceneStore, id: string): void {
  const animation = store.getState().document.animation ?? defaultAnimation(), layer = animation.layers?.find(layer => layer.id === id);
  if (!layer) throw Error("Animation layer is missing.");
  if (layer.locked) throw Error("Unlock the animation layer before removing it.");
  const { activeLayerId, ...rest } = animation;
  save(store, { ...rest, ...(activeLayerId !== undefined && activeLayerId !== id ? { activeLayerId } : {}),
    layers: animation.layers!.filter(layer => layer.id !== id), tracks: animation.tracks.filter(track => track.layerId !== id) }, "Remove animation layer");
}
