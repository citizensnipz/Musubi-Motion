import { expect, it, vi, afterEach } from "vitest";
import { Vector2 } from "three";
import { createMeshSplatColors, sampleSplatTexture } from "../src/mesh-splat-colors";
import type { MeshShapeNode } from "../src/scene-document";
import type { MeshMaterialData, MeshTextureData } from "../src/mesh-materials";
const raster = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) };
const texture: MeshTextureData = { dataURI: "data:image/png;base64,AA==", wrapS: 1001, wrapT: 1001, repeat: [1, 1], offset: [0, 0], center: [0, 0], rotation: 0, flipY: false, channel: 0 };
const shape = { color: "#808080" } as MeshShapeNode;
it("samples image rows using Three flipY and wraps transformed coordinates", () => {
  expect(sampleSplatTexture(raster, texture, new Vector2(.25, .25)).toArray()).toEqual([1, 0, 0]);
  expect(sampleSplatTexture(raster, { ...texture, flipY: true }, new Vector2(.25, .25)).toArray()).toEqual([0, 0, 1]);
  expect(sampleSplatTexture(raster, { ...texture, wrapS: 1000, offset: [1, 0] }, new Vector2(.25, .25)).toArray()).toEqual([1, 0, 0]);
});
it("interpolates color in linear space", () => {
  const color = sampleSplatTexture(raster, texture, new Vector2(.5, .25));
  expect(color.r).toBeCloseTo(.5); expect(color.g).toBeCloseTo(.5); expect(color.b).toBe(0);
});
it("uses linear material colors and shape fallback", async () => {
  const sampler = await createMeshSplatColors(shape);
  expect(sampler.sample(["a", "b", "c"], [1, 0, 0], 0).r).toBeCloseTo(.21586, 4);
});
const material: MeshMaterialData = { name: "Legs", color: "#ffffff", emissive: "#000000", emissiveIntensity: 1, roughness: .8, metalness: 0, opacity: 1, transparent: true, alphaTest: 0, side: 2, depthWrite: true, normalScale: [1, 1] };
it("converts opaque FBX materials even when their blending flag is enabled", async () => {
  const source = { ...shape, materials: [material] };
  const sampler = await createMeshSplatColors(source);
  expect(sampler.sample(["a", "b", "c"], [1, 0, 0], 0).toArray()).toEqual([1, 1, 1]);
  expect(source.materials[0]).toBe(material);
});
it("identifies actual scalar transparency and ignores unused material slots", async () => {
  const transparent = { ...material, opacity: .5 };
  await expect(createMeshSplatColors({ ...shape, materials: [transparent] })).rejects.toThrow(/Legs.*opacity 0.5/);
  const sampler = await createMeshSplatColors({ ...shape, faces: [{id:"f", vertices:["a","b","c"]}], materials: [material, transparent] });
  expect(sampler.sample(["a", "b", "c"], [1, 0, 0], 0).r).toBe(1);
});
afterEach(() => vi.unstubAllGlobals());
function browserRaster(data: number[]) {
  vi.stubGlobal("Image", class { naturalWidth=1; naturalHeight=1; onload?: () => void; set src(_value:string) { this.onload?.(); } });
  vi.stubGlobal("document", { createElement: () => ({width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(data)})})}) });
}
const texturedShape = { ...shape, vertices: ["a","b","c"].map(id=>({id,position:[0,0,0] as [number,number,number]})), uvs:{a:[0,0],b:[0,0],c:[0,0]} } as MeshShapeNode;
it("accepts opaque diffuse and white opacity textures on blending-enabled FBX materials", async () => {
  browserRaster([255,255,255,255]);
  const sampler = await createMeshSplatColors({ ...texturedShape, materials:[{...material,map:texture,alphaMap:texture,alphaTest:.5}] });
  expect(sampler.sample(["a","b","c"],[1,0,0],0).toArray()).toEqual([1,1,1]);
});
it("checks diffuse alpha only when blending or alpha testing makes it visible", async () => {
  browserRaster([255,255,255,0]);
  await expect(createMeshSplatColors({...texturedShape,materials:[{...material,map:texture}]})).rejects.toThrow(/base-color texture/);
  const sampler = await createMeshSplatColors({...texturedShape,materials:[{...material,transparent:false,map:texture}]});
  expect(sampler.sample(["a","b","c"],[1,0,0],0).r).toBe(1);
  await expect(createMeshSplatColors({...texturedShape,materials:[{...material,transparent:false,alphaTest:.5,map:texture}]})).rejects.toThrow(/cutout/);
});
it("checks opacity maps using green pixels rather than their alpha channel", async () => {
  browserRaster([255,0,255,255]);
  await expect(createMeshSplatColors({...shape,materials:[{...material,alphaMap:texture}]})).rejects.toThrow(/opacity map/);
});
it("filters across repeat seams while clamp and mirror retain edge texels", () => {
  const repeat = sampleSplatTexture(raster, { ...texture, wrapS: 1000 }, new Vector2(0, .25));
  expect(repeat.r).toBeCloseTo(.5); expect(repeat.g).toBeCloseTo(.5);
  expect(sampleSplatTexture(raster, texture, new Vector2(0, .25)).toArray()).toEqual([1, 0, 0]);
  expect(sampleSplatTexture(raster, { ...texture, wrapS: 1002 }, new Vector2(0, .25)).toArray()).toEqual([1, 0, 0]);
});

it("does not decode ignored opacity maps on fully opaque materials", async () => {
  const sampler = await createMeshSplatColors({...shape,materials:[{...material,transparent:false,alphaMap:texture}]});
  expect(sampler.sample(["a","b","c"],[1,0,0],0).toArray()).toEqual([1,1,1]);
});
