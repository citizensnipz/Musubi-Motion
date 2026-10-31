import { describe, expect, it } from "vitest";
import { addSplat, emptyScene, deleteSceneItems } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { defaultAnimation, evaluateSceneAnimation, keyChannels, setKeys, setAnimationSettings } from "../src/animation.ts";
import { advanceFrame } from "../src/animation-playback.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";

describe("animation integration", () => {
  it("holds endpoints, wraps deterministically inside a signed range, and stops without looping", () => {
    const settings = { ...defaultAnimation(), start: -12, end: 12, fps: 24 };
    expect(advanceFrame(0, .5, settings)).toEqual({ frame: 12, stopped: false });
    expect(advanceFrame(12, .5, settings)).toEqual({ frame: 0, stopped: false });
    expect(advanceFrame(11.9, .01, settings).frame).toBeCloseTo(-11.86);
    expect(advanceFrame(12, 100, settings).frame).toBeLessThanOrEqual(12);
    expect(advanceFrame(0, 2, { ...settings, loop: false })).toEqual({ frame: 12, stopped: true });
  });

  it("persists animated FK transforms with extended playback times and rejects orphan curves", async () => {
    const doc = addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "Animated", [0, 0, 0], "object").document;
    doc.joints = [{ id: "root", name: "Root", parentId: null, position: [0,0,0] }, { id: "tip", name: "Tip", parentId: "root", position: [0,1,0] }];
    const store = createSceneStore(doc);
    setKeys(store, ["object", "root"], 0);
    const poses = evaluateSceneAnimation(doc, 0);
    poses.get("object")!.position[0] = 5;
    poses.get("root")!.rotation[2] = 720;
    setKeys(store, ["object", "root"], 480, poses);
    setAnimationSettings(store, { end: 960, fps: 24 });
    const saved = store.getState().document;
    const editor = { camera: { position: [3,2,8] as [number,number,number], target: [0,0,0] as [number,number,number], fov: 42, near: .01, far: 1000 }, time: 20 };
    const opened = await decodeProject(await encodeProject(saved, new Map(), editor));
    expect(opened.scene).toEqual(saved);
    expect(opened.editor.time).toBe(20);
    expect(evaluateSceneAnimation(opened.scene, 240).get("root")!.rotation[2]).toBe(360);
    const deleted = deleteSceneItems(saved, ["root"]);
    expect(deleted.joints).toEqual([]);
    expect(deleted.animation!.tracks.every(t => t.targetId === "object")).toBe(true);
    expect(() => validateScene(deleted)).not.toThrow();
    const bad = structuredClone(saved); bad.animation!.tracks[0].targetId = "missing";
    expect(() => validateScene(bad)).toThrow("target");
  });

  it("auto keys a pose and authored channels in one history entry, with deterministic scrubbing", () => {
    const doc = addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "Animated", [0,0,0], "object").document;
    const store = createSceneStore(doc);
    setKeys(store, ["object"], 0);
    const before = store.getState().document;
    const pose = evaluateSceneAnimation(before, 24).get("object")!;
    pose.position[0] = 4;
    const next = keyChannels(before, "object", pose, 24);
    store.setState({ document: next, editLabel: "Auto key pose" });
    const historyCount = store.temporal.getState().pastStates.length;
    for (let frame = 24; frame >= 0; frame--) evaluateSceneAnimation(next, frame);
    expect(store.temporal.getState().pastStates).toHaveLength(historyCount);
    expect(evaluateSceneAnimation(next, 12).get("object")!.position[0]).toBe(2);
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(before);
    store.temporal.getState().redo();
    expect(store.getState().document).toBe(next);
  });
});
