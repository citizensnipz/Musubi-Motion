import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Vector3 } from 'three';
import { importFBX } from '../src/fbx-import.ts';
import { evaluateCurve, evaluateSceneAnimation } from '../src/animation.ts';
import { decodeProject, encodeProject } from '../src/project-archive.ts';
import { emptyScene, type MeshShapeNode, type Vec3 } from '../src/scene-document.ts';
import { createSceneStore } from '../src/scene-store.ts';
import { jointWorldMatrices } from '../src/ik.ts';
import { deformMeshPositions } from '../src/mesh-skin.ts';
import { FRAMES, ROLES, explicitMap, mapOriginal, mapSkeletonUtils, targetFixture, compareAnalytic, world, type Rig, type Role } from '../scripts/motion-transfer-experiment/harness.ts';
import { ROOT_POLICIES, helperGridDiagnostic, alignedGridDiagnostic, applyRootPolicy, calibratedContacts, commitCalibration, mapCalibration, poseDifference, rootMismatch, type RootPolicy } from '../scripts/motion-transfer-experiment/calibration.ts';
const fixtureDir=resolve('tests/fixtures/motion-transfer'),meta=JSON.parse(readFileSync(resolve(fixtureDir,'MT17-reference.json'),'utf8'));
const variants=['MT17-IDENTITY','MT17-SCALE08','MT17-PROPORTION','MT17-BASIS'];
const commonFrames=[...new Set([...FRAMES,...Array.from({length:48},(_,i)=>48*i/47),48-1e-6])].sort((a,b)=>a-b);
const shuffled=[...FRAMES.filter((_,i)=>i%2===1).reverse(),...FRAMES.filter((_,i)=>i%2===0)];
const editor={camera:{position:[0,1,5] as Vec3,target:[0,1,0] as Vec3,fov:45,near:.01,far:1000},time:0};
const report:any={startedUTC:new Date().toISOString(),node:process.version,three:'0.180.0',rootPolicies:ROOT_POLICIES,grid:{nativeEvaluationFrames:FRAMES,shuffledFrames:shuffled,commonEvaluationFrames:commonFrames,measuredHelper:{requestedFps:24,sampleCount:48,idealDeltaSeconds:2/47},diagnostic:{requestedFps:24.5,sampleCount:49,idealDeltaSeconds:1/24},interpretation:'All compared by common physical time, never by array index. aligned49 is a separate diagnostic parameter, not a24fps helper fix.'},gates:{slip:.02,penetration:.01,symmetricAbsoluteFloorDistance:.01,units:'target leg lengths',meaning:'Exploratory diagnostics only; no production guarantee, contact correction or adoption.'},variants:{},checks:[]};
const output=process.env.MT17_CALIBRATION_EVIDENCE;
const snapshot=(v:unknown)=>JSON.stringify(v),hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
let source:Rig;
beforeAll(async()=>{
 const bytes=readFileSync(resolve(fixtureDir,'MT17-SOURCE-24.fbx')),imported=await importFBX(new File([bytes],'MT17-SOURCE-24.fbx'),emptyScene());
 const roles=Object.fromEntries(ROLES.map(role=>[role,imported.document.joints!.find(j=>j.name===role)!.id])) as Record<Role,string>;
 source={doc:imported.document,reference:meta.reference.map((r:any)=>({id:roles[r.role as Role],name:r.role,parentId:r.parent?roles[r.parent as Role]:null,position:r.position,rotation:r.rotation,orientation:[0,0,0]})),roles,coordinates:{metersPerUnit:meta.metersPerUnit,up:meta.up,forward:meta.forward,basis:meta.basis}};
 report.source={sha256:hash(bytes),referenceSha256:hash(readFileSync(resolve(fixtureDir,'MT17-reference.json'))),sourceContacts:calibratedContacts(source,meta.stances)};
 if(output)mkdirSync(output,{recursive:true});
});
afterAll(()=>{report.finishedUTC=new Date().toISOString();if(output)writeFileSync(resolve(output,'calibration-metrics.json'),JSON.stringify(report,null,2)+'\n');});

describe('bounded offline MT17 anchoring and common-time sample calibration',()=>{
 for(const variant of variants) it(`compares explicit root policies and real helper grids on ${variant}`,async()=>{
  const target=targetFixture(meta.reference,variant),mapping=explicitMap(source,target),sourceBefore=snapshot(source),targetBefore=snapshot(target);
  const original=mapOriginal(source,target,mapping),measured=mapSkeletonUtils(source,target,mapping),aligned=alignedGridDiagnostic(source,target,mapping),control=helperGridDiagnostic(source,target,mapping,24);
  expect(poseDifference(target,measured.doc,control.doc,commonFrames).maxPositionMeters).toBe(0);
  expect(poseDifference(target,measured.doc,control.doc,commonFrames).maxOrientationDegrees).toBeLessThan(1e-5);
  expect(control.grid.emittedTimes).toHaveLength(48);control.grid.emittedTimes.forEach((time,i)=>expect(Math.abs(time-i*2/47)).toBeLessThan(1e-7));
  expect(aligned.grid.emittedTimes).toHaveLength(49);expect(aligned.grid.emittedTimes[0]).toBe(0);expect(aligned.grid.emittedTimes.at(-1)).toBe(2);
  aligned.grid.emittedTimes.forEach((time,i)=>expect(Math.abs(time-i/24)).toBeLessThan(1e-7));
  expect(measured.grid.helperSamples).toBe(48);expect(measured.grid.first).toBe(0);expect(measured.grid.last).toBe(2);expect(measured.grid.second).toBeCloseTo(2/47,7);
  const result:any={rootMismatch:rootMismatch(source,target),unchangedDefaultMetrics:compareAnalytic(source,target,original),unchangedMeasuredHelperMetrics:compareAnalytic(source,target,measured.doc),alignedGrid:aligned.grid,alignedOptions:aligned.options,measuredGrid:{...measured.grid,emittedTimes:control.grid.emittedTimes},measuredOptions:measured.options,policies:{}};
  expect(result.rootMismatch.sourceFrame0MinusReference[1]).toBeCloseTo(-.06,6);expect(result.rootMismatch.normalizedMagnitude).toBeCloseTo(1/15,6);
  for(const policy of ROOT_POLICIES) {
   const mapped=mapCalibration(source,target,mapping,policy),helper=applyRootPolicy(source,target,measured.doc,policy),diagnostic=applyRootPolicy(source,target,aligned.doc,policy);
   if(policy==='frame0-to-target-reference')expect(mapped).toEqual(original);
   const documents={original:mapped,measuredHelper:helper,aligned49Diagnostic:diagnostic},metrics:any={};
   for(const [method,doc] of Object.entries(documents)) {
    const rig={...target,doc},contacts=calibratedContacts(rig,meta.stances),replayed=calibratedContacts(rig,meta.stances,shuffled);
    for(const foot of ['leftFoot','rightFoot'])contacts[foot].forEach((row,i)=>{
     for(const key of Object.keys(row)) typeof row[key as keyof typeof row]==='number'?expect(replayed[foot][i][key as keyof typeof row]).toBeCloseTo(row[key as keyof typeof row] as number,13):expect(replayed[foot][i][key as keyof typeof row]).toBe(row[key as keyof typeof row]);
     expect(row.onsetDiscontinuity).toBeLessThan(1e-5);expect(row.offsetDiscontinuity).toBeLessThan(1e-5);
    });
    const bytes=await encodeProject(doc,new Map(),editor),decoded=await decodeProject(bytes);
    expect(decoded.scene).toEqual(doc);expect(decoded.scene.joints).toEqual(target.doc.joints);expect(decoded.scene.nodes).toEqual(target.doc.nodes);expect(decoded.scene.animation?.layers??[]).toHaveLength(0);
    const shape=doc.nodes.mt_shape as MeshShapeNode;
    for(const frame of FRAMES) {
     const a=jointWorldMatrices(doc,evaluateSceneAnimation(doc,frame)),b=jointWorldMatrices(decoded.scene,evaluateSceneAnimation(decoded.scene,frame));
     expect([...a].map(([id,m])=>[id,m.toArray()])).toEqual([...b].map(([id,m])=>[id,m.toArray()]));
     expect(Array.from(deformMeshPositions(shape,id=>a.get(id)))).toEqual(Array.from(deformMeshPositions(decoded.scene.nodes.mt_shape as MeshShapeNode,id=>b.get(id))));
    }
    const forward=FRAMES.map(frame=>[...world(rig,frame)].map(([id,p])=>[id,p.position.toArray(),p.quaternion.toArray()]));
    for(const frame of shuffled)expect([...world(rig,frame)].map(([id,p])=>[id,p.position.toArray(),p.quaternion.toArray()])).toEqual(forward[FRAMES.indexOf(frame)]);
    metrics[method]={contacts,integerContacts:calibratedContacts(rig,meta.stances,FRAMES.filter(Number.isInteger)),fractionalContacts:calibratedContacts(rig,meta.stances,FRAMES.filter(f=>!Number.isInteger(f))),fractionalPoseDifferenceFromOriginal:poseDifference(target,mapped,doc,FRAMES.filter(f=>!Number.isInteger(f))),commonTimeDifferenceFromOriginal:poseDifference(target,mapped,doc,commonFrames),endpointsDifferenceFromOriginal:poseDifference(target,mapped,doc,[0,48]),archive:{bytes:bytes.length,sha256:hash(bytes),sceneVersion:decoded.scene.version},checks:{immutable:true,shuffledOrder:true,currentFormatRoundtrip:true,skinRoundtrip:true}};
    if(output){const name=`${variant}.${policy}.${method}`;writeFileSync(resolve(output,`${name}.msb`),bytes);writeFileSync(resolve(output,`${name}.trajectories.json`),JSON.stringify(commonFrames.map(frame=>({frame,seconds:frame/24,poses:Object.fromEntries([...world(rig,frame)].map(([id,p])=>[id,{position:p.position.toArray(),quaternion:p.quaternion.toArray()}]))}))));}
   }
   // Fresh Base-only commit is one atomic edit, and persistence has not changed authored data.
   const store=createSceneStore(target.doc);commitCalibration(store,source,target,mapping,policy);expect(store.temporal.getState().pastStates).toHaveLength(1);expect(store.getState().document).toEqual(mapped);
   store.temporal.getState().undo();expect(store.getState().document).toBe(target.doc);store.temporal.getState().redo();expect(store.getState().document).toEqual(mapped);
   const rows=Object.values(metrics.original.contacts).flat() as ReturnType<typeof calibratedContacts>[string];
   if(policy==='frame0-to-target-reference')for(const row of rows){expect(row.passesSlip).toBe(true);expect(row.passesPenetration).toBe(true);expect(row.passesSymmetricFloorDistance).toBe(false);expect(row.clearanceMax).toBeGreaterThan(.06);}
   if(policy==='reference-relative-xyz'&&variant!=='MT17-PROPORTION')for(const row of rows)expect(row.passesSymmetricFloorDistance).toBe(true);
   metrics.sampleGridComparison={commonTime:poseDifference(target,helper,diagnostic,commonFrames),integerTime:poseDifference(target,helper,diagnostic,FRAMES.filter(Number.isInteger)),fractionalTime:poseDifference(target,helper,diagnostic,FRAMES.filter(f=>!Number.isInteger(f))),endpoint:poseDifference(target,helper,diagnostic,[0,48])};
   expect(metrics.original.commonTimeDifferenceFromOriginal.maxPositionMeters).toBe(0);
   expect(metrics.aligned49Diagnostic.commonTimeDifferenceFromOriginal.maxOrientationDegrees).toBeLessThan(.001);
   expect(metrics.measuredHelper.commonTimeDifferenceFromOriginal.maxOrientationDegrees).toBeGreaterThan(.1);
   result.policies[policy]=metrics;
  }
  expect(snapshot(source)).toBe(sourceBefore);expect(snapshot(target)).toBe(targetBefore);report.variants[variant]=result;
 });
 it('uses reference-relative XYZ in explicit proper units/basis instead of vertical-only correction',()=>{
  const s=structuredClone(source),t=targetFixture(meta.reference,'MT17-IDENTITY');
  t.coordinates={...t.coordinates,metersPerUnit:.01,basis:[0,Math.SQRT1_2,0,Math.SQRT1_2]};
  // Move the supplied source reference only: the calibration must retain all three differences.
  s.reference.find(j=>j.id===s.roles.hips)!.position=[.12,.92,-.2];
  const m=explicitMap(s,t),base=mapCalibration(s,t,m,'frame0-to-target-reference'),relative=mapCalibration(s,t,m,'reference-relative-xyz');
  const mismatch=rootMismatch(s,t),delta=new Vector3(...mismatch.targetReferenceRelativeMinusFrame0Policy);
  expect(mismatch.sourceFrame0MinusReference[0]).toBeCloseTo(-.12,6);expect(mismatch.sourceFrame0MinusReference[1]).toBeCloseTo(-.08,6);expect(mismatch.sourceFrame0MinusReference[2]).toBeCloseTo(.2,6);
  expect(delta.x).toBeCloseTo(-.0012,6);expect(delta.y).toBeCloseTo(-.0008,6);expect(delta.z).toBeCloseTo(.002,6);
  for(const frame of FRAMES){const a=world({...t,doc:base},frame).get(t.roles.hips)!.position,b=world({...t,doc:relative},frame).get(t.roles.hips)!.position;expect(b.clone().sub(a).distanceTo(delta)).toBeLessThan(1e-12);}
 });
 it('rejects unknown policy and stale target with zero history',()=>{
  const t=targetFixture(meta.reference,'MT17-IDENTITY'),store=createSceneStore(t.doc),mapping=explicitMap(source,t),before=snapshot(t);
  expect(()=>helperGridDiagnostic(source,t,mapping,1e9 as 24)).toThrow(/Unsupported diagnostic grid/);
  expect(()=>commitCalibration(store,source,t,mapping,'implicit' as RootPolicy)).toThrow(/Unknown explicit/);expect(store.getState().document).toBe(t.doc);expect(store.temporal.getState().pastStates).toHaveLength(0);
  const stale={...t,doc:structuredClone(t.doc)};expect(()=>commitCalibration(store,source,stale,mapping,ROOT_POLICIES[0])).toThrow(/Stale/);expect(snapshot(t)).toBe(before);expect(store.temporal.getState().pastStates).toHaveLength(0);
 });
 for(const [start,end] of [[0,48],[.1,.2]])it(`retains continuous fixed Bezier translation rejection at ${start}..${end}`,()=>{
  const s=structuredClone(source),t=targetFixture(meta.reference,'MT17-IDENTITY'),track=s.doc.animation!.tracks.find(row=>row.targetId===s.roles.head&&row.channel==='position.x')!;
  track.keys=[{id:'a',time:start,value:0,interpolation:'bezier',tangentMode:'fixed',outSlope:1},{id:'b',time:end,value:0,interpolation:'bezier',tangentMode:'fixed',inSlope:-1}];expect(evaluateCurve(track.keys,(start+end)/2)).toBeGreaterThan(0);
  const before=snapshot(s),targetBefore=snapshot(t),mapping=explicitMap(s,t);
  for(const policy of ROOT_POLICIES){const store=createSceneStore(t.doc);expect(()=>commitCalibration(store,s,t,mapping,policy)).toThrow(/Animated non-root translation/);expect(store.getState().document).toBe(t.doc);expect(store.temporal.getState().pastStates).toHaveLength(0);}
  expect(()=>alignedGridDiagnostic(s,t,mapping)).toThrow(/Animated non-root translation/);expect(snapshot(s)).toBe(before);expect(snapshot(t)).toBe(targetBefore);
 });
 for(const side of ['source','target'] as const)for(const list of ['document','reference'] as const)it(`rejects aligned comparator ${side}/${list} name collision before mutation`,()=>{
  const s=structuredClone(source),t=targetFixture(meta.reference,'MT17-IDENTITY'),rig=side==='source'?s:t,joints=list==='document'?rig.doc.joints!:rig.reference;
  joints.find(j=>j.id===rig.roles.rightUpperArm)!.name=joints.find(j=>j.id===rig.roles.leftUpperArm)!.name;
  const before=snapshot(s),targetBefore=snapshot(t);expect(()=>alignedGridDiagnostic(s,t,explicitMap(s,t))).toThrow(/names must be nonempty and unique/);expect(snapshot(s)).toBe(before);expect(snapshot(t)).toBe(targetBefore);
 });
 it('flags symmetric lift and penetration, retaining independent slip and penetration gates',()=>{
  const t=targetFixture(meta.reference,'MT17-IDENTITY');for(const offset of [.06,-.06]){
   const rig=structuredClone(t);rig.doc.joints!.find(j=>j.id===rig.roles.hips)!.position[1]+=offset;
   const rows=Object.values(calibratedContacts(rig,{leftFoot:[[0,12]],rightFoot:[[0,24]]})).flat();
   for(const row of rows){expect(row.passesSlip).toBe(true);expect(row.passesSymmetricFloorDistance).toBe(false);expect(row.passesPenetration).toBe(offset>0);expect(row.passesAllExploratoryGates).toBe(false);}
  }
 });
});


