import { describe, expect, it, vi } from "vitest";
import { Group, Mesh, MeshStandardMaterial, BufferGeometry, Float32BufferAttribute, Texture } from "three";
import { convertFBX } from "../src/fbx-import.ts";
import { addTexture, collectEmbeddedTextures, commitTextureCommand, inspectTextureHeader, prepareTexture, relinkTexture, removeTexture, replaceTexture, setTextureRole, textureBytes, textureContentId, textureReferences, trimTextureHistory, validateTextureAssets, TEXTURE_LIMITS, type TextureAsset, type TextureDecoder } from "../src/texture-assets.ts";
import { emptyScene, deleteSceneItems, type MeshShapeNode } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { createMeshRenderable } from "../src/mesh-renderer.ts";
import { createMaterials, disposeMaterials } from "../src/mesh-materials.ts";
const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const decoder:TextureDecoder=async()=>({alpha:false,thumbnail:png});
const file=(name="original.png",bytes=textureBytes(png))=>new File([bytes],name);
const editor={camera:{position:[3,2,8] as [number,number,number],target:[0,0,0] as [number,number,number],fov:42,near:.01,far:1000},time:0};
async function asset(){return prepareTexture(file(),"color",decoder);}
async function otherAsset(){
 const original=textureBytes(png),chunk=new Uint8Array(17),v=new DataView(chunk.buffer);v.setUint32(0,5);chunk.set([116,69,88,116,97,0,98,99,100],4);
 let crc=0xffffffff;for(const byte of chunk.subarray(4,13)){crc^=byte;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}v.setUint32(13,(crc^0xffffffff)>>>0);
 const b=new Uint8Array(original.length+chunk.length);b.set(original.subarray(0,-12));b.set(chunk,original.length-12);b.set(original.subarray(-12),original.length-12+chunk.length);
 return prepareTexture(file("other.png",b),"color",decoder);
}
function fbxFixture(){
 const group=new Group(),geometry=new BufferGeometry();geometry.setAttribute("position",new Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));geometry.setAttribute("uv",new Float32BufferAttribute([0,0,1,0,0,1],2));
 const material=new MeshStandardMaterial();material.name="Original";material.map=new Texture();material.map.userData.musubiDataURI=png;material.map.repeat.set(2,3);material.normalMap=material.map;
 group.add(new Mesh(geometry,material));return convertFBX(group,emptyScene(),"Textured FBX").document;
}
describe("Reusable texture library",()=>{
 it("imports without a mesh, content-deduplicates names, retains original bytes and metadata",async()=>{
  const first=await asset(),again=await prepareTexture(file("renamed.png"),"data",decoder);
  expect(first.id).toBe(again.id);expect(first).toMatchObject({width:1,height:1,alpha:false,role:"color",mime:"image/png"});expect(first.dataURI).toBe(png);
  const doc=addTexture(emptyScene(),first);expect(addTexture(doc,again)).toBe(doc);expect(Object.values(doc.textureAssets!)).toHaveLength(1);expect(()=>validateScene(doc)).not.toThrow();
 });
 it("rejects unsupported files, byte/pixel limits, truncation and decode errors before mutation",async()=>{
  const decode=vi.fn(decoder);await expect(prepareTexture(file("image.svg"),"color",decode)).rejects.toThrow(/PNG/);
  await expect(prepareTexture(new File([new Uint8Array(TEXTURE_LIMITS.bytes+1)],"big.png"),"color",decode)).rejects.toThrow(/16 MiB/);
  const large=textureBytes(png);new DataView(large.buffer).setUint32(16,16384);await expect(prepareTexture(file("large.png",large),"color",decode)).rejects.toThrow(/8192/);
  await expect(prepareTexture(file("partial.png",textureBytes(png).slice(0,-12)),"color",decode)).rejects.toThrow(/Truncated/);expect(decode).not.toHaveBeenCalled();
  await expect(prepareTexture(file(),"color",async()=>{throw Error("Decode failed");})).rejects.toThrow("Decode failed");
 });
 it("reports non-upright EXIF orientation and rejects truncated WebP/JPEG",()=>{
  const jpeg=new Uint8Array([255,216,255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0,255,217]);
  expect(()=>inspectTextureHeader(jpeg,"image/jpeg")).toThrow(/EXIF/);expect(()=>inspectTextureHeader(new Uint8Array([255,216]),"image/jpeg")).toThrow(/truncated/);expect(()=>inspectTextureHeader(new Uint8Array(30),"image/webp")).toThrow(/WebP/);
 });
 it("validates content hash, dimensions, role, bounded swatches and dangling references",async()=>{
  const a=await asset(),doc=addTexture(emptyScene(),a);
  for(const patch of [{width:2},{role:"sRGB"},{id:"tex_bad"},{byteLength:1},{dataURI:png.slice(0,-4)},{thumbnail:png.replace("png","svg+xml")}])expect(()=>validateTextureAssets({[a.id]:{...a,...patch}})).toThrow();
  const referenced=await collectEmbeddedTextures(fbxFixture(),decoder);const id=Object.keys(referenced.textureAssets!)[0];delete referenced.textureAssets![id];expect(()=>validateScene(referenced)).toThrow(/Missing material texture/);
  expect(()=>validateScene(doc)).not.toThrow();
 });
 it("adopts real FBX maps once and preserves UV/normal-map semantics and rendered color spaces",async()=>{
  const old=fbxFixture(),oldJSON=JSON.stringify(old),doc=await collectEmbeddedTextures(old,decoder),id=Object.keys(doc.textureAssets!)[0],shape=Object.values(doc.nodes).find(n=>n.type==="meshShape") as MeshShapeNode;
  expect(Object.keys(doc.textureAssets!)).toHaveLength(1);expect(textureReferences(doc,id)).toHaveLength(2);expect(shape.materials![0].map).toMatchObject({assetId:id,repeat:[2,3]});expect(shape.materials![0].map!.dataURI).toBeUndefined();expect(JSON.stringify(old)).toBe(oldJSON);
  const materials=createMaterials(shape.materials!,true,false,doc.textureAssets);expect(materials[0].map!.userData.musubiDataURI).toBe(png);expect(materials[0].map!.colorSpace).toBe("srgb");expect(materials[0].normalMap!.colorSpace).toBe("");
  const mapDispose=vi.fn(),normalDispose=vi.fn();materials[0].map!.addEventListener("dispose",mapDispose);materials[0].normalMap!.addEventListener("dispose",normalDispose);disposeMaterials(materials);expect(mapDispose).toHaveBeenCalledTimes(1);expect(normalDispose).toHaveBeenCalledTimes(1);
  const render=createMeshRenderable(shape,doc.textureAssets);expect(render.mesh.material.map!.userData.musubiDataURI).toBe(png);render.dispose();
 });
 it("keeps unsupported existing FBX images embedded when adoption cannot decode",async()=>{
  const before=fbxFixture(),warn=vi.fn(),doc=await collectEmbeddedTextures(before,async()=>{throw Error("Decode unavailable");},warn);
  const shape=Object.values(doc.nodes).find(n=>n.type==="meshShape") as MeshShapeNode;expect(shape.materials![0].map!.dataURI).toBe(png);expect(warn).toHaveBeenCalled();expect(()=>validateScene(doc)).not.toThrow();
 });
 it("replaces atomically, relinks all material slots, deduplicates target and protects referenced deletion",async()=>{
  const doc=await collectEmbeddedTextures(fbxFixture(),decoder),id=Object.keys(doc.textureAssets!)[0],replacement=await otherAsset(),withOther=addTexture(doc,replacement);
  expect(()=>removeTexture(doc,id)).toThrow(/referenced/);expect(()=>relinkTexture(doc,id,"missing")).toThrow(/existing/);
  const swapped=replaceTexture(withOther,id,replacement);expect(Object.keys(swapped.textureAssets!)).toEqual([replacement.id]);expect(textureReferences(swapped,replacement.id)).toHaveLength(2);expect(textureReferences(doc,id)).toHaveLength(2);
  const linked=relinkTexture(withOther,id,replacement.id);expect(removeTexture(linked,id).textureAssets![id]).toBeUndefined();
  const broken={...replacement,width:99};expect(()=>replaceTexture(doc,id,broken)).toThrow();expect(Object.keys(doc.textureAssets!)).toEqual([id]);
 });
 it("commits each command once, no-ops dedup, and exactly restores import/role/replace/relink/delete with undo/redo",async()=>{
  const initial=await collectEmbeddedTextures(fbxFixture(),decoder),store=createSceneStore(initial),id=Object.keys(initial.textureAssets!)[0],b=await otherAsset();
  commitTextureCommand(store,"Import",doc=>addTexture(doc,b));expect(store.temporal.getState().pastStates).toHaveLength(1);
  commitTextureCommand(store,"Duplicate",doc=>addTexture(doc,b));expect(store.temporal.getState().pastStates).toHaveLength(1);
  commitTextureCommand(store,"Role",doc=>setTextureRole(doc,b.id,"data"));expect(store.getState().document.textureAssets![b.id].role).toBe("data");
  const before=store.getState().document;commitTextureCommand(store,"Replace",doc=>replaceTexture(doc,id,b));const after=store.getState().document;
  store.temporal.getState().undo();expect(store.getState().document).toBe(before);store.temporal.getState().redo();expect(store.getState().document).toBe(after);
  store.temporal.getState().undo(3);expect(store.getState().document).toBe(initial);store.temporal.getState().redo(3);expect(store.getState().document).toBe(after);
  expect(()=>commitTextureCommand(store,"Invalid",doc=>removeTexture(doc,b.id))).toThrow();expect(store.getState().document).toBe(after);
 });
 it("preserves reusable images when deleting a scene object, and persists one portable original per content ID",async()=>{
  const doc=await collectEmbeddedTextures(fbxFixture(),decoder),original=Object.values(doc.textureAssets!)[0];
  expect(deleteSceneItems(doc,doc.rootIds).textureAssets).toBe(doc.textureAssets);
  const bytes=await encodeProject(doc,new Map(),editor),decoded=await decodeProject(bytes);expect(decoded.scene).toEqual(doc);expect(decoded.scene.textureAssets![original.id].dataURI).toBe(png);
  const text=JSON.stringify(decoded.scene);expect(text.split(png).length-1).toBe(2); // original + swatch happen to match in the 1px test decoder
  const shape=Object.values(decoded.scene.nodes).find(n=>n.type==="meshShape") as MeshShapeNode;expect(shape.materials![0].map!.assetId).toBe(original.id);expect(textureReferences(decoded.scene,original.id)).toHaveLength(2);
 });
 it("bounds unique texture history while retaining the newest complete undo step",async()=>{
  const a=await asset(),b=await otherAsset(),store=createSceneStore(addTexture(emptyScene(),a));
  commitTextureCommand(store,"Replace",doc=>replaceTexture(doc,a.id,b));trimTextureHistory(store,a.byteLength+b.byteLength);expect(store.temporal.getState().pastStates).toHaveLength(1);
  trimTextureHistory(store,b.byteLength);expect(store.temporal.getState().pastStates).toHaveLength(0);
 });
});
