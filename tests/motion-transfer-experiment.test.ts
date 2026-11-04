import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { importFBX } from '../src/fbx-import.ts';
import { emptyScene, type SceneDocument, type MeshShapeNode, type Vec3 } from '../src/scene-document.ts';
import { angleQuaternion } from '../src/joint-transform.ts';
import { evaluateSceneAnimation, evaluateCurve, defaultAnimation } from '../src/animation.ts';
import { decodeProject, encodeProject } from '../src/project-archive.ts';
import { createSceneStore } from '../src/scene-store.ts';
import { deformMeshPositions } from '../src/mesh-skin.ts';
import { jointWorldMatrices } from '../src/ik.ts';
import { compareAnalytic, contactMetrics, explicitMap, FRAMES, mapOriginal, mapSkeletonUtils, ROLES, targetFixture, validateMapping, world, type Rig, type Role, commitBake } from '../scripts/motion-transfer-experiment/harness.ts';
const fixtureDir=resolve('tests/fixtures/motion-transfer'),meta=JSON.parse(readFileSync(resolve(fixtureDir,'MT17-reference.json'),'utf8'));
const variants=['MT17-IDENTITY','MT17-SCALE08','MT17-PROPORTION','MT17-BASIS'];
const editor={camera:{position:[0,1,5] as Vec3,target:[0,1,0] as Vec3,fov:45,near:.01,far:1000},time:0};
let source:Rig;
const report:any={startedUTC:new Date().toISOString(),node:process.version,three:'0.180.0',seed:'deterministic reversal/interleaved frame order',source:{},variants:{},checks:[]};
const output=process.env.MT17_EVIDENCE;
function hash(data:Uint8Array|string){return createHash('sha256').update(data).digest('hex');}
const snapshot=(v:unknown)=>JSON.stringify(v);
function target(name:string){return targetFixture(meta.reference,name);}
function finite(v:any):boolean { if(typeof v==='number')return Number.isFinite(v);if(Array.isArray(v))return v.every(finite);if(v&&typeof v==='object')return Object.values(v).every(finite);return true; }
function shape(doc:SceneDocument){return doc.nodes.mt_shape as MeshShapeNode;}
beforeAll(async()=>{
 const bytes=readFileSync(resolve(fixtureDir,'MT17-SOURCE-24.fbx')),started=performance.now();
 const imported=await importFBX(new File([bytes],'MT17-SOURCE-24.fbx'),emptyScene());
 const roles=Object.fromEntries(ROLES.map(role=>{
  const matches=imported.document.joints!.filter(j=>j.name===role);expect(matches).toHaveLength(1);return [role,matches[0].id];
 })) as Record<Role,string>;
 const reference=meta.reference.map((r:any)=>({id:roles[r.role as Role],name:r.role,parentId:r.parent?roles[r.parent as Role]:null,position:r.position,rotation:r.rotation,orientation:[0,0,0]}));
 source={doc:imported.document,reference,roles,coordinates:{metersPerUnit:meta.metersPerUnit,up:meta.up,forward:meta.forward,basis:meta.basis}};
 report.source={bytes:bytes.length,sha256:hash(bytes),importMs:performance.now()-started,joints:imported.jointIds.length,clips:imported.clips,keys:imported.document.animation!.tracks.reduce((s,t)=>s+t.keys.length,0),referenceIndependentOfFrame0:true,contacts:contactMetrics(source,meta.stances)};
 if(output){mkdirSync(output,{recursive:true});writeFileSync(resolve(output,'imported-source.json'),JSON.stringify(imported.document,null,2));}
});
afterAll(()=>{report.finishedUTC=new Date().toISOString();if(output)writeFileSync(resolve(output,'metrics.json'),JSON.stringify(report,null,2)+'\n');});
describe('bounded offline MT17 compatible FBX transfer experiment',()=>{
 it('imports the actual original ASCII7400 humanoid and agrees with independently authored samples',()=>{
  expect(source.doc.joints).toHaveLength(17);expect(source.doc.animation!.end).toBe(48);
  expect(source.doc.joints!.find(j=>j.id===source.roles.hips)!.position[1]).toBe(.9);
  expect(evaluateSceneAnimation(source.doc,0).get(source.roles.hips)!.position[1]).toBeCloseTo(.84,6);
  let maxAngle=0,sum=0,max=0,count=0;
  for(const sample of meta.samples) {
   const expected:Rig={...source,doc:{...emptyScene(),joints:source.reference.map(j=>({...j,position:j.id===source.roles.hips?sample.root:j.position,rotation:sample.rotations[j.name]}))}};
   const actual=world(source,sample.frame),wanted=world(expected);
   for(const role of ROLES){const a=actual.get(source.roles[role])!,e=wanted.get(source.roles[role])!,err=a.position.distanceTo(e.position);sum+=err*err;max=Math.max(max,err);maxAngle=Math.max(maxAngle,a.quaternion.angleTo(e.quaternion)*180/Math.PI);count++;}
  }
  report.source.authoredSampleComparison={worldRms:Math.sqrt(sum/count),worldMax:max,maxAngularDegrees:maxAngle,scope:'Integer authored samples; importer linear reduction and float32 quaternion tracks are measured separately from mapper error.'};
  expect(maxAngle).toBeLessThan(.1);expect(max).toBeLessThan(.002);
 });
 for(const variant of variants) it(`measures both methods, diagnostics, persistence and immutability on ${variant}`,async()=>{
  const t=target(variant),mapping=explicitMap(source,t),beforeSource=snapshot(source),beforeTarget=snapshot(t),started=performance.now(),mapped=mapOriginal(source,t,mapping),cost=performance.now()-started;
  expect(snapshot(source)).toBe(beforeSource);expect(snapshot(t)).toBe(beforeTarget);
  const original=compareAnalytic(source,t,mapped),shuffled=compareAnalytic(source,t,mapped,[...FRAMES].reverse());
  expect(shuffled.worldJointMax).toBe(original.worldJointMax);expect(shuffled.worldJointRms).toBeCloseTo(original.worldJointRms,14);
  expect(original.maxRelativeSegmentLengthError).toBeLessThan(1e-6);expect(finite(mapped)).toBe(true);
  if(variant==='MT17-IDENTITY'||variant==='MT17-SCALE08') {expect(original.worldJointRms).toBeLessThanOrEqual(1e-5);expect(original.maxAngularDegrees).toBeLessThanOrEqual(.1);expect(original.rootNormalizedRms).toBeLessThanOrEqual(1e-5);}
  const comparator=mapSkeletonUtils(source,t,mapping),comparison=compareAnalytic(source,t,comparator.doc);
  expect(snapshot(source)).toBe(beforeSource);expect(snapshot(t)).toBe(beforeTarget);expect(finite(comparator.doc)).toBe(true);
  expect(comparator.grid.helperSamples).toBe(48);expect(comparator.grid.importerSamples).toBe(49);expect(comparator.grid.second).not.toBeCloseTo(1/24,6);
  const bytes=await encodeProject(mapped,new Map(),editor),decoded=await decodeProject(bytes);expect(decoded.scene).toEqual(mapped);expect(shape(decoded.scene).skin).toEqual(shape(t.doc).skin);expect(decoded.scene.joints).toEqual(t.doc.joints);
  for(const frame of FRAMES) {
   const originalWorlds=jointWorldMatrices(mapped,evaluateSceneAnimation(mapped,frame)),loadedWorlds=jointWorldMatrices(decoded.scene,evaluateSceneAnimation(decoded.scene,frame));
   expect([...loadedWorlds].map(([id,m])=>[id,m.toArray()])).toEqual([...originalWorlds].map(([id,m])=>[id,m.toArray()]));
   expect(Array.from(deformMeshPositions(shape(decoded.scene),id=>loadedWorlds.get(id)))).toEqual(Array.from(deformMeshPositions(shape(mapped),id=>originalWorlds.get(id))));
  }
  const store=createSceneStore(t.doc);commitBake(store,source,t,mapping);expect(store.temporal.getState().pastStates).toHaveLength(1);expect(store.getState().document).toEqual(mapped);
  store.temporal.getState().undo();expect(store.getState().document).toBe(t.doc);store.temporal.getState().redo();expect(store.getState().document).toEqual(mapped);
  const trajectories=FRAMES.map(frame=>({frame,source:Object.fromEntries([...world(source,frame)].map(([id,v])=>[ROLES.find(r=>source.roles[r]===id),v.position.toArray()])),original:Object.fromEntries([...world({...t,doc:mapped},frame)].map(([id,v])=>[ROLES.find(r=>t.roles[r]===id),v.position.toArray()])),skeletonUtils:Object.fromEntries([...world({...t,doc:comparator.doc},frame)].map(([id,v])=>[ROLES.find(r=>t.roles[r]===id),v.position.toArray()]))}));
  report.variants[variant]={original:{costMs:cost,...original,integerGrid:compareAnalytic(source,t,mapped,FRAMES.filter(Number.isInteger)),fractionalGrid:compareAnalytic(source,t,mapped,FRAMES.filter(f=>!Number.isInteger(f))),contacts:contactMetrics({...t,doc:mapped},meta.stances)},skeletonUtils:{costMs:comparator.costMs,...comparison,contacts:contactMetrics({...t,doc:comparator.doc},meta.stances),grid:comparator.grid,options:comparator.options,endpoint:compareAnalytic(source,t,comparator.doc,[0,48])},archive:{bytes:bytes.length,sha256:hash(bytes)},checks:{referenceBindFallbackImmutable:true,finite:true,roundtrip:true,skinDeformationRoundtrip:true,oneCommitUndoRedo:true,shuffledOrder:true}};
  if(process.env.MT17_REFRESH==='1')writeFileSync(resolve(fixtureDir,`${variant}.character.json`),JSON.stringify({reference:t.reference,roles:t.roles,coordinates:t.coordinates,nodes:t.doc.nodes,rootIds:t.doc.rootIds},null,2)+'\n');
  const character=JSON.parse(readFileSync(resolve(fixtureDir,`${variant}.character.json`),'utf8'));expect(character).toEqual({reference:t.reference,roles:t.roles,coordinates:t.coordinates,nodes:t.doc.nodes,rootIds:t.doc.rootIds});
  if(output){writeFileSync(resolve(output,`${variant}.msb`),bytes);writeFileSync(resolve(output,`${variant}.reference.json`),JSON.stringify({reference:t.reference,world:Object.fromEntries([...world(t,undefined,true)].map(([id,s])=>[id,{position:s.position.toArray(),quaternion:s.quaternion.toArray()}])),mapping},null,2));writeFileSync(resolve(output,`${variant}.trajectories.json`),JSON.stringify(trajectories,null,2));}
 });
 it('normalizes explicit centimeter and rotated coordinate copies, never guessing units/axes',()=>{
  const t=target('MT17-IDENTITY'),base=mapOriginal(source,t,explicitMap(source,t));
  const cm:Rig=structuredClone(source);cm.coordinates.metersPerUnit=.01;
  for(const doc of [cm.doc,{joints:cm.reference}])for(const j of doc.joints!)j.position=j.position.map(x=>x*100) as Vec3;
  for(const track of cm.doc.animation!.tracks)if(track.channel.startsWith('position.'))track.keys.forEach(k=>k.value*=100);
  expect(compareAnalytic(source,t,mapOriginal(cm,t,explicitMap(cm,t))).worldJointRms).toBeLessThan(1e-5);
  const rotated:Rig=structuredClone(source),q=angleQuaternion([0,90,0]),inverse=q.clone().invert();rotated.coordinates.basis=q.toArray();
  // Only root coordinates rotate; parent-local child frames and offsets are unchanged.
  for(const j of [rotated.doc.joints!.find(j=>j.id===source.roles.hips)!,rotated.reference.find(j=>j.id===source.roles.hips)!]) {j.position=new Vector3(...j.position).applyQuaternion(inverse).toArray() as Vec3;j.rotation=[0,-90,0];}
  const tracks=rotated.doc.animation!.tracks;for(const track of tracks.filter(t=>t.targetId===source.roles.hips&&t.channel.startsWith('rotation.')))track.keys.forEach(k=>k.value=track.channel==='rotation.y'?-90:0);
  const rootTracks=['x','y','z'].map(a=>tracks.find(t=>t.targetId===source.roles.hips&&t.channel===`position.${a}`)!);
  // Importer reduces XYZ independently: resample all root axes onto same grid before conversion.
  for(let axis=0;axis<3;axis++)rootTracks[axis].keys=Array.from({length:49},(_,frame)=>({id:`rotroot_${axis}_${frame}`,time:frame,value:new Vector3(...evaluateSceneAnimation(source.doc,frame).get(source.roles.hips)!.position).applyQuaternion(inverse).getComponent(axis),interpolation:'linear',tangentMode:'auto'}));
  const result=mapOriginal(rotated,t,explicitMap(rotated,t));expect(compareAnalytic(source,t,result).worldJointRms).toBeLessThan(1e-5);
  expect(base.animation!.tracks.length).toBe(result.animation!.tracks.length);report.checks.push('explicit cm and90degree coordinate normalization');
 });
 for(const [label,start,end] of [['endpoint-equal',0,48],['subframe',.1,.2]] as const)it(`rejects ${label} Bezier translation motion between equal rest keys atomically`,()=>{
  const s=structuredClone(source),t=target('MT17-IDENTITY'),track=s.doc.animation!.tracks.find(row=>row.targetId===s.roles.head&&row.channel==='position.x')!;
  track.keys=[{id:'translation_a',time:start,value:0,interpolation:'bezier',tangentMode:'fixed',outSlope:1},{id:'translation_b',time:end,value:0,interpolation:'bezier',tangentMode:'fixed',inSlope:-1}];
  expect(evaluateCurve(track.keys,(start+end)/2)).toBeCloseTo((end-start)/4,12);
  if(label==='subframe')for(let frame=0;frame<=48;frame++)expect(evaluateCurve(track.keys,frame)).toBe(0);
  const store=createSceneStore(t.doc),sourceBefore=snapshot(s),targetBefore=snapshot(t);
  for(const run of [()=>validateMapping(s,t,explicitMap(s,t)),()=>mapOriginal(s,t,explicitMap(s,t)),()=>mapSkeletonUtils(s,t,explicitMap(s,t)),()=>commitBake(store,s,t,explicitMap(s,t))])expect(run).toThrow(/Animated non-root translation/);
  expect(snapshot(s)).toBe(sourceBefore);expect(snapshot(t)).toBe(targetBefore);expect(store.getState().document).toBe(t.doc);expect(store.temporal.getState().pastStates).toHaveLength(0);
  report.checks.push(`rejected ${label} non-root Bezier motion continuously and atomically`);
 });
 it('accepts a genuinely constant weighted Bezier non-root translation',()=>{
  const s=structuredClone(source),t=target('MT17-IDENTITY'),track=s.doc.animation!.tracks.find(row=>row.targetId===s.roles.head&&row.channel==='position.x')!;
  track.keys=[{id:'constant_a',time:0,value:0,interpolation:'bezier',tangentMode:'fixed',outSlope:0,outWeight:.8},{id:'constant_b',time:48,value:0,interpolation:'bezier',tangentMode:'fixed',inSlope:0,inWeight:.2}];
  expect(()=>validateMapping(s,t,explicitMap(s,t))).not.toThrow();expect(compareAnalytic(s,t,mapOriginal(s,t,explicitMap(s,t))).worldJointRms).toBeLessThan(1e-5);
 });
 for(const side of ['source','target'] as const)for(const list of ['document','reference'] as const)it(`rejects duplicate ${side} ${list} names before comparator adapters mutate anything`,()=>{
  const s=structuredClone(source),t=target('MT17-IDENTITY'),rig=side==='source'?s:t,joints=list==='document'?rig.doc.joints!:rig.reference;
  joints.find(j=>j.id===rig.roles.rightUpperArm)!.name=joints.find(j=>j.id===rig.roles.leftUpperArm)!.name;
  const mapping=explicitMap(s,t);expect(()=>validateMapping(s,t,mapping)).not.toThrow();
  const sourceBefore=snapshot(s),targetBefore=snapshot(t);
  expect(()=>mapSkeletonUtils(s,t,mapping)).toThrow(new RegExp(`Comparator ${side} bone names must be nonempty and unique`));
  expect(snapshot(s)).toBe(sourceBefore);expect(snapshot(t)).toBe(targetBefore);report.checks.push(`rejected duplicate comparator ${side} ${list} bone names`);
 });
 const negativeCases:[string,(s:Rig,t:Rig,m:ReturnType<typeof explicitMap>)=>void][]=[
  ['missing role',(s)=>{delete (s.roles as any).head;}],['duplicate role',(s)=>{s.roles.head=s.roles.neck;}],
  ['cycle',(_s,t)=>{t.doc.joints![0].parentId=t.roles.head;}],['extra twist',(_s,t)=>{t.doc.joints!.push({id:'twist',name:'twist',parentId:t.roles.chest,position:[0,1,0]});}],
  ['missing reference',(s)=>{s.reference.pop();}],['bad mapping',(_s,_t,m)=>{m[1].targetId=m[0].targetId;}],
  ['unbounded source duration',(s)=>{s.doc.animation!.end=1000;}],['unknown units',(s)=>{s.coordinates.metersPerUnit=NaN;}],['unknown axes',(s)=>{s.coordinates.up='unknown';}],['improper basis',(s)=>{s.coordinates.basis=[0,0,0,2];}],
  ['nonuniform scale',(s)=>{s.jointScales={[s.roles.hips]:[1,2,1]};}],['negative scale',(s)=>{s.jointScales={[s.roles.hips]:[-1,-1,-1]};}],['animated scale',(s)=>{s.animatedScale=true;}],
  ['animated scale track',(s)=>{s.doc.animation!.tracks[0].channel='scale.x';}],['animated nonroot translation',(s)=>{s.doc.animation!.tracks.find(t=>t.targetId===s.roles.head&&t.channel==='position.x')!.keys[0].value=1;}],
  ['occupied target',(_s,t)=>{t.doc.animation={...defaultAnimation(),tracks:[{id:'occupied',targetId:t.roles.hips,channel:'position.x',keys:[]}]};}],
  ['independent skinned node',(s,t)=>{s.doc.nodes=structuredClone(t.doc.nodes);s.doc.rootIds=[...t.doc.rootIds];const sk=shape(s.doc).skin!;sk.jointIds=sk.jointIds.map((_,i)=>[s.roles.hips,s.roles.leftHand,s.roles.leftFoot][i]);s.doc.animation!.tracks.push({id:'mesh_track',targetId:'mt_mesh',channel:'position.x',keys:[]});}],
 ];
 for(const [label,mutate] of negativeCases)it(`rejects ${label} atomically before commit`,()=>{
  const s=structuredClone(source),t=target('MT17-IDENTITY'),m=explicitMap(s,t);mutate(s,t,m);const store=createSceneStore(t.doc),before=snapshot(t.doc);
  expect(()=>commitBake(store,s,t,m)).toThrow();expect(store.getState().document).toBe(t.doc);expect(snapshot(t.doc)).toBe(before);expect(store.temporal.getState().pastStates).toHaveLength(0);report.checks.push(`rejected ${label} atomically`);
 });
});
