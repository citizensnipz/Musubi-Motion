import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { addSplat, emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { addAnimationLayer, updateAnimationLayer, removeAnimationLayer, replaceLayerWeightTrack, setLayerWeightKey, deleteLayerWeightKey, clearLayerWeightCurve } from "../src/animation-layers.ts";
import { defaultAnimation, evaluateLayerWeight, evaluateChannels, evaluateSceneAnimation, evaluateIKBlend, editingTracks, copyKeys, moveKeys, setKeys, setIKBlendKey, validateAnimation, type CurveKey, type AnimationTrack, type AnimationChannel } from "../src/animation.ts";
import { encodeProject, decodeProject } from "../src/project-archive.ts";
import { setDrivenKey } from "../src/driven-keys.ts";
import { evaluateRigStages, jointWorldMatrices } from "../src/ik.ts";
import { createConstraint } from "../src/constraints.ts";
import { createParticlePoseSampler } from "../src/particle-pose-sampler.ts";
const key=(time:number,value:number):CurveKey=>({id:crypto.randomUUID(),time,value,interpolation:"linear",tangentMode:"auto"});
const curve=(channel:AnimationChannel,value:number,layerId?:string,targetId="object"):AnimationTrack=>({id:crypto.randomUUID(),targetId,channel,keys:[key(0,value)],...(layerId?{layerId}:{})});
function fixture(){const doc=addSplat(emptyScene(),{id:"asset",kind:"procedural",generator:"knot-v1"},"Object",[2,0,0],"object","shape").document;doc.animation=defaultAnimation();return createSceneStore(doc);}
function setTracks(store:ReturnType<typeof fixture>,tracks:AnimationTrack[]){const doc=store.getState().document;store.setState({document:{...doc,animation:{...doc.animation!,tracks}}});}
const editor={camera:{position:[3,2,8] as [number,number,number],target:[0,0,0] as [number,number,number],fov:42,near:.01,far:1000},time:.25};
describe("animated independent layer weights",()=>{
 it("samples ordered mixed stacks at fractional frames without mutating old revisions",()=>{
  const store=fixture(),a=addAnimationLayer(store,"Add"),b=addAnimationLayer(store,"Override","override");
  updateAnimationLayer(store,a,{weight:0}); updateAnimationLayer(store,b,{weight:.25});
  setLayerWeightKey(store,a,0,0);setLayerWeightKey(store,a,10,1);
  setLayerWeightKey(store,b,0,1);setLayerWeightKey(store,b,10,0);
  setTracks(store,[curve("position.x",10),curve("rotation.z",720),curve("scale.x",2),curve("visibility",0),curve("position.x",4,a),curve("rotation.z",720,a),curve("scale.x",3,a),curve("visibility",1,a),curve("position.x",100,b),curve("rotation.z",-360,b),curve("scale.x",4,b)]);
  const doc=store.getState().document,before=JSON.stringify(doc);
  for(const f of [10,.25,7.125,0,5,5,0,7.125,.25,10]){const w=f/10,v=1-w,p=evaluateChannels(doc,"object",f);
   expect(p.position[0]).toBeCloseTo((10+4*w)*(1-v)+100*v);
   expect(p.rotation[2]).toBeCloseTo((720+720*w)*(1-v)-360*v);
   expect(p.scale[0]).toBeCloseTo(2*(1+2*w)*(1-v)+4*v);
   expect(p.visibility).toBeCloseTo(w);expect(evaluateSceneAnimation(doc,f).get("object")).toEqual(p);
  }
  expect(JSON.stringify(doc)).toBe(before);clearLayerWeightCurve(store,a);expect(evaluateChannels(doc,"object",5).position[0]).toBeCloseTo(56);
  expect(evaluateChannels(store.getState().document,"object",5).position[0]).toBeCloseTo(55);
 });
 it("holds endpoints, uses absent/empty fallbacks and clamps Bezier overshoot",()=>{
  const store=fixture(),id=addAnimationLayer(store),layer=store.getState().document.animation!.layers![0];
  expect(evaluateLayerWeight({...layer,weight:.3},.25)).toBe(.3);
  expect(evaluateLayerWeight({...layer,weight:.3,weightTrack:{id:"empty",keys:[]}},5)).toBe(.3);
  setLayerWeightKey(store,id,0,0);setLayerWeightKey(store,id,10,1);
  let l=store.getState().document.animation!.layers![0];expect(evaluateLayerWeight(l,-1)).toBe(0);expect(evaluateLayerWeight(l,100)).toBe(1);
  replaceLayerWeightTrack(store,id,{id:"over",keys:[{...key(0,.5),interpolation:"bezier",tangentMode:"fixed",outSlope:10},{...key(10,.5),tangentMode:"fixed",inSlope:-10}]});
  l=store.getState().document.animation!.layers![0];expect(evaluateLayerWeight(l,5)).toBe(1);
  replaceLayerWeightTrack(store,id,{id:"under",keys:[{...key(0,.5),interpolation:"bezier",tangentMode:"fixed",outSlope:-10},{...key(10,.5),tangentMode:"fixed",inSlope:10}]});
  expect(evaluateLayerWeight(store.getState().document.animation!.layers![0],5)).toBe(0);
  expect(()=>evaluateLayerWeight(l,NaN)).toThrow(/finite/);
 });
 it("keeps solo eligibility independent of sampled zero, passes Base and absent channels",()=>{
  const store=fixture(),a=addAnimationLayer(store,"Solo"),b=addAnimationLayer(store,"Other");updateAnimationLayer(store,a,{solo:true,weight:0});
  setLayerWeightKey(store,a,0,0);setLayerWeightKey(store,a,10,1);setTracks(store,[curve("position.x",10),curve("position.x",4,a),curve("position.x",100,b),curve("rotation.z",90,b)]);
  expect(evaluateChannels(store.getState().document,"object",0).position[0]).toBe(10);
  expect(evaluateChannels(store.getState().document,"object",5).rotation[2]).toBe(0);
  updateAnimationLayer(store,a,{mute:true});expect(evaluateChannels(store.getState().document,"object",0).position[0]).toBe(110);
 });
 it("inverts sampled gains, blocks zero/near-zero/overflow atomically while allowing weight keys",()=>{
  const store=fixture(),id=addAnimationLayer(store);setLayerWeightKey(store,id,0,0);setLayerWeightKey(store,id,10,1);
  const requested={...evaluateChannels(store.getState().document,"object",5),position:[7,0,0] as [number,number,number]};
  setKeys(store,["object"],5,new Map([["object",requested]]),["position.x"]);
  expect(editingTracks(store.getState().document)[0].keys[0].value).toBeCloseTo(14);
  expect(evaluateChannels(store.getState().document,"object",5).position[0]).toBeCloseTo(7);
  for(const [f,value] of [[0,0],[1,1e-13],[2,1e-11]]){setLayerWeightKey(store,id,f,value);const before=store.getState().document;
   expect(()=>setKeys(store,["object"],f,new Map([["object",{...requested,position:[1e12,0,0]}]]),["position.x"])).toThrow(/influence|unsupported/);expect(store.getState().document).toBe(before);}
  setLayerWeightKey(store,id,0,.2);updateAnimationLayer(store,id,{locked:true});const before=store.getState().document;
  for(const action of [()=>setLayerWeightKey(store,id,0,.5),()=>deleteLayerWeightKey(store,id,0),()=>clearLayerWeightCurve(store,id),()=>replaceLayerWeightTrack(store,id),()=>updateAnimationLayer(store,id,{weight:.5})]){expect(action).toThrow(/Unlock/);expect(store.getState().document).toBe(before);}
 });
 it("uses sampled IK blend and after-stack bounds",()=>{
  const store=fixture();let doc=store.getState().document;doc={...doc,joints:[{id:"root",name:"Root",parentId:null,position:[0,0,0]},{id:"end",name:"End",parentId:"root",position:[1,0,0]}],ikHandles:[{id:"ik",name:"IK",rootId:"root",endId:"end",target:[1,1,0],enabled:true,iterations:5,blend:.2}]};store.setState({document:doc});
  const a=addAnimationLayer(store),b=addAnimationLayer(store,"Override","override");setLayerWeightKey(store,a,0,0);setLayerWeightKey(store,a,10,1);updateAnimationLayer(store,b,{weight:.25});setTracks(store,[curve("ik.blend",2,a,"ik"),curve("ik.blend",.4,b,"ik")]);
  for(const f of [0,.25,5,7.125,10])expect(evaluateIKBlend(store.getState().document,"ik",f)).toBeCloseTo(Math.min(1,(.2+2*f/10)*.75+.1));
  setIKBlendKey(store,"ik",5,.7);expect(evaluateIKBlend(store.getState().document,"ik",5)).toBeCloseTo(.7);
 });
 it("samples animated blend in actual IK and historical emitter matrices",()=>{
  const doc=emptyScene();doc.joints=[{id:"root",name:"Root",parentId:null,position:[0,0,0]},{id:"end",name:"End",parentId:"root",position:[1,0,0]}];doc.ikHandles=[{id:"ik",name:"IK",rootId:"root",endId:"end",target:[0,1,0],enabled:true,iterations:20,blend:0}];
  const store=createSceneStore(doc),id=addAnimationLayer(store);setLayerWeightKey(store,id,0,0);setLayerWeightKey(store,id,10,1);const original=store.getState().document;
  store.setState({document:{...original,animation:{...original.animation!,tracks:[curve("ik.blend",1,id,"ik")]}}});const source=store.getState().document,before=JSON.stringify(source),sampler=createParticlePoseSampler(source);
  for(const f of [10,.25,7.125,0,5,0,10]){const poses=evaluateSceneAnimation(source,f);evaluateRigStages(source,poses,false,f);const position=new Vector3().setFromMatrixPosition(jointWorldMatrices(source,poses).get("end")!);const angle=Math.PI/2*f/10;expect(position.x).toBeCloseTo(Math.cos(angle),6);expect(position.y).toBeCloseTo(Math.sin(angle),6);const historical=new Vector3().setFromMatrixPosition(sampler.worldAt(f).get("end")!);expect(historical.distanceTo(position)).toBeLessThan(1e-8);}
  expect(JSON.stringify(source)).toBe(before);
 });
 it("keeps weight keys out of generic pose selections and rejects SDK ownership",()=>{
  const store=fixture(),id=addAnimationLayer(store);setLayerWeightKey(store,id,0,.5);const doc=store.getState().document,keyId=doc.animation!.layers![0].weightTrack!.keys[0].id;
  expect(copyKeys(doc,[keyId]).tracks).toEqual([]);moveKeys(store,[keyId],1,.1);expect(store.getState().document).toBe(doc);
  expect(()=>setDrivenKey(store,{targetId:"object",channel:"position.x"},{targetId:id,channel:"weight" as never},0,.5)).toThrow();expect(store.getState().document).toBe(doc);
 });
 it("preserves curve metadata and IDs, one-step history, no-ops, cleanup and fallback",()=>{
  const store=fixture(),id=addAnimationLayer(store);updateAnimationLayer(store,id,{weight:.35});
  const first={...key(0,.4),interpolation:"bezier" as const,tangentMode:"fixed" as const,inSlope:2,outSlope:3,inWeight:.2,outWeight:.4,broken:true};
  replaceLayerWeightTrack(store,id,{id:"weight-track",keys:[first]});store.temporal.getState().clear();const before=store.getState().document;
  setLayerWeightKey(store,id,0,.6);expect(store.getState().document.animation!.layers![0].weightTrack!.keys[0]).toEqual({...first,value:.6});expect(store.temporal.getState().pastStates).toHaveLength(1);
  setLayerWeightKey(store,id,0,.6);expect(store.temporal.getState().pastStates).toHaveLength(1);store.temporal.getState().undo();expect(store.getState().document).toBe(before);store.temporal.getState().redo();
  expect(editingTracks(store.getState().document)).toEqual([]);deleteLayerWeightKey(store,id,0);expect(store.getState().document.animation!.layers![0].weightTrack).toBeUndefined();expect(store.getState().document.animation!.layers![0].weight).toBe(.35);
  setLayerWeightKey(store,id,1,.9);setTracks(store,[curve("position.x",4,id)]);removeAnimationLayer(store,id);expect(store.getState().document.animation!.layers).toEqual([]);expect(store.getState().document.animation!.tracks).toEqual([]);
  expect(()=>setLayerWeightKey(store,"missing",0,1)).toThrow(/missing/);
 });
 it("rejects malformed curves and global ID collisions before document/history changes",()=>{
  const store=fixture(),a=addAnimationLayer(store),b=addAnimationLayer(store);const pose=curve("position.x",2,a);setTracks(store,[pose]);
  setLayerWeightKey(store,b,0,.5);const doc=store.getState().document,history=store.temporal.getState().pastStates.length;
  const invalid=[{id:pose.id,keys:[key(0,.5)]},{id:"x",keys:[{...key(0,.5),id:pose.keys[0].id}]},{id:"x",keys:[key(0,NaN)]},{id:"x",keys:[key(0,Infinity)]},{id:"x",keys:[key(0,-.1)]},{id:"x",keys:[key(0,1.1)]},{id:"x",keys:[key(1,.5),key(1,.6)]},{id:"__proto__",keys:[]},{id:"x",keys:[key(0,.5)],targetId:b}];
  for(const bad of invalid){expect(()=>replaceLayerWeightTrack(store,a,bad)).toThrow();expect(store.getState().document).toBe(doc);expect(store.temporal.getState().pastStates).toHaveLength(history);}
  const other=doc.animation!.layers!.find(l=>l.id===b)!.weightTrack!;expect(()=>replaceLayerWeightTrack(store,a,other)).toThrow(/track/);
 });
 it("shares100000 total key and track budgets with pose tracks",()=>{
  const store=fixture(),id=addAnimationLayer(store);const doc=store.getState().document,keys=Array.from({length:100000},(_,i)=>({...key(i,.5),id:`large-${i}`}));
  const animation={...doc.animation!,tracks:[{...curve("position.x",1),keys}],layers:doc.animation!.layers!.map(l=>({...l,weightTrack:{id:"weight",keys:[key(0,.5)]}}))};
  expect(()=>validateAnimation({...animation,tracks:[{...animation.tracks[0],keys:keys.slice(0,99999)}]},doc)).not.toThrow();
  expect(()=>validateAnimation(animation,doc)).toThrow(/Too many animation keys/);
  expect(()=>validateAnimation({...animation,tracks:Array.from({length:100000},()=>curve("position.x",1))},doc)).toThrow(/Too many animation tracks/);
 });
 it("roundtrips current curves/IDs/composite and rejects unsupported or malformed opens atomically",async()=>{
  const store=fixture(),id=addAnimationLayer(store);setLayerWeightKey(store,id,0,0);setLayerWeightKey(store,id,10,1);setTracks(store,[curve("position.x",10,id)]);const doc=store.getState().document;
  const bytes=await encodeProject(doc,new Map(),editor),loaded=await decodeProject(bytes);expect(loaded.scene).toEqual(doc);expect(loaded.scene.version).toBe(2);expect(evaluateChannels(loaded.scene,"object",7.125)).toEqual(evaluateChannels(doc,"object",7.125));
  for(const change of [(m:any)=>m.scene.version=1,(m:any)=>m.scene.animation.layers[0].weightTrack.keys[0].value=2]){const entries=unzipSync(bytes),manifest=JSON.parse(strFromU8(entries["scene.json"]));change(manifest);entries["scene.json"]=strToU8(JSON.stringify(manifest));await expect(decodeProject(zipSync(entries))).rejects.toThrow();expect(store.getState().document).toBe(doc);}
 });
 it("historical SDK/constraint/emitter samples share dynamic weights at shuffled fractional frames",()=>{
  const doc=emptyScene();for(const id of ["driver","control","emitter"]){doc.nodes[id]={id,type:"transform",name:id,parentId:null,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],rotationOrder:"XYZ"};doc.rootIds.push(id);}
  const store=createSceneStore(doc),id=addAnimationLayer(store);setLayerWeightKey(store,id,0,0);setLayerWeightKey(store,id,10,1);
  const original=store.getState().document;store.setState({document:{...original,animation:{...original.animation!,tracks:[{...curve("position.x",0,undefined,"driver"),keys:[key(0,0),key(10,.5)]},{...curve("position.x",.2,id,"driver"),keys:[key(0,.2),key(10,.4)]}]}}});
  setDrivenKey(store,{targetId:"driver",channel:"position.x"},{targetId:"control",channel:"position.x"},0,0);setDrivenKey(store,{targetId:"driver",channel:"position.x"},{targetId:"control",channel:"position.x"},1,10);createConstraint(store,"point","control","emitter",false);
  const source=store.getState().document,sampler=createParticlePoseSampler(source),before=JSON.stringify(source);
  for(const f of [10,.25,7.125,0,5,5,0,7.125,.25,10]){const expected=.05*f+(.2+.02*f)*f/10;expect(evaluateChannels(source,"driver",f).position[0]).toBeCloseTo(expected);expect(new Vector3().setFromMatrixPosition(sampler.worldAt(f).get("emitter")!).x).toBeCloseTo(expected*10);}
  expect(JSON.stringify(source)).toBe(before);
 });
});


describe("dedicated layer weight key-list edits",()=>{
 it("moves an identified key across neighbors preserving all metadata and historical revisions",()=>{
  const store=fixture(),id=addAnimationLayer(store);updateAnimationLayer(store,id,{weight:.35});
  const first={...key(.25,.2),interpolation:"bezier" as const,tangentMode:"fixed" as const,inSlope:.02,outSlope:.03,inWeight:.2,outWeight:.4,broken:true};
  const middle=key(5.5,.6),last=key(10.75,.9);
  replaceLayerWeightTrack(store,id,{id:"weight-list",keys:[first,middle,last]});store.temporal.getState().clear();
  const original=store.getState().document,track=original.animation!.layers![0].weightTrack!;
  const moved={...first,time:12.125};
  replaceLayerWeightTrack(store,id,{...track,keys:[middle,last,moved]});
  const layer=store.getState().document.animation!.layers![0];
  expect(layer.weightTrack).toEqual({id:track.id,keys:[middle,last,moved]});
  expect(original.animation!.layers![0].weightTrack).toEqual(track);
  expect(evaluateLayerWeight(layer,-1)).toBe(.6);expect(evaluateLayerWeight(layer,20)).toBe(.2);
  expect(store.temporal.getState().pastStates).toHaveLength(1);
  replaceLayerWeightTrack(store,id,layer.weightTrack);expect(store.temporal.getState().pastStates).toHaveLength(1);
  store.temporal.getState().undo();expect(store.getState().document).toBe(original);
  store.temporal.getState().redo();expect(store.getState().document.animation!.layers![0].weightTrack!.keys[2]).toEqual(moved);
  deleteLayerWeightKey(store,id,middle.time);deleteLayerWeightKey(store,id,last.time);deleteLayerWeightKey(store,id,moved.time);
  expect(store.getState().document.animation!.layers![0].weightTrack).toBeUndefined();
  expect(evaluateLayerWeight(store.getState().document.animation!.layers![0],7.125)).toBe(.35);
 });
 it("rejects conflicting moved times, invalid edits and locked-owner changes atomically",()=>{
  const store=fixture(),id=addAnimationLayer(store);setLayerWeightKey(store,id,.25,.2);setLayerWeightKey(store,id,10.75,.9);
  const track=store.getState().document.animation!.layers![0].weightTrack!;
  store.temporal.getState().clear();const before=store.getState().document;
  for(const patch of [{time:10.75},{time:NaN},{time:1000001},{value:-.1},{value:1.1},{value:Infinity},{interpolation:"invalid"}]){
   expect(()=>replaceLayerWeightTrack(store,id,{...track,keys:[{...track.keys[0],...patch} as CurveKey,track.keys[1]]})).toThrow();
   expect(store.getState().document).toBe(before);expect(store.temporal.getState().pastStates).toHaveLength(0);
  }
  updateAnimationLayer(store,id,{locked:true});const locked=store.getState().document,count=store.temporal.getState().pastStates.length;
  expect(()=>replaceLayerWeightTrack(store,id,{...track,keys:[{...track.keys[0],time:7.125},track.keys[1]]})).toThrow(/Unlock/);
  expect(()=>deleteLayerWeightKey(store,id,.25)).toThrow(/Unlock/);
  expect(store.getState().document).toBe(locked);expect(store.temporal.getState().pastStates).toHaveLength(count);
 });
 it("changes outgoing step, linear and Bezier sampling while retaining IDs and tangent metadata",()=>{
  const store=fixture(),id=addAnimationLayer(store);
  const first={...key(.25,.2),tangentMode:"fixed" as const,outSlope:0,inSlope:.7,outWeight:1/3,inWeight:.4,broken:true};
  const last={...key(10.25,.8),tangentMode:"fixed" as const,inSlope:0};
  replaceLayerWeightTrack(store,id,{id:"interpolated-weight",keys:[first,last]});
  for(const [interpolation,expected] of [["step",.2],["linear",.35],["bezier",.29375]] as const){
   replaceLayerWeightTrack(store,id,{id:"interpolated-weight",keys:[{...first,interpolation},last]});
   const layer=store.getState().document.animation!.layers![0];
   // Zero-slope Bezier handles at one-third duration produce the analytic smoothstep value.
   expect(evaluateLayerWeight(layer,2.75)).toBeCloseTo(expected,6);
   expect(layer.weightTrack!.keys).toEqual([{...first,interpolation},last]);
  }
  const layer=store.getState().document.animation!.layers![0];expect(evaluateLayerWeight(layer,2.75)).not.toBeCloseTo(.35);
 });
});
