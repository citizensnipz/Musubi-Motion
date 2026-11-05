/** Original Apache-2.0 offline MT17 variants. No runtime entry point or contact correction. */
import type { CurveKey } from '../../src/animation.ts';
import { validateScene } from '../../src/project-archive.ts';
import type { Vec3 } from '../../src/scene-document.ts';
import { ROLES, type Rig, type Role } from './harness.ts';

export const STRESS_VARIANTS = ['initial-placement', 'shorter-faster-swing', 'fractional-boundaries'] as const;
export type StressVariant = typeof STRESS_VARIANTS[number];
export type StressFixture = { id: StressVariant; source: Rig; stances: Record<string, number[][]>; authoredFrames: number[]; parameters: { rootStart: Vec3; leftSwing: [number,number]; rightSwing: [number,number] } };

/** Preserves input fallback, independent reference, topology and coordinate metadata.
 * Only cloned Base animation keys change. This is deterministic authored motion,
 * not paired retargeting ground truth. Angles use the revision1 owned generator's
 * planar two-segment construction; no IK solver or editor dependency is added.
 */
export function stressFixture(input: Rig, id: StressVariant): StressFixture {
 if (!STRESS_VARIANTS.includes(id)) throw Error('Unknown bounded stress variant');
 if (input.coordinates.metersPerUnit!==1 || input.coordinates.up!=='Y' || input.coordinates.forward!=='+Z' || input.coordinates.basis.join(',')!=='0,0,0,1') throw Error('Stress authoring requires owned MT17 meter/Y-up/+Z identity basis');
 if (input.doc.animation?.fps!==24 || input.doc.animation.start!==0 || input.doc.animation.end!==48 || input.doc.animation.layers?.length || input.reference.length!==17) throw Error('Stress authoring requires owned MT17 Base-only 0..48 at24fps');
 const rootStart:Vec3 = id==='initial-placement'?[.12,.82,-.08]:[0,.84,0];
 const leftSwing:[number,number] = id==='shorter-faster-swing'?[18,30]:id==='fractional-boundaries'?[12.375,35.625]:[12,36];
 const rightSwing:[number,number] = id==='shorter-faster-swing'?[30,42]:id==='fractional-boundaries'?[24.375,47.625]:[24,48];
 const stances={leftFoot:[[0,leftSwing[0]],[leftSwing[1],48]],rightFoot:[[0,rightSwing[0]],...(rightSwing[1]<48?[[rightSwing[1],48]]:[])]};
 const authoredFrames=[...new Set([...Array.from({length:49},(_,i)=>i),...leftSwing,...rightSwing])].sort((a,b)=>a-b);
 const source=structuredClone(input);
 function swing(frame:number,start:number,end:number,from:number) {
  const u=Math.max(0,Math.min(1,(frame-start)/(end-start)));
  return [from+.5*u,.08*Math.sin(Math.PI*u)];
 }
 function pose(frame:number) {
  const root:Vec3=[rootStart[0],rootStart[1],rootStart[2]+.5*frame/48];
  const rotations=Object.fromEntries(ROLES.map(role=>[role,[0,0,0]])) as Record<Role,Vec3>;
  for(const [side,times,from] of [['left',leftSwing,0],['right',rightSwing,.25]] as const) {
   const [z,y]=swing(frame,...times,from),dy=y-root[1],dz=z+rootStart[2]-root[2],distance=Math.hypot(dy,dz);
   if(distance>.9)throw Error('Bounded procedural limb reach exceeded');
   const bend=Math.acos(distance/.9),degrees=(angle:number)=>angle*180/Math.PI;
   const upper=(side+'UpperLeg') as Role,lower=(side+'LowerLeg') as Role,foot=(side+'Foot') as Role;
   rotations[upper]=[degrees(Math.atan2(-dz,-dy)-bend),0,0];
   rotations[lower]=[degrees(2*bend),0,0];rotations[foot]=[-rotations[upper][0]-rotations[lower][0],0,0];
  }
  rotations.leftUpperArm=[0,0,5+55*frame/48];rotations.rightUpperArm=[0,0,-5-20*frame/48];rotations.leftLowerArm=[0,0,15*frame/48];
  return {root,rotations};
 }
 const samples=authoredFrames.map(pose);
 for(const track of source.doc.animation!.tracks) {
  const role=ROLES.find(role=>source.roles[role]===track.targetId);
  if(!role)throw Error('Unsupported stress source track');
  if(!track.channel.startsWith('rotation.') && !(role==='hips'&&track.channel.startsWith('position.')))continue;
  const axis='xyz'.indexOf(track.channel.at(-1)!);
  track.keys=authoredFrames.map((frame,i):CurveKey=>({id:`stress_${id}_${role}_${track.channel.replace('.','_')}_${i}`,time:frame,value:track.channel.startsWith('position.')?samples[i].root[axis]:samples[i].rotations[role][axis],interpolation:'linear',tangentMode:'auto'}));
 }
 validateScene(source.doc);
 return {id,source,stances,authoredFrames,parameters:{rootStart,leftSwing,rightSwing}};
}

export function stressGrids(fixture: StressFixture) {
 const boundaries=[...new Set(Object.values(fixture.stances).flat(2))].sort((a,b)=>a-b);
 const boundaryFrames=[...new Set(boundaries.flatMap(f=>[f-1e-6,f,f+1e-6]).filter(f=>f>=0&&f<=48))].sort((a,b)=>a-b);
 const dense=Array.from({length:385},(_,i)=>i*.125);
 return {dense,boundaries:boundaryFrames,common:[...new Set([...dense,...boundaryFrames,...fixture.authoredFrames,...Array.from({length:48},(_,i)=>48*i/47),.25,7.125,23.5,47.75])].sort((a,b)=>a-b)};
}
