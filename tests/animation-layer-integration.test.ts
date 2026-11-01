import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { defaultAnimation, evaluateChannels, evaluateSceneAnimation, type AnimationTrack } from "../src/animation.ts";
import { addAnimationLayer, updateAnimationLayer } from "../src/animation-layers.ts";
import { prepareJointAnimationEdit, prepareTransformAnimationEdit } from "../src/animation-edit.ts";
import { createConstraint } from "../src/constraints.ts";
import { setDrivenKey } from "../src/driven-keys.ts";
import { createParticlePoseSampler } from "../src/particle-pose-sampler.ts";
import { emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function curve(targetId: string, channel: AnimationTrack["channel"], a: number, b: number, layerId?: string): AnimationTrack {
  return { id: crypto.randomUUID(), targetId, channel, ...(layerId ? { layerId } : {}), keys: [a, b].map((value, index) => ({ id: crypto.randomUUID(), time: index * 10, value, interpolation: "linear", tangentMode: "auto" })) };
}
describe("animation layers across editor and historical boundaries", () => {
  it("auto-keying a layered joint pose preserves its authored fallback and other animation frames", () => {
    const doc = emptyScene(); doc.joints = [{ id: "joint", name: "Joint", parentId: null, position: [0, 0, 0], rotation: [0, 0, 10] }];
    doc.animation = defaultAnimation();
    const store = createSceneStore(doc), layer = addAnimationLayer(store, "Offset");
    const source = { ...store.getState().document, animation: { ...store.getState().document.animation!, tracks: [curve("joint", "rotation.z", 2, 4, layer)] } };
    const result = prepareJointAnimationEdit(source, [{ ...source.joints![0], rotation: [0, 0, 20] }], "Rotate selected joints", 5, true, id => evaluateChannels(source, id, 5));
    expect(result.document.joints![0].rotation).toEqual([0, 0, 10]);
    expect(evaluateChannels(result.document, "joint", 5).rotation[2]).toBeCloseTo(20);
    expect(evaluateChannels(result.document, "joint", 0).rotation[2]).toBeCloseTo(12);
    expect(evaluateChannels(result.document, "joint", 10).rotation[2]).toBeCloseTo(14);
  });
  it("unkeyed layered joint posing stays a draft rather than changing the layer fallback", () => {
    const doc = emptyScene(); doc.joints = [{ id: "joint", name: "Joint", parentId: null, position: [1, 0, 0], rotation: [0, 0, 10] }];
    const store = createSceneStore(doc); addAnimationLayer(store, "Posing");
    const source = store.getState().document;
    const result = prepareJointAnimationEdit(source, [{ ...source.joints![0], position: [8, 0, 0] }], "Move joint", 5, false, id => evaluateChannels(source, id, 5));
    expect(result.document.joints).toEqual(source.joints);
    expect(result.overrides.get("joint")!.position).toEqual([8, 0, 0]);
  });
  it("layered object keying preserves authored fallback and rejects locked edits atomically", () => {
    const doc = emptyScene();
    doc.nodes.object = { id: "object", type: "transform", name: "Object", parentId: null, position: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" }; doc.rootIds.push("object");
    const store = createSceneStore(doc), layer = addAnimationLayer(store, "Offset");
    const source = { ...store.getState().document, animation: { ...store.getState().document.animation!, tracks: [curve("object", "position.x", 2, 4, layer)] } };
    const requested = { ...evaluateChannels(source, "object", 5), position: [20, 0, 0] as [number, number, number] };
    const result = prepareTransformAnimationEdit(source, "object", requested, 5, true);
    expect(result.nodes).toBe(source.nodes);
    expect(evaluateChannels(result, "object", 5).position[0]).toBeCloseTo(20);
    expect(evaluateChannels(result, "object", 0).position[0]).toBeCloseTo(12);
    expect(evaluateChannels(result, "object", 10).position[0]).toBeCloseTo(14);
    expect(prepareTransformAnimationEdit(source, "object", requested, 5, false).nodes).toBe(source.nodes);
    store.setState({ document: source }); updateAnimationLayer(store, layer, { locked: true });
    const locked = store.getState().document;
    expect(() => prepareTransformAnimationEdit(locked, "object", requested, 5, true)).toThrow(/locked/);
    expect(store.getState().document).toBe(locked);
  });
  it("historical SDK and constraint samples use the composited driver at fractional frames", () => {
    const doc = emptyScene();
    for (const id of ["driver", "control", "emitter"]) {
      doc.nodes[id] = { id, type: "transform", name: id, parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
      doc.rootIds.push(id);
    }
    const store = createSceneStore(doc), layer = addAnimationLayer(store, "Driver offset"); updateAnimationLayer(store, layer, { weight: .5 });
    const original = store.getState().document;
    store.setState({ document: { ...original, animation: { ...original.animation!, tracks: [curve("driver", "position.x", 0, .5), curve("driver", "position.x", .2, .4, layer)] } } });
    setDrivenKey(store, { targetId: "driver", channel: "position.x" }, { targetId: "control", channel: "position.x" }, 0, 0);
    setDrivenKey(store, { targetId: "driver", channel: "position.x" }, { targetId: "control", channel: "position.x" }, 1, 10);
    createConstraint(store, "point", "control", "emitter", false);
    const source = store.getState().document, sampler = createParticlePoseSampler(source);
    for (const frame of [10, .25, 7.125, 0, 5]) {
      const expectedDriver = .1 + .06 * frame;
      expect(evaluateSceneAnimation(source, frame).get("driver")!.position[0]).toBeCloseTo(expectedDriver);
      const position = new Vector3().setFromMatrixPosition(sampler.worldAt(frame).get("emitter")!);
      expect(position.x).toBeCloseTo(expectedDriver * 10);
    }
  });
});
