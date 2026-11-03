import { Color, Texture, Vector2, type Wrapping } from "three";
import type { MeshShapeNode } from "./scene-document";
import { validateMeshMaterials, type MeshTextureData } from "./mesh-materials";

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
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(Error("Could not decode the embedded base-color texture.")); image.src = dataURI; });
  const width = image.naturalWidth, height = image.naturalHeight;
  if (!width || !height || width * height > 16_777_216) throw Error("Base-color textures must be at most 16 million pixels for conversion.");
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw Error("Could not read the base-color texture.");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;
  canvas.width = canvas.height = 0;
  return { width, height, data };
}

/** Read only embedded base-color textures; original mesh/materials are never mutated. */
export async function createMeshSplatColors(shape: MeshShapeNode) {
  if (shape.materials) validateMeshMaterials(shape.materials);
  const warnings = new Set<string>();
  const rasters = new Map<string, Promise<SplatColorRaster>>();
  const usedMaterials = shape.faces ? new Set(shape.faces.map(face => face.materialIndex ?? 0)) : undefined;
  const rasterFor = (uri: string) => {
    if (!rasters.has(uri)) rasters.set(uri, decodeRaster(uri));
    return rasters.get(uri)!;
  };
  const entries = await Promise.all((shape.materials ?? []).map(async (material, index) => {
    if (usedMaterials && !usedMaterials.has(index)) return { color: new Color(material.color) };
    const fail = (detail: string): never => { throw Error(`Material "${material.name || index + 1}" uses ${detail}. Conversion currently requires opaque surfaces.`); };
    // FBX exporters can enable blending on otherwise fully opaque materials.
    // Match the actual opacity/alpha behavior rather than treating that flag as transparency.
    if (material.transparent && material.opacity < 1) fail(`opacity ${material.opacity}`);
    if (material.alphaTest > material.opacity) fail("an alpha cutoff above its opacity");
    let minimumAlpha = 1;
    if (material.alphaMap && (material.transparent || material.alphaTest > 0)) {
      const alpha = await rasterFor(material.alphaMap.dataURI);
      // Three uses the green channel of alphaMap, not its image alpha channel.
      for (let i = 1; i < alpha.data.length; i += 4) {
        minimumAlpha = Math.min(minimumAlpha, alpha.data[i] / 255);
        const opacity = material.opacity * alpha.data[i] / 255;
        if ((material.transparent && opacity < 1) || (material.alphaTest > 0 && opacity < material.alphaTest)) fail("an opacity map with transparent or cutout pixels");
      }
    }
    if (material.normalMap || material.bumpMap || material.roughnessMap || material.metalnessMap || material.metalness > 0) warnings.add("Only base color is converted; surface detail and reflections are not preserved.");
    if (material.emissiveMap || new Color(material.emissive).getHex() !== 0) warnings.add("Emissive appearance is not preserved.");
    const source = material.map;
    if (!source) return { color: new Color(material.color) };
    const coordinates = source.channel === 0 ? shape.uvs : shape.uvSets?.[String(source.channel)];
    if (!coordinates) throw Error(`Base-color texture uses a missing UV set (${source.channel}).`);
    for (const vertex of shape.vertices) if (!coordinates[vertex.id]) throw Error("Base-color texture is missing mesh UV coordinates.");
    const raster = await rasterFor(source.dataURI);
    for (let i = 3; i < raster.data.length; i += 4) {
      const opacity = material.opacity * minimumAlpha * raster.data[i] / 255;
      if ((material.transparent && opacity < 1) || (material.alphaTest > 0 && opacity < material.alphaTest)) fail("a base-color texture with transparent or cutout pixels");
    }
    const texture = new Texture();
    texture.wrapS = source.wrapS as Wrapping; texture.wrapT = source.wrapT as Wrapping;
    texture.repeat.fromArray(source.repeat); texture.offset.fromArray(source.offset); texture.center.fromArray(source.center);
    texture.rotation = source.rotation; texture.flipY = source.flipY; texture.updateMatrix();
    return { color: new Color(material.color), raster, texture, coordinates, source };
  }));
  return {
    warnings: [...warnings],
    sample(vertexIds: TriangleIds, bary: Barycentric, materialIndex: number): Color {
      if (!entries.length) return new Color(shape.color);
      const entry = entries[materialIndex];
      if (!entry) throw Error("Triangle references a missing material.");
      const color = entry.color.clone();
      if (entry.raster && entry.texture && entry.coordinates) {
        const uv = new Vector2();
        vertexIds.forEach((id, index) => { const coordinate = entry.coordinates![id]; uv.x += coordinate[0] * bary[index]; uv.y += coordinate[1] * bary[index]; });
        entry.texture.transformUv(uv);
        color.multiply(rasterColor(entry.raster, uv, entry.source!));
      }
      return color;
    },
  };
}
