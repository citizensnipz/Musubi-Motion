import { describe, expect, it } from "vitest";
import { defaultAnimation } from "../src/animation.ts";
import { createMeshPrimitive, findMeshShape } from "../src/mesh-modeling.ts";
import { createParticleEmitter, defaultParticleSettings, findParticleShape, potentialParticleCount, updateParticleEmitter, validateParticleEmitters, validateParticleShape } from "../src/particle-emitter.ts";
import { deleteSceneItems, type TransformNode } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture() {
  const store = createSceneStore(), id = createParticleEmitter(store, "omni"), shape = findParticleShape(store.getState().document, id)!;
  return { store, id, shape };
}

describe("authored particle emitter settings", () => {
  it("creates documented defaults as an ordinary transform with one undo entry", () => {
    const store = createSceneStore(), before = store.getState().document;
    const id = createParticleEmitter(store, "directional", { name: "Trail", position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 3, 4] });
    const doc = store.getState().document, shape = findParticleShape(doc, id)!;
    expect(shape).toMatchObject({ ...defaultParticleSettings(), emission: "directional", parentId: id, name: "TrailShape" });
    expect(doc.nodes[id]).toMatchObject({ name: "Trail", parentId: null, position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 3, 4] });
    expect(doc.assets).toEqual({}); expect(findParticleShape(doc, shape.id)).toBe(shape);
    expect(store.temporal.getState().pastStates).toHaveLength(1); store.temporal.getState().undo(); expect(store.getState().document).toBe(before); store.temporal.getState().redo(); expect(store.getState().document).toBe(doc);
    const next = createParticleEmitter(store, "sphere", { name: "Trail" }); expect(store.getState().document.nodes[next].name).toBe("Trail1");
    expect(defaultParticleSettings()).not.toBe(defaultParticleSettings());
  });
  it("parents surface emitters to their source mesh with local identity and persistent references", () => {
    const store = createSceneStore(), mesh = createMeshPrimitive(store, "cube", { position: [3, 4, 5], rotation: [0, 30, 0], scale: [2, 2, 2] });
    const source = findMeshShape(store.getState().document, mesh)!, id = createParticleEmitter(store, "surface", { surfaceId: source.id });
    const doc = store.getState().document, shape = findParticleShape(doc, id)!;
    expect(doc.nodes[id]).toMatchObject({ parentId: mesh, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }); expect(doc.rootIds).not.toContain(id);
    expect(shape.surfaceId).toBe(source.id); updateParticleEmitter(store, shape.id, { emission: "box" });
    expect(findParticleShape(store.getState().document, id)!.surfaceId).toBe(source.id);
    updateParticleEmitter(store, shape.id, { emission: "surface" }); expect(() => validateParticleEmitters(store.getState().document)).not.toThrow();
    const deleted = deleteSceneItems(store.getState().document, [mesh]); expect(findParticleShape(deleted, id)).toBeUndefined(); expect(deleted.nodes).toEqual({});
  });
  it("commits complete settings atomically, copies nested values and preserves no-op identity", () => {
    const { store, shape } = fixture(), before = store.getState().document;
    const patch = { speed: 5, speedRandom: 12, sizes: [0.1, 0] as [number, number], turbulence: { strength: 3, scale: 2 }, attraction: { position: [2, 3, 4] as [number, number, number], strength: -2, radius: 4 } };
    updateParticleEmitter(store, shape.id, patch); const doc = store.getState().document, changed = findParticleShape(doc, shape.id)!;
    expect(changed).toMatchObject(patch); patch.attraction.position[0] = 99; expect(changed.attraction.position[0]).toBe(2);
    updateParticleEmitter(store, shape.id, { speed: 5 }); expect(store.getState().document).toBe(doc);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before); store.temporal.getState().redo(); expect(store.getState().document).toBe(doc);
  });
  it("rejects retargeting, missing surface references and broken source-parent relationships", () => {
    const { store, shape } = fixture(), before = store.getState().document;
    expect(() => createParticleEmitter(store, "surface")).toThrow(/polygon mesh/);
    expect(() => createParticleEmitter(store, "surface", { surfaceId: shape.id })).toThrow(/mesh shape ID/);
    expect(() => updateParticleEmitter(store, shape.id, { emission: "surface" })).toThrow(/mesh source/);
    for (const patch of [{ surfaceId: "other" }, { parentId: "other" }, { id: "other" }, { name: "renamed" }]) expect(() => updateParticleEmitter(store, shape.id, patch as any)).toThrow(/cannot be retargeted/);
    expect(store.getState().document).toBe(before);
    const mesh = createMeshPrimitive(store, "plane"), source = findMeshShape(store.getState().document, mesh)!, emitter = createParticleEmitter(store, "surface", { surfaceId: source.id });
    const doc = store.getState().document, broken = { ...doc, nodes: { ...doc.nodes, [emitter]: { ...doc.nodes[emitter], parentId: null } as TransformNode } };
    expect(() => validateParticleEmitters(broken)).toThrow(/remain parented/);
    const missing = { ...doc, nodes: { ...doc.nodes } }; delete missing.nodes[source.id]; expect(() => validateParticleEmitters(missing)).toThrow(/existing polygon mesh/);
  });
  it("accepts zero rate, seed endpoints, negative frames, zero end size and negative attraction", () => {
    const { store, shape } = fixture();
    updateParticleEmitter(store, shape.id, { rate: 0, seed: 0, startFrame: -100, endFrame: 0, sizes: [0, 0], attraction: { position: [0, 0, 0], strength: -10000, radius: 1 } });
    expect(potentialParticleCount(findParticleShape(store.getState().document, shape.id)!)).toBe(1);
    updateParticleEmitter(store, shape.id, { seed: 0xffffffff, lifetime: 60, speedRandom: 10000 });
    expect(() => validateParticleEmitters(store.getState().document)).not.toThrow();
  });
  it("rejects malformed structural data and rolls back complete setting edits", () => {
    const { store, shape } = fixture(), before = store.getState().document;
    const mutations: Array<(value: any) => void> = [
      value => value.id = "__proto__", value => value.parentId = "", value => value.name = "", value => value.type = "other", value => value.enabled = 1,
      value => value.emission = "unknown", value => value.rate = -1, value => value.rate = 10001, value => value.lifetime = 0, value => value.lifetime = 61,
      value => value.startFrame = 0.5, value => value.endFrame = -1, value => value.endFrame = 100001, value => value.seed = -1, value => value.seed = 0x100000000,
      value => value.speed = Infinity, value => value.speedRandom = -1, value => value.spread = 1.1, value => value.direction = [0, 0, 0], value => value.volume = [1, 0, 1],
      value => value.acceleration[0] = 100001, value => value.drag = NaN, value => value.sizes = [1], value => value.sizes[1] = -1,
      value => value.colors[0] = "red", value => value.opacities[0] = 1.1, value => value.turbulence.scale = 0,
      value => value.attraction.radius = 0, value => value.attraction.position[0] = Infinity, value => value.attraction.strength = 10001,
    ];
    for (const mutate of mutations) { const invalid = structuredClone(shape); mutate(invalid); expect(() => validateParticleShape(invalid)).toThrow(); }
    expect(() => updateParticleEmitter(store, shape.id, { speed: 7, lifetime: 0 })).toThrow(); expect(store.getState().document).toBe(before);
    const restored = JSON.parse(JSON.stringify(shape)); expect(() => validateParticleShape(restored)).not.toThrow(); expect(restored).toEqual(shape);
  });
});

describe("particle emitter scene budgets", () => {
  it("enforces the fixed-step live-particle allowance per emitter", () => {
    const { store, shape } = fixture(); updateParticleEmitter(store, shape.id, { rate: 9999, lifetime: 1.99 });
    expect(potentialParticleCount(findParticleShape(store.getState().document, shape.id)!)).toBeLessThanOrEqual(20000);
    const before = store.getState().document;
    expect(() => updateParticleEmitter(store, shape.id, { rate: 10000, lifetime: 2 })).toThrow(/20,000/); expect(store.getState().document).toBe(before);
    expect(() => updateParticleEmitter(store, shape.id, { enabled: false, rate: 10000, lifetime: 2 })).toThrow(/20,000/);
  });
  it("enforces the combined live budget and emitter count without partial creation", () => {
    const store = createSceneStore();
    for (let index = 0; index < 5; index++) { const id = createParticleEmitter(store, "omni"); updateParticleEmitter(store, findParticleShape(store.getState().document, id)!.id, { rate: 9900, lifetime: 1.99 }); }
    const id = createParticleEmitter(store, "box"), shape = findParticleShape(store.getState().document, id)!, before = store.getState().document;
    expect(() => updateParticleEmitter(store, shape.id, { rate: 9999, lifetime: 1.99 })).toThrow(/100,000/); expect(store.getState().document).toBe(before);
    const many = createSceneStore(); for (let index = 0; index < 32; index++) createParticleEmitter(many, "omni");
    const last = many.getState().document; expect(() => createParticleEmitter(many, "omni")).toThrow(/32/); expect(many.getState().document).toBe(last);
  });
  it("uses document FPS for the 300-second emission duration limit", () => {
    const { store, shape } = fixture(); updateParticleEmitter(store, shape.id, { startFrame: -3600, endFrame: 3600 });
    const before = store.getState().document;
    expect(() => updateParticleEmitter(store, shape.id, { endFrame: 3601 })).toThrow(/300 seconds/); expect(store.getState().document).toBe(before);
    expect(() => validateParticleEmitters({ ...before, animation: { ...defaultAnimation(), fps: 12 } })).toThrow(/300 seconds/);
    expect(() => validateParticleEmitters({ ...before, animation: { ...defaultAnimation(), fps: 48 } })).not.toThrow();
    expect(() => validateParticleEmitters({ ...before, animation: { ...defaultAnimation(), fps: 0 } })).toThrow(/FPS/);
  });
  it("retains surface cross-reference checks even while emitting in another mode", () => {
    const store = createSceneStore(), mesh = createMeshPrimitive(store, "cube"), source = findMeshShape(store.getState().document, mesh)!;
    const id = createParticleEmitter(store, "surface", { surfaceId: source.id }), shape = findParticleShape(store.getState().document, id)!;
    updateParticleEmitter(store, shape.id, { emission: "omni", enabled: false });
    const doc = store.getState().document, invalid = { ...doc, nodes: { ...doc.nodes } }; delete invalid.nodes[source.id];
    expect(() => validateParticleEmitters(invalid)).toThrow(/existing polygon mesh/);
    const emptySurface = { ...doc, nodes: { ...doc.nodes, [source.id]: { ...source, vertices: [], faces: [] } } };
    expect(() => validateParticleEmitters(emptySurface)).not.toThrow();
  });
});
