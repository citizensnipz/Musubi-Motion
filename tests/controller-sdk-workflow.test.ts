import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {createSceneStore} from "../src/scene-store.ts";
import {emptyScene,type CurveControlPoint} from "../src/scene-document.ts";
import {createController,findControllerShape,patchedControllerShape,updateControllerShape} from "../src/controller-curves.ts";
import {controllerPlacement} from "../src/controller-placement.ts";
import {evaluateSceneAnimation,upsertTrack} from "../src/animation.ts";
import {evaluateDrivenKeys,setDrivenKey,upsertDrivenRelationship} from "../src/driven-keys.ts";
import {decodeProject,encodeProject} from "../src/project-archive.ts";

describe("controller to joint SDK workflow",()=>{
  it("places a rational control at a joint, edits its response, animates and reopens",async()=>{
    const scene=emptyScene();scene.joints=[{id:"root",name:"Root",parentId:null,position:[2,3,0],rotation:[0,0,20]}];
    const store=createSceneStore(scene),control=createController(store,"circle",{plane:"YZ",...controllerPlacement(scene,evaluateSceneAnimation(scene,0),"root")});
    expect(store.getState().document.nodes[control]).toMatchObject({parentId:null,position:[2,3,0]});
    expect((store.getState().document.nodes[control] as import("../src/scene-document.ts").TransformNode).rotation[2]).toBeCloseTo(20);
    const driver={targetId:control,channel:"rotation.x" as const},driven={targetId:"root",channel:"rotation.z" as const};
    setDrivenKey(store,driver,driven,0,20);setDrivenKey(store,driver,driven,90,100);
    const relation=store.getState().document.drivenKeys![0];
    upsertDrivenRelationship(store,{...relation,keys:relation.keys.map((k,i)=>i?{...k,value:140}:k)});
    const edited=store.getState().document;
    store.temporal.getState().undo();expect(store.getState().document.drivenKeys![0].keys[1].value).toBe(100);
    store.temporal.getState().redo();expect(store.getState().document).toBe(edited);
    const key=(id:string,time:number,value:number)=>({id,time,value,interpolation:"linear" as const,tangentMode:"auto" as const});
    upsertTrack(store,{id:"motion",targetId:control,channel:"rotation.x",keys:[key("start",0,0),key("end",24,90)]});
    const doc=store.getState().document,editor={camera:{position:[3,2,8] as [number,number,number],target:[0,0,0] as [number,number,number],fov:42,near:.01,far:1000},time:.5};
    const reopened=await decodeProject(await encodeProject(doc,new Map(),editor));expect(reopened.scene).toEqual(JSON.parse(JSON.stringify(doc)));
    for(const frame of [0,6,12,18,24]){const poses=evaluateSceneAnimation(reopened.scene,frame);evaluateDrivenKeys(reopened.scene,poses);expect(poses.get("root")!.rotation[2]).toBeCloseTo(20+120*frame/24);}
    const before=store.getState().document;
    expect(()=>setDrivenKey(store,driven,driver,0,0)).toThrow(/time keys/i);expect(store.getState().document).toBe(before);
  });
  it("keeps validated CV previews outside authored data and commits one undoable edit",()=>{
    const store=createSceneStore(),id=createController(store,"circle"),doc=store.getState().document,shape=findControllerShape(doc,id)!;
    const history=store.temporal.getState().pastStates.length,points=shape.points.map(p=>[...p] as CurveControlPoint);points[1][3]=.5;
    const draft=patchedControllerShape(shape,{points});expect(draft.points[1][3]).toBe(.5);
    expect(store.getState().document).toBe(doc);expect(store.temporal.getState().pastStates).toHaveLength(history);
    expect(()=>patchedControllerShape(shape,{points:points.map((p,i)=>i===1?[...p.slice(0,3),0] as CurveControlPoint:p)})).toThrow(/weight/i);
    updateControllerShape(store,shape.id,{points:draft.points});expect(store.temporal.getState().pastStates).toHaveLength(history+1);
    store.temporal.getState().undo();expect(store.getState().document).toBe(doc);
    store.temporal.getState().redo();expect(findControllerShape(store.getState().document,id)!.points[1][3]).toBe(.5);
  });
  it("reproduces the original example's driven elbow at fractional frames",async()=>{
    const {scene}=await decodeProject(new Uint8Array(readFileSync(new URL("../examples/controller-sdk-rig.msb",import.meta.url))));
    for(let frame=0;frame<=48;frame+=.25){const poses=evaluateSceneAnimation(scene,frame);evaluateDrivenKeys(scene,poses);expect(poses.get("elbow")!.rotation[2]).toBeCloseTo((frame<=24?frame:48-frame)/24*100,9);}
  });
});
