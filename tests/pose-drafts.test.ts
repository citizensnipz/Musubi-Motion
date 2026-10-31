import { describe, expect, it } from "vitest";
import { PoseDrafts } from "../src/pose-drafts.ts";
import { addSplat, deleteSceneItems, emptyScene, type SceneDocument } from "../src/scene-document.ts";
import { defaultAnimation, type AnimationPose } from "../src/animation.ts";

function fixture(): SceneDocument {
  const doc = addSplat(emptyScene(), { id: "asset", kind: "procedural", generator: "knot-v1" }, "object", [0,0,0], "object", "shape").document;
  doc.joints = [{ id: "joint", name: "joint", parentId: null, position: [0,1,0] }];
  return doc;
}
const pose = (x: number): AnimationPose => ({ position:[x,0,0], rotation:[0,0,0], scale:[1,1,1], visibility:1 });
const poses = (x: number) => new Map([["object",pose(x)]]);
const moved = (doc: SceneDocument): SceneDocument => ({ ...doc, nodes:{...doc.nodes} });

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
