import { describe, expect, it, vi } from "vitest";
import { Color, Euler, Matrix4, Object3D, Quaternion, Vector3 } from "three";
import { ExtSplats, type SplatMesh } from "@sparkjsdev/spark";
import { meshToSplatData, interpolateSplatWeights } from "../src/mesh-to-splats";
import { defaultCubeSplatSettings } from "../src/cube-to-splats";
import { createBinding } from "../src/splat-binding";
import { deformMeshPositions } from "../src/mesh-skin";
import { validateSkinWeights } from "../src/skin-weights";
import type { MeshShapeNode } from "../src/scene-document";

function fixture(mixed = false): MeshShapeNode {
  const inverse = new Matrix4().compose(new Vector3(-3, 1, 2), new Quaternion().setFromEuler(new Euler(.2, -.1, .3)), new Vector3(.5, .5, .5));
  return { id: "shape", parentId: "object", name: "LegsShape", type: "meshShape", color: "#99aabb", shading: "smooth", wireframe: false,
    vertices: [{id:"a",position:[5,-2,1]},{id:"b",position:[7,-2,1]},{id:"c",position:[5,1,1]}], faces:[{id:"face",vertices:["a","b","c"]}],
    skin: { jointIds:["hip","knee"], inverseBindMatrices:[inverse.toArray(),new Matrix4().makeTranslation(0,-2,0).toArray()], weights: mixed ? {
      a:[{joint:0,weight:1}], b:[{joint:1,weight:1}], c:[{joint:0,weight:.25},{joint:1,weight:.75}],
    } : {a:[{joint:0,weight:1}],b:[{joint:0,weight:1}],c:[{joint:0,weight:1}]} } };
}
function sourceFromBytes(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), source = new ExtSplats({maxSplats:bytes.length/32});
  for(let i=0;i<bytes.length/32;i++) source.pushSplat(new Vector3(...[0,1,2].map(axis=>view.getFloat32(i*32+axis*4,true))),new Vector3(.03,.03,.001),new Quaternion(),1,new Color(1,1,1));
  return source;
}

describe("mesh surface conversion and imported skin alignment", () => {
  it("matches source skinning with nonidentity inverse binds, posed joints, and transformed parent/root", () => {
    const shape=fixture(), {bytes,binding}=meshToSplatData(shape,defaultCubeSplatSettings,256), source=sourceFromBytes(bytes);
    const parent=new Object3D(); parent.position.set(4,-2,1); parent.rotation.set(.1,.2,.3);
    const mesh=new Object3D() as unknown as SplatMesh; mesh.position.set(-2,1,3);mesh.scale.set(2,.8,1.3);mesh.rotation.set(.2,-.1,.4);parent.add(mesh);
    Object.assign(mesh,{extSplats:source,numSplats:256,minRaycastOpacity:.01,updateGenerator:vi.fn()});
    const skin=createBinding(mesh,binding!);
    for(const angle of [0,.7,-.5]) {
      const joint=new Matrix4().compose(new Vector3(2,3,-1),new Quaternion().setFromEuler(new Euler(angle,.2,-.1)),new Vector3(1,1,1));
      const world=(id:string)=>id==="hip"?joint:new Matrix4().makeTranslation(0,2,0);
      const vertices=deformMeshPositions(shape,world), centers=skin.getComponentPositions([]);
      expect(centers).toHaveLength(0);
      skin.update(world);mesh.updateWorldMatrix(true,false);
      const posed=skin.getComponentPositions([0,63,255]);
      for(const [out,index] of [0,63,255].entries()) {
        const rest=source.getSplat(index).center, b=(rest.x-5)/2,c=(rest.y+2)/3;
        const expected=new Vector3().fromArray(vertices,0).multiplyScalar(1-b-c).addScaledVector(new Vector3().fromArray(vertices,3),b).addScaledVector(new Vector3().fromArray(vertices,6),c).applyMatrix4(mesh.matrixWorld);
        const actual=new Vector3().fromArray(posed,out*3).applyMatrix4(mesh.matrixWorld);
        expect(actual.distanceTo(expected)).toBeLessThan(2e-6);
      }
    }
    skin.dispose();source.dispose();
  });
  it("interpolates weights at sampled rest positions and preserves full normalized rows", () => {
    const shape=fixture(true), {bytes,binding}=meshToSplatData(shape,defaultCubeSplatSettings,256), source=sourceFromBytes(bytes);
    expect(binding!.meshSpace).toBe(true); validateSkinWeights(binding);
    for(let index=0;index<256;index++) {
      const p=source.getSplat(index).center,b=(p.x-5)/2,c=(p.y+2)/3, row=binding!.weights!.overrides[String(index)];
      expect(row.reduce((sum,i)=>sum+i.weight,0)).toBeCloseTo(1,12);
      expect(row.find(i=>i.jointId==="knee")!.weight).toBeCloseTo(b+.75*c,5);
    }
    source.dispose();
  });
  it("keeps the strongest four combined influences and renormalizes", () => {
    const shape=fixture(); shape.skin!.jointIds=["j0","j1","j2","j3","j4","j5"];
    shape.skin!.weights={a:[{joint:0,weight:.6},{joint:1,weight:.4}],b:[{joint:2,weight:.7},{joint:3,weight:.3}],c:[{joint:4,weight:.8},{joint:5,weight:.2}]};
    const row=interpolateSplatWeights(shape,{vertices:["a","b","c"],bary:[.2,.3,.5],materialIndex:0});
    expect(row.map(i=>i.jointId)).toEqual(["j4","j2","j0","j5"]);
    expect(row.reduce((sum,i)=>sum+i.weight,0)).toBeCloseTo(1,12);
  });
  it("rejects blend shapes and invalid settings before producing a bound asset", () => {
    const shape=fixture();
    expect(()=>meshToSplatData(shape,defaultCubeSplatSettings,100001)).toThrow(/100,000/);
    expect(()=>meshToSplatData(shape,{...defaultCubeSplatSettings,opacity:NaN},256)).toThrow(/settings/);
    shape.morphTargets=[{name:"smile",weight:0,deltas:{a:[0,0,0],b:[0,0,0],c:[0,0,0]}}];
    expect(()=>meshToSplatData(shape,defaultCubeSplatSettings,256)).toThrow(/Blend shapes/);
  });
});

import { addSplat, emptyScene, type SceneDocument, type SplatShapeNode } from "../src/scene-document";
import { encodeProjectBlob, decodeProjectBlob } from "../src/project-archive";

it("reopens generated mesh-space binding, weights, source part, and shared skeleton from an MSB", async () => {
  const shape=fixture(true), {bytes,binding}=meshToSplatData(shape,defaultCubeSplatSettings,256);
  const scene:SceneDocument={...emptyScene(),rootIds:["object"],nodes:{object:{id:"object",name:"Legs",type:"transform",parentId:null,rotationOrder:"XYZ",position:[2,1,-3],rotation:[10,20,30],scale:[1,1,1]},shape},joints:[
    {id:"hip",name:"Hip",parentId:null,position:[0,0,0]},
    {id:"knee",name:"Knee",parentId:"hip",position:[0,2,0]},
  ]};
  const asset={id:"legs_asset",kind:"file" as const,fileName:"legs.splat",byteLength:bytes.length};
  const added=addSplat(scene,asset,"Legs_splats",[0,0,0],"converted","converted_shape");
  (added.document.nodes.converted_shape as SplatShapeNode).binding=binding;
  const archive=await encodeProjectBlob(added.document,new Map([[asset.id,new Blob([bytes])]]),{camera:{position:[0,0,5],target:[0,0,0],fov:45,near:.01,far:1000},time:0});
  const reopened=await decodeProjectBlob(archive), restored=(reopened.scene.nodes.converted_shape as SplatShapeNode).binding!;
  expect(restored).toEqual(binding);expect(restored.meshSpace).toBe(true);
  expect(reopened.scene.nodes.shape).toEqual(shape);expect(reopened.scene.joints).toEqual(scene.joints);
  expect(reopened.scene.joints).toHaveLength(2);
  expect(new Uint8Array(await reopened.files.get(asset.id)!.arrayBuffer())).toEqual(bytes);
  // Reattach the restored binding to loaded source centers and verify its posed output.
  const source=sourceFromBytes(bytes), mesh=new Object3D() as unknown as SplatMesh;
  Object.assign(mesh,{extSplats:source,numSplats:256,minRaycastOpacity:.01,updateGenerator:vi.fn()});
  const runtime=createBinding(mesh,restored), bones=[new Matrix4().makeRotationZ(.4).setPosition(1,0,0),new Matrix4().makeRotationX(-.7).setPosition(0,3,0)];
  runtime.update(id=>bones[id==="hip"?0:1]);
  for(const index of [0,127,255]) {
    expect(runtime.getWeights(index)).toEqual(binding!.weights!.overrides[String(index)]);
    expect([...runtime.getComponentPositions([index])].every(Number.isFinite)).toBe(true);
  }
  runtime.dispose();source.dispose();
});
