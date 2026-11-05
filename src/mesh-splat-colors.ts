import { Color, Texture, Vector2, type Wrapping } from "three";
import type { MeshShapeNode } from "./scene-document";
import { validateMeshMaterials, meshTextureURI, type MeshTextureData } from "./mesh-materials";

export type SplatColorRaster = { width: number; height: number; data: Uint8ClampedArray };
type TriangleIds = [string, string, string];
type Barycentric = [number, number, number];

/** Pure CPU sampler; the texture matrix/wrap conventions match Three's mesh materials. */
export function sampleSplatTexture(raster: SplatColorRaster, source: MeshTextureData, uv: Vector2): Color {
  const texture = new Texture();
  texture.wrapS = source.wrapS as Wrapping; texture.wrapT = source.wrapT as Wrapping;
  texture.repeat.fromArray(source.repeat); texture.offset.fromArray(source.offset); texture.center.fromArray(source.center);
  texture.rotation = source.rotation; texture.flipY = source.flipY; texture.updateMatrix();
  texture.transformUv(uv);
  return rasterColor(raster, uv, source);
}

function rasterColor(raster: SplatColorRaster, uv: Vector2, source: Pick<MeshTextureData, "wrapS" | "wrapT">): Color {
  // Filter neighboring texels across repeat seams, matching texture addressing.
  const address = (value: number, size: number, wrapping: number) => {
    if (wrapping === 1000) return ((value % size) + size) % size;
    if (wrapping === 1002) { const wrapped = ((value % (size * 2)) + size * 2) % (size * 2); return wrapped < size ? wrapped : size * 2 - wrapped - 1; }
    return Math.max(0, Math.min(size - 1, value));
  };
  const x = uv.x * raster.width - .5;
  const y = uv.y * raster.height - .5;
  const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top;
  const result = new Color(0, 0, 0);
  for (const [px, py, weight] of [[left, top, (1 - fx) * (1 - fy)], [left + 1, top, fx * (1 - fy)], [left, top + 1, (1 - fx) * fy], [left + 1, top + 1, fx * fy]]) {
    const offset = (address(py, raster.height, source.wrapT) * raster.width + address(px, raster.width, source.wrapS)) * 4;
    const color = new Color(raster.data[offset] / 255, raster.data[offset + 1] / 255, raster.data[offset + 2] / 255).convertSRGBToLinear();
    result.r += color.r * weight; result.g += color.g * weight; result.b += color.b * weight;
  }
  return result;
}

async function decodeRaster(dataURI: string): Promise<SplatColorRaster> {
  if (typeof document === "undefined" || typeof Image === "undefined") throw Error("Textured splat conversion requires a browser.");
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(Error("Could not decode the embedded material texture.")); image.src = dataURI; });
  const width = image.naturalWidth, height = image.naturalHeight;
  if (!width || !height || width * height > 16_777_216) throw Error("Material textures must be at most 16 million pixels for conversion.");
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw Error("Could not read the material texture.");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;
  canvas.width = canvas.height = 0;
  return { width, height, data };
}

/** Raw alpha/opacity values are linear data, unlike base-color RGB. */
function rasterChannel(raster: SplatColorRaster, uv: Vector2, source: MeshTextureData, channel: number): number {
  const address = (value: number, size: number, wrap: number) => {
    if (wrap === 1000) return ((value % size) + size) % size;
    if (wrap === 1002) { const n = ((value % (size * 2)) + size * 2) % (size * 2); return n < size ? n : size * 2 - n - 1; }
    return Math.max(0, Math.min(size - 1, value));
  };
  const x = uv.x * raster.width - .5, y = uv.y * raster.height - .5;
  const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top;
  let result = 0;
  for (const [px, py, weight] of [[left,top,(1-fx)*(1-fy)],[left+1,top,fx*(1-fy)],[left,top+1,(1-fx)*fy],[left+1,top+1,fx*fy]]) {
    result += raster.data[(address(py,raster.height,source.wrapT)*raster.width+address(px,raster.width,source.wrapS))*4+channel]/255*weight;
  }
  return result;
}
export type SplatSurfaceAppearance = { color: Color; opacity: number };

/** Sample material appearance only where the mesh surface uses each texture. */
export async function createMeshSplatColors(shape: MeshShapeNode, assets?: Readonly<Record<string, import("./texture-assets.ts").TextureAsset>>) {
  if (shape.materials) validateMeshMaterials(shape.materials);
  const warnings = new Set<string>(), rasters = new Map<string, Promise<SplatColorRaster>>();
  const usedMaterials = shape.faces ? new Set(shape.faces.map(face => face.materialIndex ?? 0)) : undefined;
  async function prepareMap(source: MeshTextureData | undefined) {
    if (!source) return undefined;
    const coordinates = source.channel === 0 ? shape.uvs : shape.uvSets?.[String(source.channel)];
    if (!coordinates) throw Error(`Texture uses a missing UV set (${source.channel}).`);
    for (const vertex of shape.vertices) if (!coordinates[vertex.id]) throw Error("Texture is missing mesh UV coordinates.");
    const uri = meshTextureURI(source, assets);
    if (!rasters.has(uri)) rasters.set(uri, decodeRaster(uri));
    const raster = await rasters.get(uri)!;
    const texture = new Texture();
    texture.wrapS = source.wrapS as Wrapping; texture.wrapT = source.wrapT as Wrapping;
    texture.repeat.fromArray(source.repeat); texture.offset.fromArray(source.offset); texture.center.fromArray(source.center);
    texture.rotation = source.rotation; texture.flipY = source.flipY; texture.updateMatrix();
    return { raster, source, uv(ids: TriangleIds, bary: Barycentric) {
      const uv = new Vector2();
      ids.forEach((id, i) => { uv.x += coordinates[id][0]*bary[i]; uv.y += coordinates[id][1]*bary[i]; });
      texture.transformUv(uv); return uv;
    } };
  }
  const entries = await Promise.all((shape.materials ?? []).map(async (material, index) => {
    if (usedMaterials && !usedMaterials.has(index)) return undefined;
    if (material.normalMap || material.bumpMap || material.roughnessMap || material.metalnessMap || material.metalness > 0) warnings.add("Only base color and opacity are converted; surface detail and reflections are not preserved.");
    if (material.emissiveMap || new Color(material.emissive).getHex() !== 0) warnings.add("Emissive appearance is not preserved.");
    const [map, alphaMap] = await Promise.all([prepareMap(material.map), prepareMap(material.transparent || material.alphaTest > 0 ? material.alphaMap : undefined)]);
    return { material, map, alphaMap };
  }));
  const sampleSurface = (ids: TriangleIds, bary: Barycentric, materialIndex: number): SplatSurfaceAppearance => {
    if (!entries.length) return { color: new Color(shape.color), opacity: 1 };
    const entry = entries[materialIndex];
    if (!entry) throw Error("Triangle references a missing or unused material.");
    const { material, map, alphaMap } = entry;
    const color = new Color(material.color);
    let opacity = material.opacity;
    if (map) {
      const uv = map.uv(ids,bary);
      color.multiply(rasterColor(map.raster,uv,map.source));
      opacity *= rasterChannel(map.raster,uv,map.source,3);
    }
    if (alphaMap) opacity *= rasterChannel(alphaMap.raster,alphaMap.uv(ids,bary),alphaMap.source,1);
    if (opacity < material.alphaTest) return { color, opacity: 0 };
    // Three's opaque shader forces surviving fragments to alpha=1.
    return { color, opacity: material.transparent ? opacity : 1 };
  };
  return { warnings: [...warnings], sampleSurface,
    sample(ids: TriangleIds, bary: Barycentric, materialIndex: number): Color { return sampleSurface(ids,bary,materialIndex).color; },
  };
}
