import { createStore } from "zustand/vanilla";
import { temporal } from "zundo";
import {
  emptyScene,
  normalizedChannels,
  uniqueName,
} from "./scene-document.ts";
import type { SceneDocument, TransformChannels } from "./scene-document.ts";

type EditorState = { document: SceneDocument; editLabel: string };

export function createSceneStore(initial = emptyScene()) {
  return createStore<EditorState>()(
    temporal(() => ({ document: initial, editLabel: "Initial scene" }), {
      limit: 100,
      equality: (before, after) => before.document === after.document,
    }),
  );
}
export type SceneStore = ReturnType<typeof createSceneStore>;

export function commitChannels(
  store: SceneStore,
  id: string,
  channels: TransformChannels,
  label = "Transform",
) {
  const doc = store.getState().document;
  const node = doc.nodes[id];
  if (node?.type !== "transform") return;
  const next = normalizedChannels(channels);
  if (
    ["position", "rotation", "scale"].every((key) => {
      const channel = key as keyof TransformChannels;
      return next[channel].every(
        (value, index) => Math.abs(value - node[channel][index]) < 1e-10,
      );
    })
  )
    return;
  store.setState({
    document: { ...doc, nodes: { ...doc.nodes, [id]: { ...node, ...next } } },
    editLabel: label,
  });
}

export function renameObject(store: SceneStore, id: string, requested: string) {
  const doc = store.getState().document;
  const node = doc.nodes[id];
  if (node?.type !== "transform") return;
  const name = uniqueName(doc, requested, node.parentId, id);
  if (name === node.name) return;
  store.setState({
    document: { ...doc, nodes: { ...doc.nodes, [id]: { ...node, name } } },
    editLabel: "Rename object",
  });
}
