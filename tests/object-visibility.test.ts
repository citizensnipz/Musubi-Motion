import { expect, it } from "vitest";
import { createSceneStore, setObjectVisibility } from "../src/scene-store";
import { createMeshPrimitive } from "../src/mesh-modeling";
import { evaluateChannels, defaultAnimation } from "../src/animation";
import { decodeProjectBlob, encodeProjectBlob, validateScene } from "../src/project-archive";

const editor = { camera: { position: [0, 0, 5] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 45, near: .01, far: 1000 }, time: 0 };
it("hides one object without changing its skeleton, other parts, or animated visibility; undo/redo restores the override", () => {
  const store = createSceneStore(), legs = createMeshPrimitive(store, "cube"), torso = createMeshPrimitive(store, "cube");
  const doc = store.getState().document;
  const animation = defaultAnimation();
  store.setState({ document: { ...doc, animation }, editLabel: "Setup animation" });
  store.temporal.getState().clear();
  const before = store.getState().document;
  setObjectVisibility(store, legs, false);
  const after = store.getState().document;
  expect(after.nodes[legs]).toMatchObject({ hidden: true });
  expect(after.nodes[torso]).toBe(before.nodes[torso]);
  expect(after.animation).toBe(before.animation);
  expect(evaluateChannels(after, legs, 0).visibility).toBe(1);
  expect(store.getState().editLabel).toBe("Hide object");
  setObjectVisibility(store, legs, false);
  expect(store.temporal.getState().pastStates).toHaveLength(1);
  store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
  store.temporal.getState().redo(); expect(store.getState().document).toBe(after);
  setObjectVisibility(store, legs, true); expect(store.getState().document.nodes[legs]).toMatchObject({ hidden: false });
});
it("round trips hidden objects without adding animation keys and rejects malformed visibility flags", async () => {
  const store = createSceneStore(), id = createMeshPrimitive(store, "cube");
  setObjectVisibility(store, id, false);
  const doc = store.getState().document;
  expect(doc.animation).toBeUndefined();
  const reopened = await decodeProjectBlob(await encodeProjectBlob(doc, new Map(), editor));
  expect(reopened.scene).toEqual(doc);
  expect(() => validateScene({ ...doc, nodes: { ...doc.nodes, [id]: { ...doc.nodes[id], hidden: "false" } } })).toThrow(/visibility/);
});
