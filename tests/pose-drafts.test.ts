import { describe, expect, it } from "vitest";
import { PoseDrafts } from "../src/pose-drafts.ts";
import { addSplat, deleteSceneItems, emptyScene, type SceneDocument } from "../src/scene-document.ts";
import { defaultAnimation, keyChannels, setIKBlendKey, type AnimationPose, type AnimationTrack } from "../src/animation.ts";
import { updateIKHandle } from "../src/ik.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture(): SceneDocument {
  const doc = addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "object", [0,0,0], "object", "shape").document;
  doc.joints = [{ id: "joint", name: "joint", parentId: null, position: [0,1,0] }];
  return doc;
}
const pose = (x: number): AnimationPose => ({ position:[x,0,0], rotation:[0,0,0], scale:[1,1,1], visibility:1 });
const poses = (x: number) => new Map([["object",pose(x)]]);
const moved = (doc: SceneDocument): SceneDocument => ({ ...doc, nodes:{...doc.nodes} });

function rigFixture(): SceneDocument {
  const doc = fixture();
  doc.joints!.push({ id: "end", name: "End", parentId: "joint", position: [0, 1, 0] });
  doc.ikHandles = [{ id: "ik", name: "Arm", rootId: "joint", endId: "end", target: [1, 1, 0], enabled: true, iterations: 32, blend: 1,
    targetControl: { objectId: "object", offset: [0, 0, 0] } }];
  return doc;
}
function track(targetId: string, channel: "position.x" | "ik.blend"): AnimationTrack {
  const id = `${targetId}_${channel.replace(".", "_")}`;
  return { id, targetId, channel, keys: [{ id: `${id}_key`, time: 0, value: 0.2, interpolation: "linear", tangentMode: "auto" }] };
}

describe("temporary pose draft lifecycle", () => {
  it("restores each revision's own unkeyed pose across undo and redo in one epoch", () => {
    const drafts = new PoseDrafts(), initial = fixture(), first = moved(initial), second = moved(first);
    drafts.capture(first, poses(3));
    expect(drafts.restore(first,initial,"Move object").get("object")!.position[0]).toBe(3);
    drafts.capture(second, poses(7));
    expect(drafts.restore(second,first,"Move object").get("object")!.position[0]).toBe(7);
    expect(drafts.restore(first,second,"Move object").get("object")!.position[0]).toBe(3);
    expect(drafts.restore(second,first,"Move object").get("object")!.position[0]).toBe(7);
  });

  it("does not copy a newer pose into an uncaptured historical document during undo", () => {
    const drafts = new PoseDrafts(), initial = fixture(), edited = moved(initial);
    drafts.capture(edited, poses(5));
    drafts.restore(edited,initial,"Move object");
    expect(drafts.restore(initial,edited,"Initial scene").size).toBe(0);
    expect(drafts.restore(edited,initial,"Move object").get("object")!.position[0]).toBe(5);
  });

  it("scrubbing or playback invalidates old drafts even after undo/redo or a rename", () => {
    const drafts = new PoseDrafts(), initial = fixture(), first = moved(initial), second = moved(first);
    drafts.capture(first, poses(3));drafts.restore(first,initial,"Move object");
    drafts.capture(second, poses(7));drafts.restore(second,first,"Move object");
    drafts.clear();
    expect(drafts.restore(first,second,"Move object").size).toBe(0);
    expect(drafts.restore(second,first,"Move object").size).toBe(0);
    const renamed = {...second,nodes:{...second.nodes}};
    expect(drafts.restore(renamed,second,"Rename object").size).toBe(0);
    drafts.capture(renamed,poses(11));
    expect(drafts.restore(renamed,renamed,"Move object").get("object")!.position[0]).toBe(11);
  });

  it("retains drafts through object and joint renames and shape metadata changes", () => {
    const drafts = new PoseDrafts(), initial = fixture(), edited = moved(initial);
    drafts.capture(edited,new Map([["object",pose(3)],["joint",pose(2)]]));
    drafts.restore(edited,initial,"Move object");
    const renamed:SceneDocument = {...edited,joints:edited.joints!.map(j=>({...j,name:"renamedJoint"}))};
    const restored=drafts.restore(renamed,edited,"Rename joint");
    expect([...restored.keys()]).toEqual(["object","joint"]);
    const shape=renamed.nodes.shape;
    if(shape.type!=="splatShape")throw Error("Invalid fixture");
    const changedShape:SceneDocument={...renamed,nodes:{...renamed.nodes,shape:{...shape,name:"renamedShape"}}};
    expect(drafts.restore(changedShape,renamed,"Edit shape metadata").get("object")!.position[0]).toBe(3);
    expect(drafts.restore(renamed,changedShape,"Rename joint").get("joint")!.position[0]).toBe(2);
  });

  it("discards drafts when any animation or rig evaluation data changes", () => {
    for(const kind of ["animation","joints","drivenKeys","ikHandles","constraints"] as const){
      const drafts=new PoseDrafts(),initial=fixture(),edited=moved(initial);
      drafts.capture(edited,poses(3));drafts.restore(edited,initial,"Move object");
      const changed={...edited,[kind]:kind==="animation"?defaultAnimation():[]} as SceneDocument;
      expect(drafts.restore(changed,edited,`Edit ${kind}`).size).toBe(0);
      expect(drafts.restore(edited,changed,"Move object").get("object")!.position[0]).toBe(3);
      expect(drafts.restore(changed,edited,`Edit ${kind}`).size).toBe(0);
    }
  });

  it("filters deleted targets and rejects shape IDs while retaining valid object/joint drafts", () => {
    const drafts=new PoseDrafts(),initial=fixture(),edited=moved(initial);
    drafts.capture(edited,new Map([["object",pose(3)],["joint",pose(2)],["shape",pose(8)],["missing",pose(9)]]));
    expect([...drafts.restore(edited,initial,"Move object").keys()]).toEqual(["object","joint"]);
    // Remove a renderable without changing the independent joint array.
    const deleted=deleteSceneItems(edited,["object"]);
    const deletedMetadata={...deleted,joints:edited.joints};
    expect([...drafts.restore(deletedMetadata,edited,"Delete object").keys()]).toEqual(["joint"]);
    const deletedAll={...deletedMetadata,joints:[]};
    drafts.capture(deletedAll,new Map([["object",pose(3)],["joint",pose(2)]]));
    expect(drafts.restore(deletedAll,deletedMetadata,"Delete joint").size).toBe(0);
  });

  it("isolates snapshots from later mutation of captured and restored pose arrays", () => {
    const drafts=new PoseDrafts(),initial=fixture(),edited=moved(initial),input=poses(3);
    drafts.capture(edited,input);
    input.get("object")!.position[0]=99;input.clear();
    const restored=drafts.restore(edited,initial,"Move object");
    expect(restored.get("object")!.position[0]).toBe(3);
    restored.get("object")!.position[0]=77;restored.clear();
    expect(drafts.restore(edited,edited,"Move object").get("object")!.position[0]).toBe(3);
  });
});

describe("pose drafts across IK blend edits", () => {
  it("preserves input drafts through the first blend key, undo and redo with isolated snapshots and epoch invalidation", () => {
    const doc = rigFixture(), drafts = new PoseDrafts(), store = createSceneStore(doc), input = poses(7);
    drafts.capture(doc, input);
    input.get("object")!.position[0] = 99;
    let current = new Map<string, AnimationPose>();
    store.subscribe((next, previous) => { current = drafts.restore(next.document, previous.document, next.editLabel); });
    setIKBlendKey(store, "ik", 12, 0.6);
    const keyed = store.getState().document;
    expect(current.get("object")!.position[0]).toBe(7);
    expect(keyed.animation).toMatchObject({ fps: 24, start: 0, end: 288, loop: true });
    expect(doc.animation).toBeUndefined();
    current.get("object")!.position[0] = 55;
    store.temporal.getState().undo();
    expect(store.getState().document).toBe(doc);
    expect(current.get("object")!.position[0]).toBe(7);
    store.temporal.getState().redo();
    expect(store.getState().document).toBe(keyed);
    expect(current.get("object")!.position[0]).toBe(7);
    drafts.clear();
    store.temporal.getState().undo(); expect(current.size).toBe(0);
    store.temporal.getState().redo(); expect(current.size).toBe(0);
  });

  it("preserves drafts through a static fallback edit and a combined fallback/curve edit", () => {
    const doc = rigFixture(), drafts = new PoseDrafts(), store = createSceneStore(doc);
    drafts.capture(doc, poses(7));
    updateIKHandle(store, "ik", { blend: 0.4 });
    const staticEdit = store.getState().document;
    expect(drafts.restore(staticEdit, doc, store.getState().editLabel).get("object")!.position[0]).toBe(7);
    const keyed = keyChannels(staticEdit, "ik", 0.8, 12.5, false);
    const combined = { ...keyed, ikHandles: [{ ...keyed.ikHandles![0], blend: 0.3 }] };
    expect(drafts.restore(combined, staticEdit, "Edit blend").get("object")!.position[0]).toBe(7);
    expect(drafts.restore(doc, combined, "Initial scene").get("object")!.position[0]).toBe(7);
  });

  it("accepts cloned but identical nonblend tracks from a generic graph edit and blend-key removal", () => {
    const doc = rigFixture();
    doc.animation = { ...defaultAnimation(), tracks: [track("object", "position.x"), track("ik", "ik.blend")] };
    const drafts = new PoseDrafts(); drafts.capture(doc, poses(7));
    const keyed = keyChannels(doc, "ik", 0.8, 12.5, false);
    const graphEdit = { ...keyed, animation: structuredClone(keyed.animation!) };
    expect(graphEdit.animation.tracks[0]).not.toBe(doc.animation.tracks[0]);
    expect(drafts.restore(graphEdit, doc, "Edit animation curve").get("object")!.position[0]).toBe(7);
    const removed = { ...graphEdit, animation: { ...graphEdit.animation, tracks: graphEdit.animation.tracks.filter(item => item.channel !== "ik.blend") } };
    expect(drafts.restore(removed, graphEdit, "Delete keys").get("object")!.position[0]).toBe(7);
  });

  it("retains drafts in a temporary numeric blend preview without touching history or authored data", () => {
    const doc = rigFixture(), store = createSceneStore(doc), drafts = new PoseDrafts(), before = JSON.stringify(doc);
    drafts.capture(doc, poses(7));
    const preview = keyChannels(doc, "ik", 0.5, 6.25, false);
    const restored = drafts.restore(preview, doc, "Blend preview");
    expect(restored.get("object")!.position[0]).toBe(7);
    restored.get("object")!.position[0] = 1;
    expect(drafts.restore(doc, preview, "Cancel blend preview").get("object")!.position[0]).toBe(7);
    expect(store.getState().document).toBe(doc);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it.each(["fps", "start", "end", "loop"] as const)("invalidates drafts when a blend edit also changes timeline %s", setting => {
    const doc = rigFixture(), drafts = new PoseDrafts(); drafts.capture(doc, poses(7));
    const keyed = keyChannels(doc, "ik", 0.5, 12, false);
    const changed = { ...keyed, animation: { ...keyed.animation!, [setting]: setting === "loop" ? false : keyed.animation![setting] + 1 } };
    expect(drafts.restore(changed, doc, "Edit blend and timing").size).toBe(0);
  });

  it.each(["change", "add", "remove"])("invalidates drafts when a blend edit also performs a nonblend track %s", operation => {
    const doc = rigFixture();
    doc.animation = { ...defaultAnimation(), tracks: [track("object", "position.x"), track("ik", "ik.blend")] };
    const drafts = new PoseDrafts(); drafts.capture(doc, poses(7));
    const changed = keyChannels(doc, "ik", 0.6, 12, false);
    changed.animation = structuredClone(changed.animation!);
    if (operation === "change") changed.animation.tracks[0].keys[0].value = 0.8;
    if (operation === "add") changed.animation.tracks.push(track("joint", "position.x"));
    if (operation === "remove") changed.animation.tracks.shift();
    expect(drafts.restore(changed, doc, "Edit curves").size).toBe(0);
    expect(drafts.restore(doc, changed, "Undo").get("object")!.position[0]).toBe(7);
    expect(drafts.restore(changed, doc, "Redo").size).toBe(0);
  });

  it.each(["nodes", "joints", "drivenKeys", "constraints", "assets", "rootIds"] as const)("invalidates drafts when other input state %s changes alongside blend", property => {
    const doc = rigFixture(), drafts = new PoseDrafts(); drafts.capture(doc, poses(7));
    const keyed = keyChannels(doc, "ik", 0.5, 12, false);
    const changed = { ...keyed, [property]: property === "nodes" ? { ...doc.nodes }
      : property === "assets" ? { ...doc.assets } : property === "joints" ? [...doc.joints!] : property === "rootIds" ? [...doc.rootIds] : [] };
    expect(drafts.restore(changed, doc, "Edit blend and rig").size).toBe(0);
  });

  it.each(["target", "targetControl", "enabled", "solver", "iterations", "name"] as const)("invalidates drafts when nonblend IK setting %s changes", setting => {
    const doc = rigFixture(), drafts = new PoseDrafts(); drafts.capture(doc, poses(7));
    const handle = { ...doc.ikHandles![0], blend: 0.4 };
    const changes = { target: [2, 3, 0], targetControl: { objectId: "object", offset: [1, 0, 0] }, enabled: false, solver: "ccd", iterations: 64, name: "Other" };
    const changed: SceneDocument = { ...doc, ikHandles: [{ ...handle, [setting]: changes[setting] }] };
    expect(drafts.restore(changed, doc, "Edit IK handle").size).toBe(0);
  });

  it("does not preserve drafts through a blend switch accompanied by FK matching rotation keys", () => {
    const doc = rigFixture(), drafts = new PoseDrafts(); drafts.capture(doc, poses(7));
    const switched = keyChannels(doc, "ik", 0, 12, false);
    switched.animation = { ...switched.animation!, tracks: [...switched.animation!.tracks, { ...track("joint", "position.x"), channel: "rotation.z" }] };
    expect(drafts.restore(switched, doc, "Match FK to IK and key").size).toBe(0);
  });
});
