import { it, expect } from "vitest";
import { addSplat, deleteSceneItems, emptyScene } from "../src/scene-document";
import { createSceneStore } from "../src/scene-store";
import { validateScene } from "../src/project-archive";
it("deletes selected subtrees and assets while preserving undo data", () => {
 const {document: scene, id} = addSplat(emptyScene(), {id:"asset",kind:"procedural",generator:"knot-v1"}, "splat", [0,0,0]);
 const doc = {...scene, joints:[{id:"a",name:"a",parentId:null,position:[0,0,0] as [number,number,number]}, {id:"b",name:"b",parentId:"a",position:[0,1,0] as [number,number,number]}]};
 const next = deleteSceneItems(doc,[id,"a"]);
 expect(next.nodes).toEqual({}); expect(next.assets).toEqual({}); expect(next.joints).toEqual([]);
 expect(()=>validateScene(next)).not.toThrow();
 const store = createSceneStore(doc); store.setState({document:next,editLabel:"Delete"});
 store.temporal.getState().undo(); expect(store.getState().document).toEqual(doc);
 store.temporal.getState().redo(); expect(store.getState().document).toEqual(next);
});
