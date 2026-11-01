import { describe, expect, it } from "vitest";
import { addSplat, emptyScene, type SceneDocument } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { addAnimationLayer, removeAnimationLayer, reorderAnimationLayer, setActiveAnimationLayer, updateAnimationLayer } from "../src/animation-layers.ts";
import { copyKeys, defaultAnimation, deleteKeys, editingTracks, evaluateChannels, evaluateIKBlend, evaluateSceneAnimation, insertKey, keyChannels, moveKeys, pasteKeys, patchKeys, replaceTracks, scaleKeys, setAnimationSettings, setIKBlendKey, setKeys, validateAnimation, type AnimationChannel, type AnimationTrack, type CurveKey } from "../src/animation.ts";
import { decodeProject, encodeProject } from "../src/project-archive.ts";
import { validateDrivenKeys } from "../src/driven-keys.ts";

const key = (time: number, value: number): CurveKey => ({ id: crypto.randomUUID(), time, value, interpolation: "linear", tangentMode: "auto" });
const curve = (channel: AnimationChannel, value: number, layerId?: string, targetId = "object"): AnimationTrack => ({ id: crypto.randomUUID(), targetId, channel, keys: [key(0, value)], ...(layerId ? { layerId } : {}) });
function fixture() {
  const document = addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "Object", [2, 0, 0], "object", "shape").document;
  document.animation = defaultAnimation(); return createSceneStore(document);
}
function tracks(store: ReturnType<typeof fixture>, items: AnimationTrack[]) {
  const document = store.getState().document; store.setState({ document: { ...document, animation: { ...document.animation!, tracks: items } } });
}
function pose(store: ReturnType<typeof fixture>, frame = 0) { return evaluateChannels(store.getState().document, "object", frame); }

describe("animation layer evaluation", () => {
  it("mixes ordered additive offsets, scale factors and overrides without depending on track order", () => {
    const store = fixture(), add = addAnimationLayer(store, "Offset"), override = addAnimationLayer(store, "Override", "override");
    updateAnimationLayer(store, add, { weight: 0.5 }); updateAnimationLayer(store, override, { weight: 0.25 });
    tracks(store, [curve("position.x", 100, override), curve("position.x", 3, add), curve("scale.x", 3, add), curve("rotation.z", 40, add), curve("position.x", 10)]);
    expect(pose(store).position[0]).toBeCloseTo(33.625);
    expect(pose(store).scale[0]).toBe(2); expect(pose(store).rotation[2]).toBe(20);
    reorderAnimationLayer(store, override, 0); expect(pose(store).position[0]).toBe(34);
    const scene = evaluateSceneAnimation(store.getState().document, 0); expect(scene.get("object")).toEqual(pose(store));
  });
  it("passes through missing/empty curves and makes active selection irrelevant to playback", () => {
    const store = fixture(), add = addAnimationLayer(store, "Empty");
    tracks(store, [{ ...curve("position.x", 0, add), keys: [] }, curve("position.x", 15)]);
    expect(pose(store).position[0]).toBe(15);
    setActiveAnimationLayer(store); expect(pose(store).position[0]).toBe(15);
    expect(editingTracks(store.getState().document)).toHaveLength(1);
    setActiveAnimationLayer(store, add); expect(editingTracks(store.getState().document)).toHaveLength(1);
  });
  it("recompiles layer order, mute and weight revisions while reading changed authored fallback live", () => {
    const store = fixture(), first = addAnimationLayer(store, "First"), last = addAnimationLayer(store, "Last", "override");
    tracks(store, [curve("position.x", 4, first), curve("position.x", 20, last)]);
    expect(pose(store).position[0]).toBe(20); // compile and warm the index
    updateAnimationLayer(store, last, { weight: 0.5 }); expect(pose(store).position[0]).toBe(12);
    reorderAnimationLayer(store, last, 0); expect(pose(store).position[0]).toBe(14);
    updateAnimationLayer(store, last, { mute: true }); expect(pose(store).position[0]).toBe(4);
    const doc = store.getState().document, object = doc.nodes.object;
    if (object.type !== "transform") throw Error("fixture");
    const changed = { ...doc, nodes: { ...doc.nodes, object: { ...object, position: [10, 0, 0] as [number, number, number] } } };
    expect(changed.animation).toBe(doc.animation);
    expect(evaluateChannels(changed, "object", 0).position[0]).toBe(14);
    expect(evaluateChannels(doc, "object", 0).position[0]).toBe(4);
  });
  it("honors mute/solo with Base always below and lock affecting editing only", () => {
    const store = fixture(), a = addAnimationLayer(store, "A"), b = addAnimationLayer(store, "B");
    tracks(store, [curve("position.x", 10), curve("position.x", 2, a), curve("position.x", 5, b)]);
    updateAnimationLayer(store, a, { solo: true, locked: true }); expect(pose(store).position[0]).toBe(12);
    updateAnimationLayer(store, b, { solo: true }); expect(pose(store).position[0]).toBe(17);
    updateAnimationLayer(store, a, { mute: true }); expect(pose(store).position[0]).toBe(15);
    updateAnimationLayer(store, b, { solo: false }); expect(pose(store).position[0]).toBe(15);
  });
  it("uses override visibility on additive layers and clamps effective scale/blend only after mixing", () => {
    const store = fixture(), add = addAnimationLayer(store, "Add"); updateAnimationLayer(store, add, { weight: 0.5 });
    tracks(store, [curve("visibility", 0, add), curve("scale.x", -5, add)]);
    expect(pose(store).visibility).toBe(0.5); expect(pose(store).scale[0]).toBe(0.001);
    const doc = store.getState().document;
    doc.joints = [{ id: "root", name: "Root", parentId: null, position: [0, 0, 0] }, { id: "end", name: "End", parentId: "root", position: [1, 0, 0] }];
    doc.ikHandles = [{ id: "ik", name: "IK", rootId: "root", endId: "end", target: [1, 1, 0], enabled: true, iterations: 5, blend: 0.5 }];
    tracks(store, [curve("ik.blend", 3, add, "ik")]); expect(evaluateIKBlend(store.getState().document, "ik", 0)).toBe(1);
    setIKBlendKey(store, "ik", 1, 0.25);
    expect(evaluateIKBlend(store.getState().document, "ik", 1)).toBeCloseTo(0.25);
    expect(editingTracks(store.getState().document)[0].keys.at(-1)!.value).toBeCloseTo(-0.5);
  });
});

describe("animation layer editing", () => {
  it("inverts additive and later weighted override contributions when keying final poses", () => {
    const store = fixture(), a = addAnimationLayer(store, "A"), b = addAnimationLayer(store, "B", "override");
    updateAnimationLayer(store, a, { weight: 0.5 }); updateAnimationLayer(store, b, { weight: 0.25 });
    tracks(store, [curve("position.x", 10), curve("position.x", 100, b)]); setActiveAnimationLayer(store, a);
    setKeys(store, ["object"], 2, new Map([["object", { ...pose(store), position: [40, 0, 0] }]]), ["position.x"]);
    expect(editingTracks(store.getState().document)[0].keys[0].value).toBeCloseTo(20);
    expect(pose(store, 2).position[0]).toBeCloseTo(40);
    setActiveAnimationLayer(store); setKeys(store, ["object"], 2, new Map([["object", { ...pose(store), position: [43, 0, 0] }]]), ["position.x"]);
    expect(pose(store, 2).position[0]).toBeCloseTo(43);
  });
  it("inverts multiplicative scale and a weighted override layer", () => {
    const store = fixture(), add = addAnimationLayer(store, "Scale"); updateAnimationLayer(store, add, { weight: 0.25 });
    setKeys(store, ["object"], 0, new Map([["object", { ...pose(store), scale: [2, 1, 1] }]]), ["scale.x"]);
    expect(editingTracks(store.getState().document)[0].keys[0].value).toBe(5); expect(pose(store).scale[0]).toBe(2);
    const override = addAnimationLayer(store, "Override", "override"); updateAnimationLayer(store, override, { weight: 0.5 });
    setKeys(store, ["object"], 0, new Map([["object", { ...pose(store), position: [6, 0, 0] }]]), ["position.x"]);
    expect(editingTracks(store.getState().document)[0].keys[0].value).toBe(12); expect(pose(store).position[0]).toBe(6);
  });
  it("auto-keys only existing channels in the active layer and leaves other layers intact", () => {
    const store = fixture(); tracks(store, [curve("position.x", 10)]); const add = addAnimationLayer(store, "Add");
    const doc = store.getState().document;
    expect(keyChannels(doc, "object", { ...pose(store), position: [20, 0, 0] }, 5)).toBe(doc);
    setKeys(store, ["object"], 0, undefined, ["position.x"]);
    const next = keyChannels(store.getState().document, "object", { ...pose(store), position: [20, 0, 0] }, 5);
    expect(next.animation!.tracks.find(track => track.layerId === add)!.keys.at(-1)!.value).toBe(10);
    expect(next.animation!.tracks.find(track => !track.layerId)!.keys).toHaveLength(1);
  });
  it("rejects final-pose keying on muted, zero-weight, excluded-solo or masked layers atomically", () => {
    const store = fixture(), a = addAnimationLayer(store, "A"), b = addAnimationLayer(store, "B", "override");
    tracks(store, [curve("position.x", 10, b)]); setActiveAnimationLayer(store, a);
    const attempt = () => setKeys(store, ["object"], 0, undefined, ["position.x"]);
    expect(attempt).toThrow(/masked|influence/i);
    updateAnimationLayer(store, b, { mute: true }); updateAnimationLayer(store, a, { mute: true }); expect(attempt).toThrow(/muted|influence/i);
    updateAnimationLayer(store, a, { mute: false, weight: 0 }); expect(attempt).toThrow(/weight|influence/i);
    updateAnimationLayer(store, a, { weight: 1 }); updateAnimationLayer(store, b, { mute: false, solo: true }); expect(attempt).toThrow(/solo|influence/i);
    expect(editingTracks(store.getState().document)).toHaveLength(0);
  });
  it("scopes key edits and copy/paste to the active layer and preserves owner metadata", () => {
    const store = fixture(), base = curve("position.x", 3); tracks(store, [base]);
    const clipboard = copyKeys(store.getState().document, [base.keys[0].id]), add = addAnimationLayer(store, "Add");
    const pasted = pasteKeys(store, clipboard, 5); expect(editingTracks(store.getState().document)[0].layerId).toBe(add);
    moveKeys(store, pasted, 2, 1); scaleKeys(store, pasted, 2, 0); patchKeys(store, pasted, { interpolation: "step" });
    expect(editingTracks(store.getState().document)[0].keys[0]).toMatchObject({ time: 14, value: 4, interpolation: "step" });
    expect(() => moveKeys(store, [base.keys[0].id], 1)).toThrow(/active layer/i);
    expect(() => insertKey(store, base.id, 2)).toThrow(/active layer/i);
    expect(() => replaceTracks(store, [{ ...editingTracks(store.getState().document)[0], layerId: undefined }])).toThrow(/layer/i);
    deleteKeys(store, pasted); expect(editingTracks(store.getState().document)).toHaveLength(0);
    expect(store.getState().document.animation!.tracks[0]).toEqual(base);
  });
  it("locks all key editing operations while retaining layer management/unlock", () => {
    const store = fixture(), id = addAnimationLayer(store, "Locked"), track = curve("position.x", 1, id); tracks(store, [track]);
    updateAnimationLayer(store, id, { locked: true });
    for (const action of [() => setKeys(store, ["object"], 1), () => patchKeys(store, [track.keys[0].id], { value: 2 }), () => deleteKeys(store, [track.keys[0].id]), () => removeAnimationLayer(store, id)]) expect(action).toThrow(/locked|unlock/i);
    updateAnimationLayer(store, id, { locked: false }); removeAnimationLayer(store, id);
    expect(store.getState().document.animation!.activeLayerId).toBeUndefined(); expect(store.getState().document.animation!.tracks).toHaveLength(0);
  });
  it("solves every editable point in mixed layer stacks and retains authored Euler turns", () => {
    for (const channel of ["position.x", "rotation.z", "scale.x", "visibility"] as const) {
      const store = fixture(), a = addAnimationLayer(store, "A"), b = addAnimationLayer(store, "B", "override"), c = addAnimationLayer(store, "C");
      updateAnimationLayer(store, a, { weight: 0.4 }); updateAnimationLayer(store, b, { weight: 0.3 }); updateAnimationLayer(store, c, { weight: 0.6 });
      tracks(store, [curve(channel, 1), curve(channel, 2, a), curve(channel, 0.3, b), curve(channel, 0.8, c)]);
      for (const active of [undefined, a, b, c]) {
        if (channel === "visibility" && active === undefined) continue; // Base visibility remains discrete for legacy scene compatibility.
        setActiveAnimationLayer(store, active);
        const desired = channel === "visibility" ? 0.75 : channel === "rotation.z" ? 720 : 3;
        const current = pose(store), next = { ...current, position: [...current.position], rotation: [...current.rotation], scale: [...current.scale] };
        if (channel === "visibility") next.visibility = desired;
        else { const [property, axis] = channel.split(".") as ["position" | "rotation" | "scale", string]; next[property]["xyz".indexOf(axis)] = desired; }
        setKeys(store, ["object"], 4, new Map([["object", next as typeof current]]), [channel]);
        const actual = pose(store, 4);
        if (channel === "visibility") expect(actual.visibility).toBeCloseTo(desired, 10);
        else { const [property, axis] = channel.split(".") as ["position" | "rotation" | "scale", string]; expect(actual[property]["xyz".indexOf(axis)]).toBeCloseTo(desired, 10); }
      }
    }
  });
  it("deleting active keys preserves empty curves in other layers", () => {
    const store = fixture(), base = { ...curve("position.x", 0), keys: [] }, id = addAnimationLayer(store, "A"), active = curve("position.x", 2, id);
    tracks(store, [base, active]); deleteKeys(store, [active.keys[0].id]);
    expect(store.getState().document.animation!.tracks).toEqual([base]);
  });
  it("rejects impossible discrete Base visibility inversions rather than silently keying the wrong result", () => {
    const store = fixture(), layer = addAnimationLayer(store, "Visibility"); updateAnimationLayer(store, layer, { weight: 0.5 });
    tracks(store, [curve("visibility", 0, layer)]); setActiveAnimationLayer(store);
    const before = store.getState().document;
    expect(() => setKeys(store, ["object"], 0, new Map([["object", { ...pose(store), visibility: 0.75 }]]), ["visibility"])).toThrow(/discrete/);
    expect(store.getState().document).toBe(before);
  });
  it("validates management, preserves undo/redo and skips no-ops", () => {
    const store = fixture(), before = store.getState().document, id = addAnimationLayer(store, " A ", "override");
    expect(store.getState().document.animation!.layers![0].name).toBe("A");
    const count = store.temporal.getState().pastStates.length; updateAnimationLayer(store, id, { weight: 1 }); setActiveAnimationLayer(store, id); expect(store.temporal.getState().pastStates).toHaveLength(count);
    store.temporal.getState().undo(); expect(store.getState().document).toBe(before);
    store.temporal.getState().redo(); expect(store.getState().document.animation!.activeLayerId).toBe(id);
    for (const action of [() => updateAnimationLayer(store, id, { weight: NaN }), () => updateAnimationLayer(store, id, { name: "" }), () => setActiveAnimationLayer(store, "missing"), () => reorderAnimationLayer(store, id, 1)]) expect(action).toThrow();
    expect(store.temporal.getState().pastStates).toHaveLength(count);
    expect(() => setAnimationSettings(store, { activeLayerId: id } as never)).toThrow(/setting/i);
  });
});

describe("animation layer validation and persistence", () => {
  it("allows duplicate channels across layers while rejecting duplicates within a layer and missing references", () => {
    const store = fixture(), id = addAnimationLayer(store, "A"); tracks(store, [curve("position.x", 1), curve("position.x", 2, id)]);
    const doc = store.getState().document; expect(() => validateAnimation(doc.animation, doc)).not.toThrow();
    const invalid = structuredClone(doc); invalid.animation!.tracks.push(curve("position.x", 3, id)); expect(() => validateAnimation(invalid.animation, invalid)).toThrow(/Duplicate/);
    invalid.animation!.tracks.pop(); invalid.animation!.tracks[1].layerId = "missing"; expect(() => validateAnimation(invalid.animation, invalid)).toThrow(/layer/i);
  });
  it("reserves SDK outputs even when their time layer is muted and weight zero", () => {
    const store = fixture(), id = addAnimationLayer(store, "A"); updateAnimationLayer(store, id, { mute: true, weight: 0 });
    tracks(store, [curve("rotation.x", 10, id)]);
    const doc = store.getState().document;
    const sdk = [{ id: "sdk", driver: { targetId: "object", channel: "position.x" as const }, driven: { targetId: "object", channel: "rotation.x" as const }, keys: [key(0, 5)] }];
    expect(() => validateDrivenKeys(sdk, doc)).toThrow(/time keys/);
    expect(() => validateAnimation(doc.animation, { ...doc, drivenKeys: sdk })).toThrow(/driven keys/);
  });
  it("round-trips every layer setting, active selection, curves and composite evaluation through MSB", async () => {
    const store = fixture(), a = addAnimationLayer(store, "Offset"), b = addAnimationLayer(store, "Override", "override");
    updateAnimationLayer(store, a, { weight: 0.4, solo: true, locked: true }); updateAnimationLayer(store, b, { mute: true });
    tracks(store, [curve("rotation.z", 720), curve("rotation.z", 30, a), curve("position.x", 8, b)]);
    const doc = store.getState().document;
    const bytes = await encodeProject(doc, new Map(), { camera: { position: [3, 2, 8], target: [0, 0, 0], fov: 42, near: 0.01, far: 1000 }, time: 0 });
    const loaded = (await decodeProject(bytes)).scene; expect(loaded).toEqual(doc); expect(evaluateSceneAnimation(loaded, 2)).toEqual(evaluateSceneAnimation(doc, 2));
  });
  it("rejects malformed layer metadata before accepting an archive scene", () => {
    const store = fixture(), id = addAnimationLayer(store, "A"), original = store.getState().document;
    for (const mutate of [(doc: SceneDocument) => doc.animation!.layers![0].weight = Infinity,
      (doc: SceneDocument) => doc.animation!.layers!.push({ ...doc.animation!.layers![0] }),
      (doc: SceneDocument) => doc.animation!.activeLayerId = "missing",
      (doc: SceneDocument) => doc.animation!.layers![0].id = "constructor"]) {
      const doc = structuredClone(original); mutate(doc); expect(() => validateAnimation(doc.animation, doc)).toThrow();
    }
    expect(id).toBeTruthy();
  });
});
