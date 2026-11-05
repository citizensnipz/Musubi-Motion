import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { importFBX } from '../src/fbx-import.ts';
import { evaluateSceneAnimation } from '../src/animation.ts';
import { decodeProject, encodeProject } from '../src/project-archive.ts';
import { emptyScene, type MeshShapeNode, type Vec3 } from '../src/scene-document.ts';
import { createSceneStore } from '../src/scene-store.ts';
import { jointWorldMatrices } from '../src/ik.ts';
import { deformMeshPositions } from '../src/mesh-skin.ts';
import { FRAMES, ROLES, explicitMap, mapOriginal, mapSkeletonUtils, targetFixture, compareAnalytic, world, type Rig, type Role } from '../scripts/motion-transfer-experiment/harness.ts';
import { ROOT_POLICIES, alignedGridDiagnostic, applyRootPolicy, calibratedContacts, commitCalibration, mapCalibration, poseDifference, rootMismatch } from '../scripts/motion-transfer-experiment/calibration.ts';
import { STRESS_VARIANTS, stressFixture, stressGrids, type StressVariant } from '../scripts/motion-transfer-experiment/stress-fixtures.ts';

const fixtureDir=resolve('tests/fixtures/motion-transfer'),meta=JSON.parse(readFileSync(resolve(fixtureDir,'MT17-reference.json'),'utf8'));
const targets=['MT17-IDENTITY','MT17-SCALE08','MT17-PROPORTION','MT17-BASIS'];
const editor={camera:{position:[0,1,5] as Vec3,target:[0,1,0] as Vec3,fov:45,near:.01,far:1000},time:0};
const snapshot=(v:unknown)=>JSON.stringify(v),hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const output=process.env.MT17_STRESS_EVIDENCE;
const report:any={startedUTC:new Date().toISOString(),node:process.version,three:'0.180.0',source:{},gates:{slip:.02,penetration:.01,symmetricAbsoluteFloorDistance:.01,units:'target reference leg lengths',meaning:'Exploratory sampled diagnostics only. Passing is not transfer correctness or contact preservation.'},interpretation:'Identical real times compare paths; helper48 requested24fps and aligned49 requested24.5fps remain separate unmodified diagnostics. Fractional authored keys can be lost by all integer49 bakes. Boundary variation is +/-1e-6frame, not a discontinuity proof; 0/48 use existing zero sentinel. No contact correction or policy adoption.',variants:{}};
let source:Rig;
beforeAll(async()=>{
 const bytes=readFileSync(resolve(fixtureDir,'MT17-SOURCE-24.fbx')),imported=await importFBX(new File([bytes],'MT17-SOURCE-24.fbx'),emptyScene());
 const roles=Object.fromEntries(ROLES.map(role=>[role,imported.document.joints!.find(j=>j.name===role)!.id])) as Record<Role,string>;
 source={doc:imported.document,reference:meta.reference.map((r:any)=>({id:roles[r.role as Role],name:r.role,parentId:r.parent?roles[r.parent as Role]:null,position:r.position,rotation:r.rotation,orientation:[0,0,0]})),roles,coordinates:{metersPerUnit:meta.metersPerUnit,up:meta.up,forward:meta.forward,basis:meta.basis}};
 report.source={fbxSha256:hash(bytes),referenceSha256:hash(readFileSync(resolve(fixtureDir,'MT17-reference.json'))),helperSha256:hash(readFileSync(createRequire(import.meta.url).resolve('three/addons/utils/SkeletonUtils.js')))};
 if(output)mkdirSync(output,{recursive:true});
});
afterAll(()=>{report.finishedUTC=new Date().toISOString();if(output)writeFileSync(resolve(output,'stress-metrics.json'),JSON.stringify(report,null,2)+'\n');});

type Contacts=ReturnType<typeof calibratedContacts>;
const decisions=(contacts:Contacts)=>Object.fromEntries(Object.entries(contacts).map(([foot,rows])=>[foot,rows.map(row=>({start:row.start,end:row.end,slip:row.passesSlip,penetration:row.passesPenetration,floor:row.passesSymmetricFloorDistance,all:row.passesAllExploratoryGates}))]));
function compareDecisions(sparse:Contacts,dense:Contacts) {
 return Object.fromEntries(Object.entries(sparse).map(([foot,rows])=>[foot,rows.map((row,i)=>({start:row.start,end:row.end,sparseSamples:row.samples,denseSamples:dense[foot][i].samples,slipSame:row.passesSlip===dense[foot][i].passesSlip,penetrationSame:row.passesPenetration===dense[foot][i].passesPenetration,floorSame:row.passesSymmetricFloorDistance===dense[foot][i].passesSymmetricFloorDistance,allSame:row.passesAllExploratoryGates===dense[foot][i].passesAllExploratoryGates,horizontalMaxDenseMinusSparse:dense[foot][i].horizontalMax-row.horizontalMax,verticalMaxDenseMinusSparse:dense[foot][i].verticalMax-row.verticalMax}))]));
}
function poses(rig:Rig,frame:number) {return [...world(rig,frame)].map(([id,p])=>[id,p.position.toArray(),p.quaternion.toArray()]);}

describe('original bounded offline contact/grid stress diagnostics',()=>{
 it('authors exactly three independent deterministic variants without mutating owned source/reference/fallback',()=>{
  const before=snapshot(source);expect(STRESS_VARIANTS).toHaveLength(3);expect(FRAMES).toHaveLength(53);
  for(const id of STRESS_VARIANTS){const a=stressFixture(source,id),b=stressFixture(source,id);expect(a).toEqual(b);expect(a.source.doc.joints).toEqual(source.doc.joints);expect(a.source.reference).toEqual(source.reference);expect(a.source.coordinates).toEqual(source.coordinates);expect(a.source.doc.nodes).toEqual(source.doc.nodes);expect(a.source.doc.animation?.layers??[]).toHaveLength(0);expect(a.source.doc.joints).toHaveLength(17);expect(a.source.doc.animation).toMatchObject({fps:24,start:0,end:48});expect(stressGrids(a).dense).toHaveLength(385);}
  expect(stressFixture(source,'fractional-boundaries').authoredFrames.filter(f=>!Number.isInteger(f))).toEqual([12.375,24.375,35.625,47.625]);
  expect(()=>stressFixture(source,'unsupported' as StressVariant)).toThrow(/Unknown bounded/);expect(snapshot(source)).toBe(before);
 });
 for(const id of STRESS_VARIANTS)for(const name of targets)it(`measures ${id} on ${name}`,async()=>{
  const inputBefore=snapshot(source),fixture=stressFixture(source,id),s=fixture.source,t=targetFixture(meta.reference,name),sourceBefore=snapshot(s),targetBefore=snapshot(t),mapping=explicitMap(s,t),grids=stressGrids(fixture);
  const measured=mapSkeletonUtils(s,t,mapping),aligned=alignedGridDiagnostic(s,t,mapping),original=mapOriginal(s,t,mapping);
  expect(measured.grid.helperSamples).toBe(48);expect(aligned.grid.emittedTimes).toHaveLength(49);aligned.grid.emittedTimes.forEach((v,i)=>expect(Math.abs(v-i/24)).toBeLessThan(1e-7));
  const entry:any={parameters:fixture.parameters,authoredFrames:fixture.authoredFrames,stances:fixture.stances,sourceContacts:{sparse:calibratedContacts(s,fixture.stances),dense:calibratedContacts(s,fixture.stances,grids.dense),boundaries:calibratedContacts(s,fixture.stances,grids.boundaries)},rootMismatch:rootMismatch(s,t),grids:{sparse:FRAMES,...grids,measured48:measured.grid,aligned49:aligned.grid},unchangedOriginalAnalytic:compareAnalytic(s,t,original,grids.common),policies:{}};
  for(const policy of ROOT_POLICIES){
   const mapped=mapCalibration(s,t,mapping,policy),helper=applyRootPolicy(s,t,measured.doc,policy),diagnostic=applyRootPolicy(s,t,aligned.doc,policy),metrics:any={};
   if(policy==='frame0-to-target-reference')expect(mapped).toEqual(original);
   for(const [method,doc] of Object.entries({original:mapped,measuredHelper48:helper,aligned49Diagnostic:diagnostic})){
    const rig={...t,doc},contacts={sparse:calibratedContacts(rig,fixture.stances),dense:calibratedContacts(rig,fixture.stances,grids.dense),boundaries:calibratedContacts(rig,fixture.stances,grids.boundaries)};
    const shuffled=[...grids.dense.filter((_,i)=>i%2).reverse(),...grids.dense.filter((_,i)=>!(i%2))];
    const shuffledContacts=calibratedContacts(rig,fixture.stances,shuffled);
    for(const foot of ['leftFoot','rightFoot'])contacts.dense[foot].forEach((row,i)=>{
     for(const [key,value] of Object.entries(row))typeof value==='number'?expect(shuffledContacts[foot][i][key as keyof typeof row]).toBeCloseTo(value,12):expect(shuffledContacts[foot][i][key as keyof typeof row]).toBe(value);
     expect(row.onsetDiscontinuity).toBeLessThan(1e-5);expect(row.offsetDiscontinuity).toBeLessThan(1e-5);
    });
    const forward=new Map(grids.dense.map(frame=>[frame,poses(rig,frame)]));for(const frame of shuffled)expect(poses(rig,frame)).toEqual(forward.get(frame));
    const bytes=await encodeProject(doc,new Map(),editor),decoded=await decodeProject(bytes);expect(decoded.scene).toEqual(doc);expect(doc.joints).toEqual(t.doc.joints);expect(doc.nodes).toEqual(t.doc.nodes);expect(doc.animation?.layers??[]).toHaveLength(0);
    for(const frame of [...new Set([...FRAMES,...grids.boundaries])]){
     const a=jointWorldMatrices(doc,evaluateSceneAnimation(doc,frame)),b=jointWorldMatrices(decoded.scene,evaluateSceneAnimation(decoded.scene,frame));expect([...a].map(([id,m])=>[id,m.toArray()])).toEqual([...b].map(([id,m])=>[id,m.toArray()]));
     expect(Array.from(deformMeshPositions(doc.nodes.mt_shape as MeshShapeNode,id=>a.get(id)))).toEqual(Array.from(deformMeshPositions(decoded.scene.nodes.mt_shape as MeshShapeNode,id=>b.get(id))));
    }
    metrics[method]={contacts,gateDecisions:{sparse:decisions(contacts.sparse),dense:decisions(contacts.dense),boundaries:decisions(contacts.boundaries)},denseVersusSparse:compareDecisions(contacts.sparse,contacts.dense),commonTimeDifferenceFromOriginal:poseDifference(t,mapped,doc,grids.common),archive:{bytes:bytes.length,sha256:hash(bytes),sceneVersion:decoded.scene.version},checks:{immutableFallbackBind:true,shuffledOrder:true,currentFormatRoundtrip:true,skinRoundtrip:true}};
    if(output)writeFileSync(resolve(output,`${id}.${name}.${policy}.${method}.msb`),bytes);
   }
   metrics.sampleGridComparison={commonTime:poseDifference(t,helper,diagnostic,grids.common),sparse:poseDifference(t,helper,diagnostic,FRAMES),dense:poseDifference(t,helper,diagnostic,grids.dense),boundaries:poseDifference(t,helper,diagnostic,grids.boundaries),endpoint:poseDifference(t,helper,diagnostic,[0,48])};
   // Preserve measured counterexamples at the unchanged diagnostic thresholds.
   // These assertions test the gate comparison itself, not transfer correctness.
   if(id==='fractional-boundaries'&&name==='MT17-PROPORTION'&&policy==='reference-relative-xyz'){
    const rows=metrics.original.contacts;
    expect(rows.sparse.rightFoot[0].passesAllExploratoryGates).toBe(true);
    expect(rows.dense.rightFoot[0].passesSlip).toBe(false);
    expect(rows.boundaries.rightFoot[0].passesSlip).toBe(false);
    expect(rows.sparse.rightFoot[1].passesAllExploratoryGates).toBe(true);
    expect(rows.dense.rightFoot[1].passesSymmetricFloorDistance).toBe(false);
    expect(rows.boundaries.rightFoot[1].passesSymmetricFloorDistance).toBe(false);
   }
   if(id==='shorter-faster-swing')expect(metrics.sampleGridComparison.commonTime.maxOrientationDegrees).toBeGreaterThan(1.5);
   const store=createSceneStore(t.doc);commitCalibration(store,s,t,mapping,policy);expect(store.temporal.getState().pastStates).toHaveLength(1);expect(store.getState().document).toEqual(mapped);store.temporal.getState().undo();expect(store.getState().document).toBe(t.doc);store.temporal.getState().redo();expect(store.getState().document).toEqual(mapped);
   entry.policies[policy]=metrics;
  }
  const bad=structuredClone(s);bad.animatedScale=true;for(const policy of ROOT_POLICIES){const store=createSceneStore(t.doc);expect(()=>commitCalibration(store,bad,t,mapping,policy)).toThrow(/Animated scale/);expect(store.getState().document).toBe(t.doc);expect(store.temporal.getState().pastStates).toHaveLength(0);}expect(()=>alignedGridDiagnostic(bad,t,mapping)).toThrow(/Animated scale/);
  expect(snapshot(s)).toBe(sourceBefore);expect(snapshot(t)).toBe(targetBefore);expect(snapshot(source)).toBe(inputBefore);report.variants[`${id}.${name}`]=entry;
 },120000);
});
