// Original procedural fixture, Apache-2.0 (same license as Musubi Motion).
// Revision 1. No external assets or exporter. node scripts/motion-transfer-experiment/generate.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../../tests/fixtures/motion-transfer/', import.meta.url));
const roles = ['hips','spine','chest','neck','head','leftUpperArm','leftLowerArm','leftHand','rightUpperArm','rightLowerArm','rightHand','leftUpperLeg','leftLowerLeg','leftFoot','rightUpperLeg','rightLowerLeg','rightFoot'];
const parents = [null,'hips','spine','chest','neck','chest','leftUpperArm','leftLowerArm','chest','rightUpperArm','rightLowerArm','hips','leftUpperLeg','leftLowerLeg','hips','rightUpperLeg','rightLowerLeg'];
const positions = [[0,.9,0],[0,.2,0],[0,.2,0],[0,.15,0],[0,.15,0],[.15,.1,0],[.3,0,0],[.25,0,0],[-.15,.1,0],[-.3,0,0],[-.25,0,0],[.1,0,0],[0,-.45,0],[0,-.45,0],[-.1,0,0],[0,-.45,0],[0,-.45,0]];
const reference = roles.map((role,i)=>({role,parent:parents[i],position:positions[i],rotation:[0,0,0]}));
const rad = x=>x*180/Math.PI;
function swing(f,a,b,start,end) { const u=Math.max(0,Math.min(1,(f-start)/(end-start)));return [a+(b-a)*u,.08*Math.sin(Math.PI*u)]; }
function pose(frame) {
 const root=[0,.84,.5*frame/48];
 const left=frame<=12?[0,0]:frame>=36?[.5,0]:swing(frame,0,.5,12,36);
 const right=frame<=24?[.25,0]:swing(frame,.25,.75,24,48);
 const rotations=Object.fromEntries(roles.map(r=>[r,[0,0,0]]));
 for(const [side,[z,y]] of [['left',left],['right',right]]) {
  const dy=y-root[1],dz=z-root[2],distance=Math.hypot(dy,dz),bend=Math.acos(distance/.9);
  rotations[side+'UpperLeg']=[rad(Math.atan2(-dz,-dy)-bend),0,0];rotations[side+'LowerLeg']=[rad(2*bend),0,0];rotations[side+'Foot']=[-rotations[side+'UpperLeg'][0]-rotations[side+'LowerLeg'][0],0,0];
 }
 rotations.leftUpperArm=[0,0,5+55*frame/48];rotations.rightUpperArm=[0,0,-5-20*frame/48];
 rotations.leftLowerArm=[0,0,15*frame/48];
 return {frame,root,rotations};
}
const samples=Array.from({length:49},(_,i)=>pose(i));
const meta={generator:'original MT17 procedural generator revision1',license:'Apache-2.0',metersPerUnit:1,up:'Y',forward:'+Z',basis:[0,0,0,1],fps:24,start:0,end:48,reference,stances:{leftFoot:[[0,12],[36,48]],rightFoot:[[0,24]]},floorY:0,samples,notes:'Independent T reference; frame0 hips are lowered to0.84 and arms already rotated. Foot swing/stance annotated by author, not inferred. Source meters encoded FBX UnitScaleFactor100 (centimeters per source unit).'};
writeFileSync(dir+'MT17-reference.json',JSON.stringify(meta,null,2)+'\n');
let text='; FBX 7.4.0 project file\nFBXHeaderExtension:  {\n\tFBXHeaderVersion: 1003\n\tFBXVersion: 7400\n}\nGlobalSettings:  {\n\tProperties70:  {\n\t\tP: "UpAxis", "int", "Integer", "",1\n\t\tP: "UpAxisSign", "int", "Integer", "",1\n\t\tP: "FrontAxis", "int", "Integer", "",2\n\t\tP: "FrontAxisSign", "int", "Integer", "",1\n\t\tP: "CoordAxis", "int", "Integer", "",0\n\t\tP: "CoordAxisSign", "int", "Integer", "",1\n\t\tP: "UnitScaleFactor", "double", "Number", "",100\n\t}\n}\nObjects:  {\n';
const connections=[];let next=2000;
roles.forEach((r,i)=>{
 const id=100+i,p=positions[i];
 text+=`\tModel: ${id}, "Model::${r}", "LimbNode" {\n\t\tVersion: 232\n\t\tProperties70:  {\n\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",${p}\n\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0\n\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1\n\t\t\tP: "RotationOrder", "enum", "", "",5\n\t\t}\n\t}\n`;
 connections.push(`\tC: "OO",${id},${parents[i]?100+roles.indexOf(parents[i]):0}`);
 for(const kind of (i===0?['R','T']:['R'])) {
  const node=next++;
  text+=`\tAnimationCurveNode: ${node}, "AnimCurveNode::${kind}", "" {\n\t}\n`;
  connections.push(`\tC: "OO",${node},1001`,`\tC: "OP",${node},${id},"Lcl ${kind==='R'?'Rotation':'Translation'}"`);
  for(let axis=0;axis<3;axis++) {
   const curve=next++,times=samples.map(s=>Math.round(s.frame/24*46186158000)),values=samples.map(s=>kind==='T'?s.root[axis]:s.rotations[r][axis]);
   text+=`\tAnimationCurve: ${curve}, "AnimCurve::${r}${kind}${axis}", "" {\n\t\tDefault: 0\n\t\tKeyVer: 4008\n\t\tKeyTime: *49 {\n\t\t\ta: ${times}\n\t\t}\n\t\tKeyValueFloat: *49 {\n\t\t\ta: ${values}\n\t\t}\n\t}\n`;
   connections.push(`\tC: "OP",${curve},${node},"d|${'XYZ'[axis]}"`);
  }
 }
});
text+='\tAnimationLayer: 1001, "AnimLayer::BaseLayer", "" {\n\t}\n\tAnimationStack: 1000, "AnimStack::MT17", "" {\n\t}\n}\nConnections:  {\n'+connections.join('\n')+'\n\tC: "OO",1001,1000\n}\n';
writeFileSync(dir+'MT17-SOURCE-24.fbx',text);
console.log(JSON.stringify({generator:meta.generator,fbxBytes:Buffer.byteLength(text),samples:samples.length,joints:roles.length}));
