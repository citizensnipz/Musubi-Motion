import { describe, expect, it } from "vitest";
import { addSplat, emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { evaluateChannels, setKeys, type AnimationPose } from "../src/animation.ts";

function fixture() {
  const doc = addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "object", [0,0,0], "object", "shape").document;
  doc.joints = [{ id: "joint", name: "joint", parentId: null, position: [0,1,0] }];
  return createSceneStore(doc);
}
const pose = (): AnimationPose => ({ position: [3,4,5], rotation: [10,20,30], scale: [2,3,4], visibility: 1 });

describe("Channel Box key commands", () => {
  it("keys one explicit channel from the evaluated pose without keying its neighbors", () => {
    const store = fixture(), evaluated = pose();
    setKeys(store,["object"],12,new Map([["object",evaluated]]),["rotation.y"]);
    const tracks = store.getState().document.animation!.tracks;
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ targetId:"object", channel:"rotation.y", keys:[{time:12,value:20}] });
    expect(evaluateChannels(store.getState().document,"object",12).position).toEqual([0,0,0]);
    expect(evaluated).toEqual(pose());
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo();
    expect(store.getState().document.animation).toBeUndefined();
    store.temporal.getState().redo();
    expect(evaluateChannels(store.getState().document,"object",12).rotation[1]).toBe(20);
  });
  it("keys visible and hidden states at exact frame boundaries independently of transforms", () => {
    const store = fixture(), evaluated = pose();
    setKeys(store,["object"],0,new Map([["object",evaluated]]),["visibility"]);
    setKeys(store,["object"],24,new Map([["object",{...evaluated,visibility:0}]]),["visibility"]);
    expect(store.getState().document.animation!.tracks).toHaveLength(1);
    expect(evaluateChannels(store.getState().document,"object",23.999).visibility).toBe(1);
    expect(evaluateChannels(store.getState().document,"object",24).visibility).toBe(0);
    expect(evaluateChannels(store.getState().document,"object",24).scale).toEqual([1,1,1]);
    store.temporal.getState().undo();
    expect(evaluateChannels(store.getState().document,"object",24).visibility).toBe(1);
  });
  it("supports joint rotation and visibility while rejecting joint scale atomically", () => {
    const store = fixture(), evaluated = pose();
    setKeys(store,["joint"],8,new Map([["joint",evaluated]]),["rotation.z","visibility"]);
    expect(evaluateChannels(store.getState().document,"joint",8).rotation[2]).toBe(30);
    const before = store.getState().document;
    expect(()=>setKeys(store,["joint"],8,new Map([["joint",evaluated]]),["scale.x"])).toThrow(/Joint scale/);
    expect(store.getState().document).toBe(before);
  });
  it("rejects explicit time keys on a driven output without creating undo entries", () => {
    const store = fixture(), doc = store.getState().document;
    store.setState({document:{...doc,drivenKeys:[{id:"relation",driver:{targetId:"object",channel:"position.x"},driven:{targetId:"joint",channel:"rotation.y"},keys:[{id:"driven-key",time:0,value:0,interpolation:"linear",tangentMode:"auto"}]}]}});
    store.temporal.getState().clear();
    const before=store.getState().document;
    expect(()=>setKeys(store,["joint"],12,new Map([["joint",pose()]]),["rotation.y"])).toThrow(/both time keys/);
    expect(store.getState().document).toBe(before);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });
});
