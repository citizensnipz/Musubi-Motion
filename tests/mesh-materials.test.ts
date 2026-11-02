import { describe, expect, it, vi } from "vitest";
import { DoubleSide, MeshPhongMaterial, MeshStandardMaterial, NoColorSpace, RepeatWrapping, SRGBColorSpace, Texture, Vector2 } from "three";
import { captureMaterials, createMaterials, disposeMaterials, validateMeshMaterials, type MeshMaterialData } from "../src/mesh-materials.ts";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
function fixture() {
  const source = new MeshStandardMaterial({ color: "#7f9abc", emissive: "#aabbcc", emissiveIntensity: 2, roughness: .35,
    metalness: .6, opacity: .4, transparent: true, alphaTest: .25, side: DoubleSide, depthWrite: false });
  source.name = "Skin"; source.normalScale.set(.5, .75);
  const image = new Texture(); image.userData.musubiDataURI = png; image.wrapS = RepeatWrapping;
  image.repeat.set(2, 3); image.offset.set(.1, .2); image.center.set(.4, .5); image.rotation = .7; image.flipY = false;
  source.map = image; source.normalMap = image; source.emissiveMap = image; source.roughnessMap = image; source.metalnessMap = image; source.alphaMap = image; source.bumpMap = image; source.bumpScale = .3;
  return { source, image };
}

describe("native mesh materials", () => {
  it("round trips material slots, alpha properties and texture transforms through JSON", () => {
    const { source } = fixture(), captured = captureMaterials([source]);
    const data = JSON.parse(JSON.stringify(captured)), restored = createMaterials(data, true, true);
    expect(captureMaterials(restored)).toEqual(captured);
    expect(restored[0].flatShading).toBe(true); expect(restored[0].polygonOffset).toBe(true);
    expect(restored[0].normalScale).toEqual(new Vector2(.5, .75));
    expect(restored[0].map!.colorSpace).toBe(SRGBColorSpace); expect(restored[0].emissiveMap!.colorSpace).toBe(SRGBColorSpace);
    expect(restored[0].normalMap!.colorSpace).toBe(NoColorSpace); expect(restored[0].roughnessMap!.colorSpace).toBe(NoColorSpace);
    expect(restored[0].bumpMap!.colorSpace).toBe(NoColorSpace); expect(restored[0].bumpScale).toBe(.3);
    disposeMaterials(restored); disposeMaterials(source);
  });
  it("approximates FBX Phong shininess with roughness and preserves material names", () => {
    const matte = new MeshPhongMaterial({ shininess: 2 }), glossy = new MeshPhongMaterial({ shininess: 126 });
    matte.name = "Matte"; glossy.name = "Gloss";
    const result = captureMaterials([matte, glossy]);
    expect(result.map(m => m.name)).toEqual(["Matte", "Gloss"]); expect(result[0].roughness).toBeGreaterThan(result[1].roughness);
    expect(result[1].metalness).toBe(0);
  });
  it("does not serialize unresolved texture references", () => {
    const material = new MeshStandardMaterial(); material.map = new Texture(); material.map.name = "https://example.com/private.png";
    expect(captureMaterials([material])[0].map).toBeUndefined();
  });
  it("rejects external URLs, SVG images, invalid samplers and malformed material values", () => {
    const material = captureMaterials([fixture().source])[0];
    for (const uri of ["https://example.com/x.png", "file:///x.png", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,%%%"])
      expect(() => validateMeshMaterials([{ ...material, map: { ...material.map!, dataURI: uri } }])).toThrow(/texture/);
    expect(() => createMaterials([{ ...material, opacity: 2 }], false, false)).toThrow(/material/);
    expect(() => validateMeshMaterials([{ ...material, bumpScale: Infinity }])).toThrow(/material/);
    expect(() => validateMeshMaterials([{ ...material, map: { ...material.map!, repeat: [Infinity, 1] } }])).toThrow(/texture/);
    expect(() => validateMeshMaterials([{ ...material, map: { ...material.map!, channel: 4 } }])).toThrow(/texture/);
    expect(() => validateMeshMaterials([])).toThrow();
    expect(() => validateMeshMaterials(Array(257).fill(material))).toThrow();
  });
  it("disposes shared texture and material instances once", () => {
    const { source, image } = fixture(), disposeTexture = vi.spyOn(image, "dispose"), disposeMaterial = vi.spyOn(source, "dispose");
    disposeMaterials([source, source]);
    expect(disposeTexture).toHaveBeenCalledTimes(1); expect(disposeMaterial).toHaveBeenCalledTimes(1);
  });
  it("keeps multi-material ordering and validates optional maps after archival serialization", () => {
    const { source } = fixture(); const second = new MeshStandardMaterial({ color: "#ff0000" }); second.name = "Clothes";
    const data = JSON.parse(JSON.stringify(captureMaterials([source, second]))) as MeshMaterialData[];
    const materials = createMaterials(data, false, false);
    expect(materials.map(m => m.name)).toEqual(["Skin", "Clothes"]);
    expect(materials[1].color.getHexString()).toBe("ff0000"); expect(materials[1].map).toBeNull();
    disposeMaterials(materials);
  });
});
