import * as THREE from "three";
import { SplatSkinning, SplatSkinningMode, type SplatMesh } from "@sparkjsdev/spark";
import type { SplatShapeNode } from "./scene-document";
import { createElasticRuntime } from "./elastic-runtime";
import type { Joint } from "./skeleton";
import { posedSelection } from "./splat-selection";
export function createBinding(mesh: SplatMesh, binding: NonNullable<SplatShapeNode["binding"]>, elasticity?: SplatShapeNode["elasticity"], joints: Joint[] = []) {
 const skin = new SplatSkinning({mesh, numSplats: mesh.numSplats + (elasticity?.budget ?? 0), numBones:binding.jointIds.length, mode:SplatSkinningMode.LINEAR_BLEND});
 const rests = binding.restMatrices.map(m => new THREE.Matrix4().fromArray(m));
 const inverseRests = rests.map(m => m.clone().invert());
 const centers = rests.map(m => new THREE.Vector3().setFromMatrixPosition(m));
 rests.forEach((_,i)=>skin.setRestMatrix(i,new THREE.Matrix4()));
 mesh.forEachSplat((index, center)=>{
  const nearest = centers.map((p,i)=>({i,w:1/Math.max(1e-8,p.distanceToSquared(center))})).sort((a,b)=>b.w-a.w).slice(0,4);
  const total = nearest.reduce((sum,n)=>sum+n.w,0);
  const indices = [0,0,0,0], weights = [0,0,0,0];
  nearest.forEach((n,i)=>{indices[i]=n.i;weights[i]=n.w/total;});
  skin.setSplatBones(index,new THREE.Vector4(...indices),new THREE.Vector4(...weights));
 });
 skin.skinTexture.needsUpdate=true; mesh.skinning=skin; mesh.updateGenerator();
 const elastic = elasticity ? createElasticRuntime(mesh,skin,rests,binding.jointIds,joints,elasticity) : undefined;
 let transforms=rests.map(()=>new THREE.Matrix4());
 let selection:ReturnType<typeof posedSelection>|undefined, signature="";
 return { update(boneMatrix:(id:string)=>THREE.Matrix4|undefined) {
  mesh.updateWorldMatrix(true,false);
  const inverse = mesh.matrixWorld.clone().invert();
  const currentMatrices = binding.jointIds.map((id,i)=>{ const matrix=boneMatrix(id); return matrix ? inverse.clone().multiply(matrix) : rests[i].clone(); });
  elastic?.update(currentMatrices);
  transforms=currentMatrices.map((m,i)=>m.clone().multiply(inverseRests[i]));
  const next=transforms.map(m=>m.elements.join(",")).join(";")+":"+mesh.extSplats?.numSplats;
  if(next!==signature){selection=undefined;signature=next;}
  transforms.forEach((matrix,i)=>skin.setBoneMatrix(i,matrix));
  skin.updateBones();
 }, conservativeBounds(bounds:THREE.Box3) {
  // A weighted point lies within the union of its positive-weight transformed
  // bounds. This avoids reading every splat just to draw a playback selection box.
  const result=new THREE.Box3();
  for(const matrix of transforms)result.union(bounds.clone().applyMatrix4(matrix));
  return result;
 }, selection() { return selection??=posedSelection(mesh,skin,transforms); }, dispose() { elastic?.dispose(); mesh.skinning=null; mesh.updateGenerator(); skin.skinTexture.dispose();skin.boneTexture.dispose(); } };
}
