import { describe, it, expect } from "vitest";
import { activeJoint, reparentJoint, validateJoints, type Joint } from "../src/skeleton";
import { createSceneStore } from "../src/scene-store";
import { emptyScene } from "../src/scene-document";
import { validateScene } from "../src/project-archive";
const joints: Joint[] = [
 {id:"root",name:"root",parentId:null,position:[2,0,0]},
 {id:"child",name:"child",parentId:"root",position:[0,1,0]},
];
describe("joint hierarchy", () => {
 it("anchors multi-selection to a selected ancestor regardless of selection order",()=>{
  expect(activeJoint(joints,new Set(["child","root"]))).toBe("root");
  expect(activeJoint(joints,new Set(["root","child"]))).toBe("root");
  const chain=[...joints,{id:"tip",name:"tip",parentId:"child",position:[0,1,0] as [number,number,number]}];
  expect(activeJoint(chain,new Set(["tip","root"]))).toBe("root");
  expect(activeJoint(joints,new Set(["child"]))).toBe("child");
  expect(activeJoint(joints,new Set())).toBe("");
 });
 it("uses selection order for separate branches",()=>{
  const separate=[joints[0],{...joints[1],parentId:null}];
  expect(activeJoint(separate,new Set(["child","root"]))).toBe("child");
 });
 it("keeps world position when detaching and attaching", () => {
  const detached = reparentJoint(joints,"child",null);
  expect(detached[1].position).toEqual([2,1,0]);
  expect(reparentJoint(detached,"child","root")[1].position).toEqual([0,1,0]);
 });
 it("rejects cycles, missing parents and invalid positions", () => {
  expect(()=>reparentJoint(joints,"root","child")).toThrow();
  expect(()=>validateJoints([{...joints[0],parentId:"missing"}])).toThrow();
  expect(()=>validateJoints([{...joints[0],position:[NaN,0,0]}])).toThrow();
 });
 it("validates serialized scenes and restores hierarchy through undo redo", () => {
  const doc = {...emptyScene(),joints};
  expect(validateScene(JSON.parse(JSON.stringify(doc))).joints).toEqual(joints);
  const store = createSceneStore(doc);
  store.setState({document:{...doc,joints:reparentJoint(joints,"child",null)},editLabel:"Parent joint"});
  store.temporal.getState().undo(); expect(store.getState().document.joints).toEqual(joints);
  store.temporal.getState().redo(); expect(store.getState().document.joints![1].parentId).toBe(null);
 });
});

it("preserves world pose when parenting under a rotated joint", () => {
 const rig: Joint[] = [
  {id:"a",name:"a",parentId:null,position:[2,0,0],rotation:[0,0,90]},
  {id:"b",name:"b",parentId:null,position:[2,1,0],rotation:[0,0,30]},
 ];
 const attached = reparentJoint(rig,"b","a");
 expect(attached[1].position[0]).toBeCloseTo(1);
 expect(attached[1].position[1]).toBeCloseTo(0);
 expect(attached[1].rotation![2]).toBeCloseTo(-60);
 const detached = reparentJoint(attached,"b",null);
 expect(detached[1].position[0]).toBeCloseTo(2);
 expect(detached[1].position[1]).toBeCloseTo(1);
 expect(detached[1].rotation![2]).toBeCloseTo(30);
});
