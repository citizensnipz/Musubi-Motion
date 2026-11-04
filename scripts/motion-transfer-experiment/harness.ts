/** Offline experiment only. Original Apache-2.0 harness; no product import path uses this module. */
import { AnimationClip, AnimationMixer, Bone, BufferGeometry, Group, LoopOnce, Matrix4, MeshBasicMaterial, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Vector3, VectorKeyframeTrack } from 'three';
import { retargetClip } from 'three/addons/utils/SkeletonUtils.js';
import { defaultAnimation, evaluateSceneAnimation, tangentSlope, type AnimationChannel, type AnimationTrack, type CurveKey } from '../../src/animation.ts';
import { jointLocalQuaternion, jointRotationFromQuaternion } from '../../src/joint-transform.ts';
import { jointWorldMatrices } from '../../src/ik.ts';
import { validateScene } from '../../src/project-archive.ts';
import { emptyScene, type MeshShapeNode, type SceneDocument, type Vec3 } from '../../src/scene-document.ts';
import type { Joint } from '../../src/skeleton.ts';
import type { SceneStore } from '../../src/scene-store.ts';

export const ROLES = ['hips','spine','chest','neck','head','leftUpperArm','leftLowerArm','leftHand','rightUpperArm','rightLowerArm','rightHand','leftUpperLeg','leftLowerLeg','leftFoot','rightUpperLeg','rightLowerLeg','rightFoot'] as const;
export type Role = typeof ROLES[number];
const PARENTS = [null,'hips','spine','chest','neck','chest','leftUpperArm','leftLowerArm','chest','rightUpperArm','rightLowerArm','hips','leftUpperLeg','leftLowerLeg','hips','rightUpperLeg','rightLowerLeg'];
export type Coordinates = { metersPerUnit: number; up: string; forward: string; basis: number[] };
export type Rig = { doc: SceneDocument; reference: Joint[]; roles: Record<Role,string>; coordinates: Coordinates; jointScales?: Record<string,Vec3>; animatedScale?: boolean };
export type Mapping = { role: Role; sourceId: string; targetId: string }[];
export type Sample = { position: Vector3; quaternion: Quaternion };
export const FRAMES = [...Array.from({length:49},(_,i)=>i),.25,7.125,23.5,47.75];
const EPS = 1e-8;
function check(ok: unknown, message: string): asserts ok { if(!ok) throw Error(message); }
function basis(c:Coordinates) {
 check(Number.isFinite(c.metersPerUnit)&&c.metersPerUnit>0,'Unknown/nonpositive units');
 check(c.up==='Y'&&c.forward==='+Z','Unknown axes: supply normalized Y-up/+Z canonical convention');
 check(c.basis.length===4&&c.basis.every(Number.isFinite),'Unknown/improper basis');
 const q=new Quaternion(...c.basis as [number,number,number,number]);check(Math.abs(q.length()-1)<1e-8,'Basis must be proper unit quaternion');return q;
}
function raw(doc:SceneDocument,frame?:number) { return jointWorldMatrices(doc,frame===undefined?undefined:evaluateSceneAnimation(doc,frame)); }
export function world(rig:Rig,frame?:number,reference=false):Map<string,Sample> {
 const q=basis(rig.coordinates),worlds=raw(reference?{...emptyScene(),joints:rig.reference}:rig.doc,reference?undefined:frame);
 return new Map([...worlds].map(([id,m])=>[id,{position:new Vector3().setFromMatrixPosition(m).multiplyScalar(rig.coordinates.metersPerUnit).applyQuaternion(q),quaternion:q.clone().multiply(new Quaternion().setFromRotationMatrix(m)).normalize()}]));
}
export function legLength(rig:Rig) {
 const w=world(rig,undefined,true);let sum=0;
 for(const side of ['left','right']) {const ids=['UpperLeg','LowerLeg','Foot'].map(part=>rig.roles[(side+part) as Role]);sum+=w.get(ids[0])!.position.distanceTo(w.get(ids[1])!.position)+w.get(ids[1])!.position.distanceTo(w.get(ids[2])!.position);}
 check(Number.isFinite(sum)&&sum>EPS,'Zero leg length');return sum/2;
}
/** Convex-hull bound covers the complete scalar curve, including between sample frames. */
function staticTranslation(keys: readonly CurveKey[], rest: number, metersPerUnit: number) {
 const nearRest=(value:number)=>Number.isFinite(value)&&Math.abs(value-rest)*metersPerUnit<1e-7;
 if(!keys.every(key=>nearRest(key.value)))return false;
 for(let i=0;i+1<keys.length;i++) {
  const a=keys[i],b=keys[i+1];
  if(a.interpolation!=='bezier')continue;
  const duration=b.time-a.time;
  // Match the existing evaluator's effective tangent/weight semantics. A cubic
  // stays within its control-value hull, so this conservatively proves constancy
  // within the same physical tolerance without a sample-grid blind spot.
  if(!nearRest(a.value+tangentSlope(keys,i,'out')*duration*(a.outWeight??1/3))
   ||!nearRest(b.value-tangentSlope(keys,i+1,'in')*duration*(b.inWeight??1/3)))return false;
 }
 return true;
}
function validateRig(rig:Rig,source:boolean) {
 basis(rig.coordinates);validateScene(rig.doc);
 check(rig.doc.joints?.length===17&&rig.reference.length===17,'Unsupported intermediate/twist bones or missing joints');
 check(Object.keys(rig.roles).length===17&&ROLES.every(role=>rig.roles[role]),'Missing/extra semantic role');
 check(new Set(Object.values(rig.roles)).size===17,'Duplicate semantic role joint');
 for(const list of [rig.doc.joints!,rig.reference]) {
  const ids=new Set(list.map(j=>j.id));check(ids.size===17,'Duplicate joint IDs');
  for(let i=0;i<17;i++) {
   const joint=list.find(j=>j.id===rig.roles[ROLES[i]]);check(joint,'Missing reference role');
   check(joint.parentId===(PARENTS[i]===null?null:rig.roles[PARENTS[i] as Role]),'Unsupported topology/cycle');
   check([...joint.position,...joint.rotation??[0,0,0],...joint.orientation??[0,0,0]].every(Number.isFinite),'Nonfinite reference/pose');
  }
 }
 check(!rig.animatedScale,'Animated scale unsupported');
 for(const scale of Object.values(rig.jointScales??{})) check(scale.every(n=>Number.isFinite(n)&&n>0)&&Math.max(...scale)-Math.min(...scale)<EPS&&scale.every(n=>Math.abs(n-1)<EPS),'Unbaked/nonuniform/negative scale unsupported; bake constant uniform scale into explicit units and offsets');
 const anim=rig.doc.animation;
 if(source)check(anim?.fps===24&&anim.start===0&&anim.end===48,'Experiment accepts only0..48 at24fps; refuse silent truncation/resampling');
 check(!anim?.layers?.length&&!anim?.activeLayerId&&!rig.doc.drivenKeys?.length&&!rig.doc.constraints?.length&&!rig.doc.ikHandles?.length,'Experiment requires fresh Base-only unconstrained document');
 if(!source) check(!anim?.tracks.length,'Occupied target channels');
 for(const track of anim?.tracks??[]) {
  if(track.channel.startsWith('scale.')) throw Error('Animated scale unsupported');
  const joint=rig.doc.joints!.find(j=>j.id===track.targetId);
  if(!joint) {
   check(!Object.values(rig.doc.nodes).some(n=>n.type==='meshShape'&&n.skin&&n.parentId===track.targetId),'Independent animated SkinnedMesh-node transform unsupported');
   throw Error('Unsupported animation target');
  }
  check(/^position\.[xyz]$|^rotation\.[xyz]$/.test(track.channel),'Unsupported channel');
  if(joint.id!==rig.roles.hips&&track.channel.startsWith('position.')) {
   const ref=rig.reference.find(j=>j.id===joint.id)!;const axis='xyz'.indexOf(track.channel.at(-1)!);
   check(staticTranslation(track.keys,ref.position[axis],rig.coordinates.metersPerUnit),'Animated non-root translation unsupported');
  }
 }
 legLength(rig);
}
export function validateMapping(source:Rig,target:Rig,mapping:Mapping) {
 validateRig(source,true);validateRig(target,false);
 check(mapping.length===17&&new Set(mapping.map(m=>m.role)).size===17,'Missing/duplicate mapping roles');
 check(new Set(mapping.map(m=>m.sourceId)).size===17&&new Set(mapping.map(m=>m.targetId)).size===17,'Mapping must be bijective');
 check(ROLES.every(role=>mapping.some(m=>m.role===role&&m.sourceId===source.roles[role]&&m.targetId===target.roles[role])),'Explicit source-ID/target-ID mapping mismatch');
}
function keyTrack(id:string,channel:AnimationChannel,values:number[],frames:number[]):AnimationTrack {
 return {id:`mt_${id}_${channel.replace('.','_')}`,targetId:id,channel,keys:frames.map((time,i)=>({id:`mtk_${id}_${channel.replace('.','_')}_${i}`,time,value:values[i]===0?0:values[i],interpolation:'linear',tangentMode:'auto'}))};
}
function bake(target:Rig,sample:(frame:number)=>Map<string,{rotation:Vec3;position:Vec3}>,frames=Array.from({length:49},(_,i)=>i)) {
 check(frames.length*17*6<=100000&&frames[0]===0&&frames.at(-1)===48,'Frame/key budget');
 const rows=new Map<string,{positions:Vec3[];rotations:Vec3[]}>();
 for(const j of target.doc.joints!)rows.set(j.id,{positions:[],rotations:[]});
 for(const frame of frames) for(const [id,pose] of sample(frame)) { check([...pose.position,...pose.rotation].every(Number.isFinite),'Nonfinite bake');const row=rows.get(id)!;row.positions.push(pose.position);row.rotations.push(pose.rotation); }
 const tracks:AnimationTrack[]=[];
 for(const [id,row] of rows) for(const kind of ['position','rotation'] as const) {
  if(kind==='position'&&id!==target.roles.hips)continue;
  for(let axis=0;axis<3;axis++)tracks.push(keyTrack(id,`${kind}.${'xyz'[axis]}` as AnimationChannel,(kind==='position'?row.positions:row.rotations).map(v=>v[axis]),frames));
 }
 const doc={...target.doc,animation:{...defaultAnimation(),start:0,end:48,loop:false,tracks}};validateScene(doc);return doc;
}
export function mapOriginal(source:Rig,target:Rig,mapping:Mapping):SceneDocument {
 validateMapping(source,target,mapping);
 const sr=world(source,undefined,true),tr=world(target,undefined,true),s0=world(source,0).get(source.roles.hips)!.position,ratio=legLength(target)/legLength(source),invTarget=basis(target.coordinates).invert();
 const previous=new Map<string,Vec3>();
 return bake(target,frame=>{
  const sw=world(source,frame),out=new Map<string,{rotation:Vec3;position:Vec3}>(),desired=new Map<string,Quaternion>();
  for(const role of ROLES) {
   const sid=source.roles[role],tid=target.roles[role],joint=target.doc.joints!.find(j=>j.id===tid)!;
   const q=sw.get(sid)!.quaternion.clone().multiply(sr.get(sid)!.quaternion.clone().invert()).multiply(tr.get(tid)!.quaternion).normalize();desired.set(tid,q);
   const local=joint.parentId?desired.get(joint.parentId)!.clone().invert().multiply(q):invTarget.clone().multiply(q);
   const rotation=jointRotationFromQuaternion(joint,local,previous.get(tid));previous.set(tid,rotation);
   const position=joint.parentId?[...joint.position] as Vec3:sw.get(sid)!.position.clone().sub(s0).multiplyScalar(ratio).add(tr.get(tid)!.position).applyQuaternion(invTarget).divideScalar(target.coordinates.metersPerUnit).toArray() as Vec3;
   out.set(tid,{position,rotation});
  }
  return out;
 });
}
export function commitBake(store:SceneStore,source:Rig,target:Rig,mapping:Mapping) {
 check(store.getState().document===target.doc,'Stale target revision');
 const doc=mapOriginal(source,target,mapping);store.setState({document:doc,editLabel:'Offline motion transfer experiment'});return doc;
}
export function explicitMap(source:Rig,target:Rig):Mapping { return ROLES.map(role=>({role,sourceId:source.roles[role],targetId:target.roles[role]})); }
export function targetFixture(reference:{role:string;parent:string|null;position:number[];rotation:number[]}[],variant:string):Rig {
 const scale=variant==='MT17-SCALE08'?.8:1,roles=Object.fromEntries(ROLES.map(r=>[r,`${variant}_${r}`])) as Record<Role,string>;
 const joints:Joint[]=reference.map(r=>({id:roles[r.role as Role],name:`${variant}_${r.role}`,parentId:r.parent?roles[r.parent as Role]:null,position:r.position.map(x=>x*scale) as Vec3,rotation:[0,0,0],orientation:[0,0,0]}));
 const get=(r:Role)=>joints.find(j=>j.id===roles[r])!;
 if(variant==='MT17-PROPORTION') {
  get('hips').position[1]=.72;
  for(const side of ['left','right']) {get((side+'LowerLeg') as Role).position=[0,-.4,0];get((side+'Foot') as Role).position=[0,-.32,0];get((side+'LowerArm') as Role).position[0]=side==='left'?.36:-.36;get((side+'Hand') as Role).position[0]=side==='left'?.22:-.22;}
 }
 if(variant==='MT17-BASIS') for(const side of ['left','right']) {
  const upper=get((side+'UpperArm') as Role),lower=get((side+'LowerArm') as Role);
  upper.orientation=[0,25,0];lower.orientation=[0,-25,0];
  lower.position=new Vector3(...lower.position).applyQuaternion(jointLocalQuaternion(upper,[0,0,0]).invert()).toArray() as Vec3;
 }
 const doc={...emptyScene(),joints};
 // Owned diagnostic triangle with three one-joint bindings, not a rendered-quality character.
 const worlds=raw(doc),bound=['hips','leftHand','leftFoot'].map(r=>roles[r as Role]);
 const vertices=bound.map((id,i)=>({id:`v${i}`,position:new Vector3().setFromMatrixPosition(worlds.get(id)!).toArray() as Vec3}));
 const shape:MeshShapeNode={id:'mt_shape',type:'meshShape',name:'OwnedDiagnosticSkin',parentId:'mt_mesh',vertices,faces:[{id:'f0',vertices:['v0','v1','v2']}],color:'#b8bdc5',shading:'flat',wireframe:false,skin:{jointIds:bound,inverseBindMatrices:bound.map(id=>worlds.get(id)!.clone().invert().toArray()),weights:Object.fromEntries(bound.map((_,i)=>[`v${i}`,[{joint:i,weight:1}]]))}};
 doc.rootIds=['mt_mesh'];doc.nodes={mt_mesh:{id:'mt_mesh',name:'OwnedDiagnosticSkin',type:'transform',parentId:null,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],rotationOrder:'XYZ'},mt_shape:shape};validateScene(doc);
 return {doc,reference:structuredClone(joints),roles,coordinates:{metersPerUnit:1,up:'Y',forward:'+Z',basis:[0,0,0,1]}};
}
function transient(rig:Rig) {
 const ref=world(rig,undefined,true),mesh=new SkinnedMesh(new BufferGeometry(),new MeshBasicMaterial()),bones=new Map<string,Bone>();
 for(const j of rig.reference) {
  const b=new Bone();b.name=j.name;const w=ref.get(j.id)!;
  const parent=j.parentId?ref.get(j.parentId):undefined;
  b.position.copy(parent?w.position.clone().sub(parent.position).applyQuaternion(parent.quaternion.clone().invert()):w.position);
  b.quaternion.copy(parent?parent.quaternion.clone().invert().multiply(w.quaternion):w.quaternion);bones.set(j.id,b);
 }
 for(const j of rig.reference)(j.parentId?bones.get(j.parentId)!:mesh).add(bones.get(j.id)!);
 mesh.updateMatrixWorld(true);mesh.bind(new Skeleton(rig.reference.map(j=>bones.get(j.id)!)));
 return {mesh,bones,dispose(){mesh.skeleton.dispose();mesh.geometry.dispose();(mesh.material as MeshBasicMaterial).dispose();}};
}
/** r180 helper comparison on canonical transient adapters; no helper copied. */
export function mapSkeletonUtils(source:Rig,target:Rig,mapping:Mapping) {
 validateMapping(source,target,mapping);
 // SkeletonUtils and Three PropertyBinding address these adapters by name;
 // a valid semantic-ID bijection alone cannot prevent name aliases here.
 for(const [label,rig] of [['source',source],['target',target]] as const)for(const joints of [rig.doc.joints!,rig.reference]) {
  const names=joints.map(joint=>joint.name);
  check(names.every(name=>typeof name==='string'&&name.trim().length>0)&&new Set(names).size===names.length,`Comparator ${label} bone names must be nonempty and unique`);
 }
 const sa=transient(source),ta=transient(target),names:Record<string,string>={},offsets:Record<string,Matrix4>={},sr=world(source,undefined,true),tr=world(target,undefined,true);
 for(const role of ROLES) {
  const sb=sa.bones.get(source.roles[role])!,tb=ta.bones.get(target.roles[role])!;names[tb.name]=sb.name;
  offsets[tb.name]=new Matrix4().makeRotationFromQuaternion(sr.get(source.roles[role])!.quaternion.clone().invert().multiply(tr.get(target.roles[role])!.quaternion));
 }
 // Feed the imported Euler evaluator, sampled at24fps, so library adapter starts from the same motion.
 const tracks=[];const times=Array.from({length:49},(_,i)=>i/24);
 for(const role of ROLES) {
  const id=source.roles[role],joint=source.doc.joints!.find(j=>j.id===id)!,values:number[]=[],pos:number[]=[];
  for(let f=0;f<=48;f++) {
   const w=world(source,f),s=w.get(id)!,parent=joint.parentId?w.get(joint.parentId):undefined;
   const local=parent?parent.quaternion.clone().invert().multiply(s.quaternion):s.quaternion;
   values.push(...local.toArray());pos.push(...(parent?s.position.clone().sub(parent.position).applyQuaternion(parent.quaternion.clone().invert()):s.position).toArray());
  }
  tracks.push(new QuaternionKeyframeTrack(`${sa.bones.get(id)!.name}.quaternion`,times,values));
  if(role==='hips')tracks.push(new VectorKeyframeTrack(`${sa.bones.get(id)!.name}.position`,times,pos));
 }
 const ratio=legLength(target)/legLength(source),s0=world(source,0).get(source.roles.hips)!.position,t0=tr.get(target.roles.hips)!.position;
 const options={names,hip:sa.bones.get(source.roles.hips)!.name,fps:24,localOffsets:offsets,preserveBoneMatrix:true,preserveBonePositions:true,useTargetMatrix:false,useFirstFramePosition:false,scale:ratio,hipInfluence:new Vector3(1,1,1),hipPosition:t0.clone().divideScalar(ratio).sub(s0)};
 const started=performance.now();
 try {
  const clip=retargetClip(ta.mesh,sa.mesh,new AnimationClip('MT17',2,tracks),options);
  const mixer=new AnimationMixer(ta.mesh),action=mixer.clipAction(clip);action.setLoop(LoopOnce,1);action.clampWhenFinished=true;action.play();
  const previous=new Map<string,Vec3>(),invTarget=basis(target.coordinates).invert();
  const doc=bake(target,frame=>{
   mixer.setTime(frame/24);ta.mesh.updateMatrixWorld(true);const out=new Map<string,{rotation:Vec3;position:Vec3}>();
   for(const j of target.doc.joints!) {
    const b=ta.bones.get(j.id)!,q=j.parentId?b.quaternion:invTarget.clone().multiply(b.quaternion),rotation=jointRotationFromQuaternion(j,q,previous.get(j.id));previous.set(j.id,rotation);
    out.set(j.id,{rotation,position:j.parentId?[...j.position] as Vec3:b.position.clone().applyQuaternion(invTarget).divideScalar(target.coordinates.metersPerUnit).toArray() as Vec3});
   }
   return out;
  });mixer.stopAllAction();mixer.uncacheRoot(ta.mesh);
  return {doc,costMs:performance.now()-started,grid:{helperSamples:clip.tracks[0].times.length,importerSamples:49,first:clip.tracks[0].times[0],last:clip.tracks[0].times.at(-1),second:clip.tracks[0].times[1],helperDelta:2/47,importerDelta:1/24},options:{names,hip:options.hip,fps:24,scale:ratio,hipPosition:options.hipPosition.toArray(),useFirstFramePosition:false,localOffsets:Object.fromEntries(Object.entries(offsets).map(([k,m])=>[k,m.toArray()])),preserveBonePositions:true}};
 } finally {sa.dispose();ta.dispose();}
}
export function compareAnalytic(source:Rig,target:Rig,baked:SceneDocument,frames=FRAMES) {
 const scale=legLength(target)/legLength(source),s0=world(source,0).get(source.roles.hips)!.position,tr=world(target,undefined,true),sr=world(source,undefined,true),anchor=tr.get(target.roles.hips)!.position;
 let sum=0,max=0,angle=0,rootSum=0,lengthError=0,count=0;const perJoint:Record<string,number>={},perJointSum:Record<string,number>={};
 for(const frame of frames) {
  const s=world(source,frame),t=world({...target,doc:baked},frame);
  for(const role of ROLES) {
   const expected=s.get(source.roles[role])!.position.clone().sub(s0).multiplyScalar(scale).add(anchor),actual=t.get(target.roles[role])!,e=expected.distanceTo(actual.position)/target.coordinates.metersPerUnit;
   sum+=e*e;max=Math.max(max,e);perJoint[role]=Math.max(perJoint[role]??0,e);perJointSum[role]=(perJointSum[role]??0)+e*e;count++;
   const desired=s.get(source.roles[role])!.quaternion.clone().multiply(sr.get(source.roles[role])!.quaternion.clone().invert()).multiply(tr.get(target.roles[role])!.quaternion);
   angle=Math.max(angle,desired.angleTo(actual.quaternion)*180/Math.PI);
   const joint=target.doc.joints!.find(j=>j.id===target.roles[role])!;
   if(joint.parentId) {const rest=tr.get(joint.id)!.position.distanceTo(tr.get(joint.parentId)!.position),length=actual.position.distanceTo(t.get(joint.parentId)!.position);lengthError=Math.max(lengthError,Math.abs(length-rest)/rest);}
   else rootSum+=e*e*target.coordinates.metersPerUnit**2/legLength(target)**2;
  }
 }
 return {worldJointRms:Math.sqrt(sum/count),worldJointMax:max,maxAngularDegrees:angle,rootNormalizedRms:Math.sqrt(rootSum/frames.length),maxRelativeSegmentLengthError:lengthError,perJointMax:perJoint,handHeadDeviation:Object.fromEntries(['leftHand','rightHand','head'].map(role=>[role,{rms:Math.sqrt(perJointSum[role]/frames.length),max:perJoint[role]}])),trajectoryInterpretation:'Analytic source-scaled comparison is ground truth for IDENTITY/SCALE08/BASIS geometry; PROPORTION has no paired ground truth.'};
}
export function contactMetrics(rig:Rig,stances:Record<string,number[][]>,floorY=0) {
 const length=legLength(rig),out:Record<string,unknown>={};
 for(const [foot,intervals] of Object.entries(stances)) {
  out[foot]=intervals.map(([start,end])=>{
   const p=(f:number)=>world(rig,f).get(rig.roles[foot as Role])!.position,anchor=p(start),frames=FRAMES.filter(f=>f>=start&&f<=end).sort((a,b)=>a-b);
   let slipSum=0,slipMax=0,verticalSum=0,verticalMax=0,penetration=0;
   for(const f of frames){const v=p(f),slip=Math.hypot(v.x-anchor.x,v.z-anchor.z)/length,y=(v.y-floorY)/length;slipSum+=slip*slip;slipMax=Math.max(slipMax,slip);verticalSum+=y*y;verticalMax=Math.max(verticalMax,Math.abs(y));penetration=Math.max(penetration,-y);}
   const discontinuity=(f:number)=>f>0&&f<48?p(f+1e-6).distanceTo(p(f-1e-6))/length:0;
   return {start,end,samples:frames.length,horizontalRms:Math.sqrt(slipSum/frames.length),horizontalMax:slipMax,verticalRms:Math.sqrt(verticalSum/frames.length),verticalMax,penetrationMax:penetration,onsetDiscontinuity:discontinuity(start),offsetDiscontinuity:discontinuity(end),passesExploratoryGate:slipMax<=.02&&penetration<=.01};
  });
 }
 return out;
}
