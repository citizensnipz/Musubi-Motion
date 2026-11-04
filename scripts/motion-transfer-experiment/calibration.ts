/** Original Apache-2.0 offline calibration. No editor entry point or policy adoption. */
import { AnimationClip, AnimationMixer, Bone, BufferGeometry, LoopOnce, Matrix4, MeshBasicMaterial, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Vector3, VectorKeyframeTrack } from 'three';
import { retargetClip } from 'three/addons/utils/SkeletonUtils.js';
import { defaultAnimation, type AnimationTrack } from '../../src/animation.ts';
import { jointRotationFromQuaternion } from '../../src/joint-transform.ts';
import { validateScene } from '../../src/project-archive.ts';
import type { SceneDocument, Vec3 } from '../../src/scene-document.ts';
import type { SceneStore } from '../../src/scene-store.ts';
import { FRAMES, ROLES, legLength, mapOriginal, validateMapping, world, type Mapping, type Rig, type Role } from './harness.ts';

export const ROOT_POLICIES = ['frame0-to-target-reference', 'reference-relative-xyz'] as const;
export type RootPolicy = typeof ROOT_POLICIES[number];
function check(ok: unknown, message: string): asserts ok { if (!ok) throw Error(message); }
function requirePolicy(policy: RootPolicy) { check(ROOT_POLICIES.includes(policy), 'Unknown explicit calibration root policy'); }
function targetBasis(target: Rig) { return new Quaternion(...target.coordinates.basis as [number,number,number,number]); }
/** Canonical meter offset; all XYZ components are retained, never inferred from contacts. */
export function rootMismatch(source: Rig, target: Rig) {
 const frame0 = world(source,0).get(source.roles.hips)!.position;
 const reference = world(source,undefined,true).get(source.roles.hips)!.position;
 const sourceDelta = frame0.clone().sub(reference);
 const targetDelta = sourceDelta.clone().multiplyScalar(legLength(target)/legLength(source));
 return {sourceFrame0:frame0.toArray(),sourceReference:reference.toArray(),sourceFrame0MinusReference:sourceDelta.toArray(),targetReferenceRelativeMinusFrame0Policy:targetDelta.toArray(),normalizedMagnitude:targetDelta.length()/legLength(target)};
}
/** Keeps mapOriginal byte-for-byte unchanged. A constant root-key translation selects the alternative. */
export function applyRootPolicy(source: Rig, target: Rig, baked: SceneDocument, policy: RootPolicy): SceneDocument {
 requirePolicy(policy);
 const doc=structuredClone(baked);
 if(policy==='reference-relative-xyz') {
  const delta=new Vector3(...rootMismatch(source,target).targetReferenceRelativeMinusFrame0Policy).applyQuaternion(targetBasis(target).invert()).divideScalar(target.coordinates.metersPerUnit);
  for(const track of doc.animation!.tracks) if(track.targetId===target.roles.hips&&track.channel.startsWith('position.')) {
   const axis='xyz'.indexOf(track.channel.at(-1)!);
   track.keys=track.keys.map(key=>({...key,value:key.value+delta.getComponent(axis)}));
  }
 }
 validateScene(doc); return doc;
}
export function mapCalibration(source: Rig, target: Rig, mapping: Mapping, policy: RootPolicy) {
 requirePolicy(policy);return applyRootPolicy(source,target,mapOriginal(source,target,mapping),policy);
}
export function commitCalibration(store: SceneStore, source: Rig, target: Rig, mapping: Mapping, policy: RootPolicy) {
 check(store.getState().document===target.doc,'Stale target revision');
 const doc=mapCalibration(source,target,mapping,policy);
 store.setState({document:doc,editLabel:`Offline calibration: ${policy}`});return doc;
}

/** Separate diagnostic adapter. Reuses the installed unmodified helper with explicit fps=24.5.
 * r180 computes round(duration*fps): this yields49 samples for a2s clip; it is NOT a24fps fix.
 * Same canonical reference adapters/options and49 quaternion input samples as TASK-006.
 */
export function helperGridDiagnostic(source: Rig,target: Rig,mapping: Mapping,requestedHelperFps:24|24.5) {
 check(requestedHelperFps===24||requestedHelperFps===24.5,'Unsupported diagnostic grid');
 validateMapping(source,target,mapping);
 // Preserve TASK-006's name-addressed adapter rejection before allocating Three objects.
 for(const [label,rig] of [['source',source],['target',target]] as const) for(const joints of [rig.doc.joints!,rig.reference]) {
  const names=joints.map(j=>j.name);
  check(names.every(name=>typeof name==='string'&&name.trim().length>0)&&new Set(names).size===names.length,`Comparator ${label} bone names must be nonempty and unique`);
 }
 function adapter(rig:Rig) {
  const ref=world(rig,undefined,true),mesh=new SkinnedMesh(new BufferGeometry(),new MeshBasicMaterial()),bones=new Map<string,Bone>();
  for(const j of rig.reference) {
   const bone=new Bone(),pose=ref.get(j.id)!,parent=j.parentId?ref.get(j.parentId):undefined;bone.name=j.name;
   bone.position.copy(parent?pose.position.clone().sub(parent.position).applyQuaternion(parent.quaternion.clone().invert()):pose.position);
   bone.quaternion.copy(parent?parent.quaternion.clone().invert().multiply(pose.quaternion):pose.quaternion);bones.set(j.id,bone);
  }
  for(const j of rig.reference)(j.parentId?bones.get(j.parentId)!:mesh).add(bones.get(j.id)!);
  mesh.updateMatrixWorld(true);mesh.bind(new Skeleton(rig.reference.map(j=>bones.get(j.id)!)));
  return {mesh,bones,dispose(){mesh.skeleton.dispose();mesh.geometry.dispose();(mesh.material as MeshBasicMaterial).dispose();}};
 }
 const sa=adapter(source),ta=adapter(target),sr=world(source,undefined,true),tr=world(target,undefined,true);
 let mixer: AnimationMixer|undefined;
 try {
  const names:Record<string,string>={},offsets:Record<string,Matrix4>={},times=Array.from({length:49},(_,i)=>i/24),tracks=[];
  const sampled=Array.from({length:49},(_,frame)=>world(source,frame));
  for(const role of ROLES) {
   const sid=source.roles[role],tid=target.roles[role],joint=source.doc.joints!.find(j=>j.id===sid)!,values:number[]=[],positions:number[]=[];
   names[ta.bones.get(tid)!.name]=sa.bones.get(sid)!.name;
   offsets[ta.bones.get(tid)!.name]=new Matrix4().makeRotationFromQuaternion(sr.get(sid)!.quaternion.clone().invert().multiply(tr.get(tid)!.quaternion));
   for(const sample of sampled) {
    const pose=sample.get(sid)!,parent=joint.parentId?sample.get(joint.parentId):undefined;
    values.push(...(parent?parent.quaternion.clone().invert().multiply(pose.quaternion):pose.quaternion).toArray());
    positions.push(...(parent?pose.position.clone().sub(parent.position).applyQuaternion(parent.quaternion.clone().invert()):pose.position).toArray());
   }
   tracks.push(new QuaternionKeyframeTrack(`${sa.bones.get(sid)!.name}.quaternion`,times,values));
   if(role==='hips')tracks.push(new VectorKeyframeTrack(`${sa.bones.get(sid)!.name}.position`,times,positions));
  }
  const ratio=legLength(target)/legLength(source),s0=sampled[0].get(source.roles.hips)!.position,t0=tr.get(target.roles.hips)!.position;
  const options={names,hip:sa.bones.get(source.roles.hips)!.name,fps:requestedHelperFps,localOffsets:offsets,preserveBoneMatrix:true,preserveBonePositions:true,useTargetMatrix:false,useFirstFramePosition:false,scale:ratio,hipInfluence:new Vector3(1,1,1),hipPosition:t0.clone().divideScalar(ratio).sub(s0)};
  const input=new AnimationClip('MT17-aligned-grid-diagnostic',2,tracks),clip=retargetClip(ta.mesh,sa.mesh,input,options);
  const emittedTimes=Array.from(clip.tracks[0].times);
  const expectedCount=requestedHelperFps===24.5?49:48;
  check(clip.tracks.every(track=>track.times.length===expectedCount&&Array.from(track.times).every((time,i)=>Math.abs(time-i*2/(expectedCount-1))<1e-7)),'Diagnostic must actually emit its declared endpoint-inclusive grid');
  mixer=new AnimationMixer(ta.mesh);const action=mixer.clipAction(clip);action.setLoop(LoopOnce,1);action.clampWhenFinished=true;action.play();
  const previous=new Map<string,Vec3>(),inverse=targetBasis(target).invert(),native:AnimationTrack[]=[];
  const rows=new Map(target.doc.joints!.map(j=>[j.id,{positions:[] as Vec3[],rotations:[] as Vec3[]}]));
  for(let frame=0;frame<=48;frame++) {
   mixer.setTime(frame/24);ta.mesh.updateMatrixWorld(true);
   for(const joint of target.doc.joints!) {
    const bone=ta.bones.get(joint.id)!,q=joint.parentId?bone.quaternion:inverse.clone().multiply(bone.quaternion),rotation=jointRotationFromQuaternion(joint,q,previous.get(joint.id));previous.set(joint.id,rotation);
    rows.get(joint.id)!.rotations.push(rotation);
    rows.get(joint.id)!.positions.push(joint.parentId?[...joint.position] as Vec3:bone.position.clone().applyQuaternion(inverse).divideScalar(target.coordinates.metersPerUnit).toArray() as Vec3);
   }
  }
  for(const [id,row] of rows)for(const kind of ['position','rotation'] as const) {
   if(kind==='position'&&id!==target.roles.hips)continue;
   for(let axis=0;axis<3;axis++)native.push({id:`cal_${id}_${kind}_${axis}`,targetId:id,channel:`${kind}.${'xyz'[axis]}` as AnimationTrack['channel'],keys:(kind==='position'?row.positions:row.rotations).map((v,time)=>({id:`calk_${id}_${kind}_${axis}_${time}`,time,value:v[axis]===0?0:v[axis],interpolation:'linear',tangentMode:'auto'}))});
  }
  const doc={...target.doc,animation:{...defaultAnimation(),start:0,end:48,loop:false,tracks:native}};validateScene(doc);
  return {doc,grid:{label:requestedHelperFps===24.5?'aligned49 diagnostic, not measured fps24 helper':'fps24 adapter control, reproduces measured helper48',requestedHelperFps,sourceFps:24,durationSeconds:2,emittedTimes,allTrackSampleCounts:clip.tracks.map(t=>t.times.length),idealDelta:2/(expectedCount-1),endpointSourceTimeSeconds:2-1e-7,inputInterpolation:'Float32 position linear and local quaternion slerp; input sampled from native Euler evaluator at integer0..48',outputInterpolation:'Unmodified retargetClip quaternion slerp/position linear, then native49 linear unwrapped XYZ bake; final helper source update is1e-7seconds short of duration'},options:{names,hip:options.hip,fps:options.fps,scale:ratio,hipPosition:options.hipPosition.toArray(),useFirstFramePosition:false,preserveBonePositions:true,localOffsets:Object.fromEntries(Object.entries(offsets).map(([name,m])=>[name,m.toArray()]))}};
 } finally {if(mixer){mixer.stopAllAction();mixer.uncacheRoot(ta.mesh);}sa.dispose();ta.dispose();}
}

export function alignedGridDiagnostic(source:Rig,target:Rig,mapping:Mapping) {
 return helperGridDiagnostic(source,target,mapping,24.5);
}

export function poseDifference(target:Rig,a:SceneDocument,b:SceneDocument,frames=FRAMES) {
 let maxPositionMeters=0,maxOrientationDegrees=0,sum=0,count=0;
 for(const frame of frames) {
  const aw=world({...target,doc:a},frame),bw=world({...target,doc:b},frame);
  for(const role of ROLES) {const av=aw.get(target.roles[role])!,bv=bw.get(target.roles[role])!,distance=av.position.distanceTo(bv.position);sum+=distance*distance;count++;maxPositionMeters=Math.max(maxPositionMeters,distance);maxOrientationDegrees=Math.max(maxOrientationDegrees,av.quaternion.angleTo(bv.quaternion)*180/Math.PI);}
 }
 check(count>0,'Empty diagnostic sample grid');return {samples:frames.length,worldPositionRmsMeters:Math.sqrt(sum/count),maxPositionMeters,maxOrientationDegrees};
}
export function calibratedContacts(rig:Rig,stances:Record<string,number[][]>,frames=FRAMES,floorY=0) {
 const length=legLength(rig),out:Record<string,Array<{start:number;end:number;samples:number;horizontalRms:number;horizontalMax:number;verticalRms:number;verticalMax:number;clearanceMax:number;penetrationMax:number;onsetDiscontinuity:number;offsetDiscontinuity:number;passesSlip:boolean;passesPenetration:boolean;passesSymmetricFloorDistance:boolean;passesAllExploratoryGates:boolean}>>={};
 for(const [foot,intervals] of Object.entries(stances)) out[foot]=intervals.map(([start,end])=>{
  const p=(frame:number)=>world(rig,frame).get(rig.roles[foot as Role])!.position,anchor=p(start),inside=frames.filter(f=>f>=start&&f<=end);
  check(inside.length>0,'Empty stance diagnostic grid');let hs=0,hm=0,vs=0,vm=0,clearance=0,penetration=0;
  for(const frame of inside){const v=p(frame),h=Math.hypot(v.x-anchor.x,v.z-anchor.z)/length,y=(v.y-floorY)/length;hs+=h*h;hm=Math.max(hm,h);vs+=y*y;vm=Math.max(vm,Math.abs(y));clearance=Math.max(clearance,y);penetration=Math.max(penetration,-y);}
  const continuity=(frame:number)=>frame>0&&frame<48?p(frame+1e-6).distanceTo(p(frame-1e-6))/length:0;
  return {start,end,samples:inside.length,horizontalRms:Math.sqrt(hs/inside.length),horizontalMax:hm,verticalRms:Math.sqrt(vs/inside.length),verticalMax:vm,clearanceMax:clearance,penetrationMax:penetration,onsetDiscontinuity:continuity(start),offsetDiscontinuity:continuity(end),passesSlip:hm<=.02,passesPenetration:penetration<=.01,passesSymmetricFloorDistance:vm<=.01,passesAllExploratoryGates:hm<=.02&&penetration<=.01&&vm<=.01};
 });
 return out;
}


