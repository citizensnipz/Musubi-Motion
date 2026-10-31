import { it, expect } from "vitest";
import * as THREE from "three";
import { ExtSplats, type SplatMesh, type SplatSkinning } from "@sparkjsdev/spark";
import { elasticEdges, elasticityDefaults, validateElasticity } from "../src/elasticity";
import { createElasticRuntime } from "../src/elastic-runtime";
import { surfaceNeighbors } from "../src/elastic-neighbors";
import { allocateFill } from "../src/elastic-allocation";
import { posedSelection } from "../src/splat-selection";
import type { Joint } from "../src/skeleton";
const joints:Joint[]=[{id:"a",name:"a",parentId:null,position:[0,0,0]},{id:"b",name:"b",parentId:"a",position:[.1,0,0]},{id:"c",name:"c",parentId:"b",position:[0,.1,0]}];
it("scopes edges to pairs of bound selected joints",()=>{
 expect(elasticEdges(["a","b","c"],joints,null)).toEqual([["a","b"],["b","c"]]);
 expect(elasticEdges(["a","b","c"],joints,["a","b"])).toEqual([["a","b"]]);
 expect(elasticEdges(["a","b","c"],joints,["a","c"])).toEqual([]);
 expect(()=>validateElasticity({...elasticityDefaults,joints:null,spacing:0})).toThrow();
 expect(()=>validateElasticity({...elasticityDefaults,joints:null,density:-1})).toThrow();
 expect(()=>validateElasticity({...elasticityDefaults,joints:null,distribution:2})).toThrow();
 expect(()=>validateElasticity({stretch:1,spacing:1.5,expansion:1,budget:10000,joints:null})).not.toThrow();
});
const sample=(x:number,y:number,z=0)=>({center:new THREE.Vector3(x,y,z),scales:new THREE.Vector3(.06,.06,.005),quaternion:new THREE.Quaternion()});
it("finds neighbors in both surface directions without linking separate parallel sheets",()=>{
 const samples=[sample(0,0),sample(.1,0),sample(0,.1),sample(.1,.1),sample(0,0,.04),sample(.1,0,.04)];
 const graph=surfaceNeighbors(samples);
 expect(graph.edges).toContainEqual([0,1]); expect(graph.edges).toContainEqual([0,2]);
 expect(graph.triangles.length).toBeGreaterThan(0);
 expect(graph.edges.some(([a,b])=>a<4&&b>=4)).toBe(false);
});
function fixture(points=[sample(0,.1),sample(.1,.1)],scope:string[]|null=null,budget=30,density=1) {
 const source=new ExtSplats({maxSplats:points.length+budget});
 points.forEach((s,i)=>source.pushSplat(s.center,s.scales,s.quaternion,.8,new THREE.Color(i%2,0,1-i%2)));
 const raw=source.extArrays.map(a=>a.slice());
 const mesh={extSplats:source,enableLod:true,updateGenerator(){},needsUpdate:false} as unknown as SplatMesh;
 const skin={skinData:new Uint16Array((points.length+budget)*4),skinTexture:{needsUpdate:false}} as unknown as SplatSkinning;
 points.forEach((_,i)=>skin.skinData[i*4]=((i%2)<<8)|255);
 const rest=[new THREE.Matrix4(),new THREE.Matrix4().makeTranslation(.1,0,0)];
 const runtime=createElasticRuntime(mesh,skin,rest,["a","b"],joints,{...elasticityDefaults,budget,density,joints:scope});
 return {source,raw,skin,rest,runtime,mesh};
}
function posedPoint(f:ReturnType<typeof fixture>,i:number,current:THREE.Matrix4[]) {
 const p=f.source.getSplat(i).center.clone(),result=new THREE.Vector3();
 for(let j=0;j<4;j++) {
  const packed=f.skin.skinData[i*4+j],bone=packed>>8,w=(packed&255)/255;
  if(w)result.addScaledVector(p.clone().applyMatrix4(current[bone].clone().multiply(f.rest[bone].clone().invert())),w);
 }
 return result;
}
it("fills actual deformed gaps with blended color and weights; restores exact source data",()=>{
 const f=fixture(undefined,null,2),current=[f.rest[0],new THREE.Matrix4().makeTranslation(.5,0,0)];
 f.runtime.update(current);expect(f.source.numSplats).toBe(4);
 const originalY=f.source.getSplat(0).center.y;
 for(let i=2;i<4;i++) {
  const point=posedPoint(f,i,current);
  expect(point.x).toBeCloseTo(i===2?.25:.125,3); expect(point.y).toBeCloseTo(originalY,3);
  const color=f.source.getSplat(i).color;
  expect(color.r).toBeGreaterThan(0);expect(color.b).toBeGreaterThan(0);
  expect(Array.from(f.skin.skinData.subarray(i*4,i*4+4)).reduce((s,w)=>s+(w&255),0)).toBe(255);
 }
 f.runtime.update(f.rest);expect(f.source.numSplats).toBe(2);
 f.runtime.dispose();expect(f.mesh.enableLod).toBe(true);expect(f.source.extArrays).toEqual(f.raw);f.source.dispose();
});
it("keeps density demand and existing sample positions independent of the budget",()=>{
 const snapshots=[2,20,100].map(budget=>{
  const f=fixture(undefined,null,budget),current=[f.rest[0],new THREE.Matrix4().makeTranslation(.5,0,0)];
  f.runtime.update(current);
  const points=Array.from({length:f.source.numSplats-2},(_,i)=>posedPoint(f,i+2,current).toArray());
  f.runtime.dispose();f.source.dispose();return points;
 });
 expect(snapshots[1]).toEqual(snapshots[2]);
 expect(snapshots[1].slice(0,snapshots[0].length)).toEqual(snapshots[0]);
 const dense=fixture(undefined,null,100,2);dense.runtime.update([dense.rest[0],new THREE.Matrix4().makeTranslation(.5,0,0)]);
 expect(dense.source.numSplats-2).toBeGreaterThan(snapshots[1].length);dense.runtime.dispose();dense.source.dispose();
});
it("distributes limited fill evenly or favors larger gaps, without exceeding demand",()=>{
 const requests=[2,8].map((strain,i)=>({ids:[i],desired:20,allocated:0,strain}));
 allocateFill(requests,10,0);expect(requests.map(r=>r.allocated)).toEqual([5,5]);
 allocateFill(requests,10,1);expect(requests[1].allocated).toBeGreaterThan(requests[0].allocated);
 allocateFill(requests,1000,1);expect(requests.map(r=>r.allocated)).toEqual([20,20]);
});
it("picks the deformed surface and exposes deformed centers and bounds",()=>{
 const source=new ExtSplats({maxSplats:1});source.pushSplat(new THREE.Vector3(),new THREE.Vector3(.1,.1,.01),new THREE.Quaternion(),1,new THREE.Color());
 const mesh=new THREE.Object3D() as unknown as SplatMesh;
 Object.assign(mesh,{extSplats:source,minRaycastOpacity:.01});
 const skin={skinData:new Uint16Array([255,0,0,0])} as SplatSkinning;
 const selection=posedSelection(mesh,skin,[new THREE.Matrix4().makeTranslation(3,0,0)]);
 expect(selection.centers[0]).toBeCloseTo(3);expect(selection.bounds.min.x).toBeGreaterThan(2);
 expect(selection.pick(new THREE.Raycaster(new THREE.Vector3(3,0,2),new THREE.Vector3(0,0,-1)))).toBeLessThan(2);
 expect(selection.pick(new THREE.Raycaster(new THREE.Vector3(0,0,2),new THREE.Vector3(0,0,-1)))).toBe(Infinity);
 mesh.position.set(2,0,0);
 expect(selection.pick(new THREE.Raycaster(new THREE.Vector3(5,0,2),new THREE.Vector3(0,0,-1)))).toBeLessThan(2);
 source.dispose();
});
it("responds to rotation at unchanged joint separation and puts generated splats in the gap",()=>{
 const f=fixture();f.runtime.update(f.rest);expect(f.source.numSplats).toBe(2);
 const current=[f.rest[0],new THREE.Matrix4().makeTranslation(.1,0,0).multiply(new THREE.Matrix4().makeRotationZ(-Math.PI/2))];
 f.runtime.update(current);expect(f.source.numSplats).toBeGreaterThan(2);
 const expected=posedPoint(f,0,current).lerp(posedPoint(f,1,current),.5);
 expect(posedPoint(f,2,current).distanceTo(expected)).toBeLessThan(.001);
 f.runtime.dispose();f.source.dispose();
});
it("does not generate under rigid motion, for excluded connections, or without surface neighbors",()=>{
 for(const scope of [null,["a"]]) {
  const f=fixture(undefined,scope);
  const rigid=new THREE.Matrix4().makeRotationZ(.7).setPosition(2,3,1);
  f.runtime.update(f.rest.map(r=>rigid.clone().multiply(r)));expect(f.source.numSplats).toBe(2);
  if(scope){f.runtime.update([f.rest[0],new THREE.Matrix4().makeTranslation(1,0,0)]);expect(f.source.numSplats).toBe(2);}
  f.runtime.dispose();f.source.dispose();
 }
 const isolated=fixture([sample(0,0),sample(10,0)]);
 isolated.runtime.update([isolated.rest[0],new THREE.Matrix4().makeTranslation(1,0,0)]);expect(isolated.source.numSplats).toBe(2);
 isolated.runtime.dispose();isolated.source.dispose();
});
it("fills triangle interiors during two-dimensional expansion and obeys budget",()=>{
 const points=[sample(0,0),sample(.1,0),sample(0,.1)];
 const source=new ExtSplats({maxSplats:100});
 points.forEach(s=>source.pushSplat(s.center,s.scales,s.quaternion,.8,new THREE.Color(1,1,1)));
 const mesh={extSplats:source,enableLod:true,updateGenerator(){},needsUpdate:false} as unknown as SplatMesh;
 const skin={skinData:new Uint16Array(400),skinTexture:{needsUpdate:false}} as unknown as SplatSkinning;
 points.forEach((_,i)=>skin.skinData[i*4]=(i<<8)|255);
 const rest=points.map(s=>new THREE.Matrix4().makeTranslation(...s.center.toArray()));
 const runtime=createElasticRuntime(mesh,skin,rest,["a","b","c"],joints,{...elasticityDefaults,budget:20,joints:null});
 const current=points.map(s=>new THREE.Matrix4().makeTranslation(s.center.x*5,s.center.y*5,0));
 runtime.update(current);expect(source.numSplats).toBeGreaterThan(3);expect(source.numSplats).toBeLessThanOrEqual(23);
 let interior=0;
 for(let i=3;i<source.numSplats;i++) {
  const p=source.getSplat(i).center.clone(),posed=new THREE.Vector3();
  for(let k=0;k<4;k++) {const packed=skin.skinData[i*4+k],bone=packed>>8,w=(packed&255)/255;if(w)posed.addScaledVector(p.clone().applyMatrix4(current[bone].clone().multiply(rest[bone].clone().invert())),w);}
  if(posed.x>.001&&posed.y>.001&&posed.x+posed.y<.499)interior++;
 }
 expect(interior).toBeGreaterThan(0);runtime.dispose();source.dispose();
});
