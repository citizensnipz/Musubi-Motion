import { describe, expect, it } from "vitest";
import {
  addSplat,
  emptyScene,
  normalizedChannels,
  serializeScene,
  transformNodes,
  uniqueName,
} from "../src/scene-document.ts";
import {
  commitChannels,
  createSceneStore,
  renameObject,
} from "../src/scene-store.ts";

const asset = () => ({
  id: crypto.randomUUID(),
  kind: "procedural" as const,
  generator: "knot-v1" as const,
});
const fixture = () => addSplat(emptyScene(), asset(), "knot", [-1, -2, -3]);

describe("scene document and edit history", () => {
  it("stores stable IDs, transform/shape relationships and asset references as plain data", () => {
    const { document, id } = fixture();
    const shape = Object.values(document.nodes).find(
      (node) => node.type === "splatShape",
    )!;
    expect(document.rootIds).toEqual([id]);
    expect(shape.parentId).toBe(id);
    expect(
      shape.type === "splatShape" && document.assets[shape.assetId].kind,
    ).toBe("procedural");
    expect(shape.type === "splatShape" && shape.offset).toEqual([-1, -2, -3]);
    expect(JSON.parse(serializeScene(document))).toEqual(document);
  });
  it("keeps sibling names unique without changing identity on rename", () => {
    const first = fixture();
    const second = addSplat(first.document, asset(), "knot", [0, 0, 0]);
    const store = createSceneStore(second.document);
    expect(store.getState().document.nodes[second.id].name).toBe("knot1");
    renameObject(store, second.id, "knot");
    expect(store.getState().document.nodes[second.id].name).toBe("knot1");
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    renameObject(store, first.id, "hero");
    expect(store.getState().document.nodes[first.id].id).toBe(first.id);
    store.temporal.getState().undo();
    expect(store.getState().document.nodes[first.id].name).toBe("knot");
    expect(uniqueName(first.document, "knot", "another-parent")).toBe("knot");
  });
  it("records one completed transform and restores all channels atomically", () => {
    const { document, id } = fixture();
    const store = createSceneStore(document);
    const next = {
      position: [3, 2, 1],
      rotation: [30, 60, 90],
      scale: [1.8, 0.6, 1.3],
    } as const;
    commitChannels(store, id, {
      position: [...next.position],
      rotation: [...next.rotation],
      scale: [...next.scale],
    });
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    expect(store.getState().document.nodes[id]).toMatchObject(next);
    expect(document.nodes[id]).toMatchObject({
      position: [0, 0, 0],
      scale: [1, 1, 1],
    });
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(document);
    store.temporal.getState().redo();
    expect(store.getState().document.nodes[id]).toMatchObject(next);
  });
  it("ignores no-op transforms and branches redo only for real edits", () => {
    const { document, id } = fixture();
    const store = createSceneStore(document);
    renameObject(store, id, "renamed");
    store.temporal.getState().undo();
    commitChannels(store, id, {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(store.temporal.getState().futureStates).toHaveLength(1);
    renameObject(store, id, "new-branch");
    expect(store.temporal.getState().futureStates).toHaveLength(0);
  });
  it("undoes and redoes imports without duplicating asset references", () => {
    const first = fixture(),
      store = createSceneStore(first.document);
    const next = addSplat(first.document, asset(), "knot", [0, 0, 0]);
    store.setState({ document: next.document, editLabel: "Import object" });
    expect(transformNodes(store.getState().document)).toHaveLength(2);
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(first.document);
    store.temporal.getState().redo();
    expect(store.getState().document).toBe(next.document);
    expect(store.getState().document.assets).toBe(next.document.assets);
  });
  it("validates channels, clamps singular or mirrored scales, and bounds history", () => {
    expect(
      normalizedChannels({
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [0, -1, 2],
      }).scale,
    ).toEqual([0.001, 0.001, 2]);
    expect(() =>
      normalizedChannels({
        position: [NaN, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      }),
    ).toThrow();
    const { document, id } = fixture(),
      store = createSceneStore(document);
    for (let i = 1; i <= 105; i++) renameObject(store, id, `object${i}`);
    expect(store.temporal.getState().pastStates).toHaveLength(100);
  });
});
