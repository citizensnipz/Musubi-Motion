import { Color, Material, MeshStandardMaterial, NoColorSpace, SRGBColorSpace, Texture, TextureLoader, Vector2, type Side, type Wrapping } from "three";

export type MeshTextureData = {
  dataURI: string;
  wrapS: number; wrapT: number;
  repeat: [number, number]; offset: [number, number]; center: [number, number];
  rotation: number; flipY: boolean; channel: number;
};
export type MeshMaterialData = {
  name: string; color: string; emissive: string; emissiveIntensity: number;
  roughness: number; metalness: number; opacity: number; transparent: boolean;
  alphaTest: number; side: number; depthWrite: boolean; normalScale: [number, number]; bumpScale?: number;
  map?: MeshTextureData; emissiveMap?: MeshTextureData; normalMap?: MeshTextureData;
  roughnessMap?: MeshTextureData; metalnessMap?: MeshTextureData; alphaMap?: MeshTextureData; bumpMap?: MeshTextureData;
};
export const MESH_TEXTURE_SLOTS = ["map", "emissiveMap", "normalMap", "roughnessMap", "metalnessMap", "alphaMap", "bumpMap"] as const;
type Slot = typeof MESH_TEXTURE_SLOTS[number];
const dataURI = /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/;
const finite = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
const pair = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && value.every(n => finite(n, -1e6, 1e6));
const hex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

export function validateMeshMaterials(value: unknown): asserts value is MeshMaterialData[] {
  if (!Array.isArray(value) || !value.length || value.length > 256) throw Error("Meshes require between 1 and 256 materials.");
  for (const material of value) {
    if (!material || typeof material !== "object" || typeof material.name !== "string" || material.name.length > 200
      || !hex(material.color) || !hex(material.emissive) || !finite(material.emissiveIntensity, 0, 1e6)
      || !finite(material.roughness, 0, 1) || !finite(material.metalness, 0, 1) || !finite(material.opacity, 0, 1)
      || typeof material.transparent !== "boolean" || !finite(material.alphaTest, 0, 1)
      || ![0, 1, 2].includes(material.side) || typeof material.depthWrite !== "boolean" || !pair(material.normalScale)
      || (material.bumpScale !== undefined && !finite(material.bumpScale, -1e6, 1e6)))
      throw Error("Invalid mesh material.");
    for (const slot of MESH_TEXTURE_SLOTS) {
      const texture = material[slot]; if (texture === undefined) continue;
      if (!texture || typeof texture !== "object" || typeof texture.dataURI !== "string" || texture.dataURI.length > 32 * 1024 * 1024
        || !dataURI.test(texture.dataURI) || ![1000, 1001, 1002].includes(texture.wrapS) || ![1000, 1001, 1002].includes(texture.wrapT)
        || !pair(texture.repeat) || !pair(texture.offset) || !pair(texture.center) || !finite(texture.rotation, -1e6, 1e6)
        || typeof texture.flipY !== "boolean" || !Number.isInteger(texture.channel) || texture.channel < 0 || texture.channel > 3)
        throw Error("Invalid mesh texture: only embedded raster images are supported.");
    }
  }
}

function captureTexture(texture: Texture | undefined | null): MeshTextureData | undefined {
  const uri = texture?.userData.musubiDataURI;
  if (!texture || typeof uri !== "string" || !dataURI.test(uri)) return undefined;
  return { dataURI: uri, wrapS: texture.wrapS, wrapT: texture.wrapT,
    repeat: texture.repeat.toArray(), offset: texture.offset.toArray(), center: texture.center.toArray(),
    rotation: texture.rotation, flipY: texture.flipY, channel: texture.channel };
}

/** Convert common FBX Phong/Lambert properties to the native standard material. */
export function captureMaterials(materials: Material[]): MeshMaterialData[] {
  const captured = materials.map(material => {
    const m = material as Material & Partial<Record<Slot, Texture | null>> & {
      color?: Color; emissive?: Color; emissiveIntensity?: number; roughness?: number; metalness?: number; shininess?: number; normalScale?: Vector2; bumpScale?: number;
    };
    const result: MeshMaterialData = {
      name: m.name.slice(0, 200), color: `#${(m.color ?? new Color(0xffffff)).getHexString()}`,
      emissive: `#${(m.emissive ?? new Color(0)).getHexString()}`, emissiveIntensity: m.emissiveIntensity ?? 1,
      roughness: m.roughness ?? (m.shininess === undefined ? .8 : Math.max(.04, Math.min(1, Math.sqrt(2 / (m.shininess + 2))))),
      metalness: m.metalness ?? 0, opacity: m.opacity, transparent: m.transparent, alphaTest: m.alphaTest,
      side: m.side, depthWrite: m.depthWrite, normalScale: m.normalScale?.toArray() ?? [1, 1],
      ...(m.bumpScale !== undefined ? { bumpScale: m.bumpScale } : {}),
    };
    for (const slot of MESH_TEXTURE_SLOTS) {
      const texture = captureTexture(m[slot]); if (texture) result[slot] = texture;
    }
    return result;
  });
  validateMeshMaterials(captured); return captured;
}

/** The only loadable sources are validated data URIs; never resolve file or web URLs. */
export function createMaterials(data: MeshMaterialData[], flat: boolean, wire: boolean): MeshStandardMaterial[] {
  validateMeshMaterials(data);
  return data.map(d => {
    const material = new MeshStandardMaterial({ color: d.color, emissive: d.emissive, emissiveIntensity: d.emissiveIntensity,
      roughness: d.roughness, metalness: d.metalness, opacity: d.opacity, transparent: d.transparent, alphaTest: d.alphaTest,
      side: d.side as Side, depthWrite: d.depthWrite, normalScale: new Vector2(...d.normalScale),
      bumpScale: d.bumpScale ?? 1,
      flatShading: flat, polygonOffset: wire, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    material.name = d.name;
    for (const slot of MESH_TEXTURE_SLOTS) {
      const source = d[slot]; if (!source) continue;
      // Headless conversion/tests retain the serializable source without decoding.
      const texture = typeof document === "undefined" ? new Texture() : new TextureLoader().load(source.dataURI);
      texture.userData.musubiDataURI = source.dataURI;
      texture.wrapS = source.wrapS as Wrapping; texture.wrapT = source.wrapT as Wrapping;
      texture.repeat.fromArray(source.repeat); texture.offset.fromArray(source.offset); texture.center.fromArray(source.center);
      texture.rotation = source.rotation; texture.flipY = source.flipY; texture.channel = source.channel;
      texture.colorSpace = slot === "map" || slot === "emissiveMap" ? SRGBColorSpace : NoColorSpace;
      material[slot] = texture;
    }
    return material;
  });
}

/** Dispose shared material/texture instances once, including imported source maps. */
export function disposeMaterials(input: Material | Material[]) {
  const textures = new Set<Texture>();
  for (const material of new Set(Array.isArray(input) ? input : [input])) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    material.dispose();
  }
  textures.forEach(texture => texture.dispose());
}
