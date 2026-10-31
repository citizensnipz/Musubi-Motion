import { describe, expect, it } from "vitest";
import { Line, Raycaster, Scene, Vector3 } from "three";
import { createIKTargets } from "../src/ik-targets.ts";
import { emptyScene, type SceneDocument } from "../src/scene-document.ts";
import { evaluateSceneAnimation } from "../src/animation.ts";

function fixture(): SceneDocument {
  return {...emptyScene(),joints:[
    {id:"root",name:"root",parentId:null,position:[2,0,0],rotation:[0,0,90]},
    {id:"middle",name:"middle",parentId:"root",position:[0,1,0]},
    {id:"end",name:"end",parentId:"middle",position:[0,1,0]},
  ],ikHandles:[{id:"handle",name:"Arm IK",rootId:"root",endId:"end",target:[3,1,0],enabled:true,blend:1,iterations:32}]};
}

describe("IK viewport target adapter",()=>{
  it("keeps target identity across document updates, reflects saved positions, and removes deleted handles",()=>{
    const world=new Scene(),targets=createIKTargets(world),doc=fixture();
    targets.sync(doc,evaluateSceneAnimation(doc,0));
    const object=targets.getObject("handle")!;
    expect(object.position.toArray()).toEqual([3,1,0]);
    const updated={...doc,ikHandles:[{...doc.ikHandles![0],target:[4,2,1] as [number,number,number],blend:.5}]};
    targets.sync(updated,evaluateSceneAnimation(updated,0));targets.setSelected("handle");
    expect(targets.getObject("handle")).toBe(object);
    expect(object.position.toArray()).toEqual([4,2,1]);
    expect(object.userData).toMatchObject({ikHandleId:"handle",blend:.5,selected:true});
    targets.sync({...updated,ikHandles:[]},evaluateSceneAnimation(updated,0));
    expect(targets.getObject("handle")).toBeUndefined();expect(object.parent).toBeNull();
    targets.dispose();targets.dispose();expect(world.children).toHaveLength(0);
  });

  it("connects the saved target to the evaluated end joint in world space without rebuilding target objects",()=>{
    const world=new Scene(),targets=createIKTargets(world),doc=fixture(),poses=evaluateSceneAnimation(doc,0);
    targets.sync(doc,poses);const object=targets.getObject("handle");
    let link:Line|undefined;world.traverse(node=>{if(node instanceof Line&&node.userData.ikHandleLink==="handle")link=node;});
    const before=link!.geometry.getAttribute("position");
    expect([before.getX(0),before.getY(0),before.getZ(0)]).toEqual([3,1,0]);
    expect(before.getX(1)).toBeCloseTo(0);expect(before.getY(1)).toBeCloseTo(0);
    poses.get("root")!.rotation[2]=0;targets.sync(doc,poses);
    expect(targets.getObject("handle")).toBe(object);
    expect(link!.geometry.getAttribute("position")).toBe(before);
    expect([before.getX(1),before.getY(1),before.getZ(1)]).toEqual([2,2,0]);
    targets.dispose();
  });

  it("raycasts target glyphs explicitly while ignoring hidden and disabled handles",()=>{
    const world=new Scene(),targets=createIKTargets(world),doc=fixture(),ray=new Raycaster(new Vector3(3,1,2),new Vector3(0,0,-1));
    targets.sync(doc,evaluateSceneAnimation(doc,0));expect(targets.pick(ray)).toBe("handle");
    targets.setVisible(false);expect(targets.pick(ray)).toBeUndefined();targets.setVisible(true);
    targets.getObject("handle")!.visible=false;expect(targets.pick(ray)).toBeUndefined();targets.getObject("handle")!.visible=true;
    const disabled={...doc,ikHandles:[{...doc.ikHandles![0],enabled:false}]};targets.sync(disabled,evaluateSceneAnimation(disabled,0));
    expect(targets.pick(ray)).toBeUndefined();
    const fk={...doc,ikHandles:[{...doc.ikHandles![0],blend:0}]};targets.sync(fk,evaluateSceneAnimation(fk,0));
    expect(targets.pick(ray)).toBe("handle");
    targets.dispose();expect(targets.pick(ray)).toBeUndefined();
  });
});
