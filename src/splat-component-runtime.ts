import { dyno, type SplatMesh } from "@sparkjsdev/spark";
import { Box3, DataTexture, Matrix3, Matrix4, Quaternion, Ray, RedIntegerFormat, Sphere, UnsignedIntType, Vector3, type Raycaster } from "three";
import type { SplatComponentEdits } from "./splat-component-edits.ts";

const MASK_WIDTH = 2048;
export function populateSplatEditMask(words: Uint32Array, edits: SplatComponentEdits) {
  words.fill(0);
  for (const ranges of [edits.hidden, edits.deleted]) for (let i = 0; i < ranges.length; i += 2) {
    const start = ranges[i], end = ranges[i + 1], first = start >>> 5, last = (end - 1) >>> 5;
    const firstMask = 0xffffffff << (start & 31), lastMask = 0xffffffff >>> (31 - ((end - 1) & 31));
    if (first === last) words[first] |= firstMask & lastMask;
    else {
      words[first] |= firstMask; words.fill(0xffffffff, first + 1, last); words[last] |= lastMask;
    }
  }
}

/** The shader sees the original fetch index, including on the covariance/skin path.
 * LoD must be disabled for this instance while the modifier is installed. */
export function createSplatEditMask(mesh: SplatMesh, edits: SplatComponentEdits) {
  const sourceCount = edits.sourceCount;
  const width = Math.min(MASK_WIDTH, Math.ceil(sourceCount / 32));
  const height = Math.ceil(sourceCount / (32 * width));
  const words = new Uint32Array(width * height);
  const texture = new DataTexture(words, width, height, RedIntegerFormat, UnsignedIntType);
  const mask = dyno.dynoUsampler2D(texture), count = dyno.dynoInt(sourceCount);
  const modifier = new dyno.Dyno({
    inTypes: { gsplat: dyno.Gsplat, mask: "usampler2D", count: "int" },
    outTypes: { gsplat: dyno.Gsplat },
    inputs: { mask, count },
    statements: ({ inputs, outputs }) => [
      `${outputs.gsplat} = ${inputs.gsplat};`,
      `if (isGsplatActive(${outputs.gsplat}.flags) && ${outputs.gsplat}.index >= 0 && ${outputs.gsplat}.index < ${inputs.count}) {`,
      `  int word = ${outputs.gsplat}.index >> 5;`,
      `  int width = textureSize(${inputs.mask}, 0).x;`,
      `  uint maskWord = texelFetch(${inputs.mask}, ivec2(word % width, word / width), 0).r;`,
      `  if ((maskWord & (1u << uint(${outputs.gsplat}.index & 31))) != 0u) ${outputs.gsplat}.flags = 0u;`,
      "}",
    ],
  });
  mesh.objectModifiers = [...(mesh.objectModifiers ?? []), modifier];
  mesh.updateGenerator();
  function update(value: SplatComponentEdits) {
    populateSplatEditMask(words, value);
    texture.needsUpdate = true;
    mesh.updateVersion();
  }
  update(edits);
  return {
    update,
    isActive(index: number) { return index >= sourceCount || !(words[index >>> 5] & (1 << (index & 31))); },
    dispose() {
      mesh.objectModifiers = mesh.objectModifiers?.filter(candidate => candidate !== modifier);
      mesh.updateGenerator();
      texture.dispose();
    },
  };
}

/** Read the original source without modifying it. The scratch rotation and extents
 * compute the AABB of the same rotated scale box Spark uses for unbound bounds. */
export function editedSplatBounds(mesh: SplatMesh, active: (index: number) => boolean): Box3 {
  const bounds = new Box3(), rotation = new Matrix4(), extent = new Vector3(), point = new Vector3();
  const source = mesh.extSplats ?? mesh.packedSplats;
  source?.forEachSplat((index, center, scales, quaternion, opacity) => {
    if (!active(index) || opacity * mesh.opacity < mesh.minRaycastOpacity) return;
    const m = rotation.makeRotationFromQuaternion(quaternion).elements;
    extent.set(
      Math.abs(m[0]) * scales.x + Math.abs(m[4]) * scales.y + Math.abs(m[8]) * scales.z,
      Math.abs(m[1]) * scales.x + Math.abs(m[5]) * scales.y + Math.abs(m[9]) * scales.z,
      Math.abs(m[2]) * scales.x + Math.abs(m[6]) * scales.y + Math.abs(m[10]) * scales.z,
    );
    bounds.expandByPoint(point.copy(center).add(extent));
    bounds.expandByPoint(point.copy(center).sub(extent));
  });
  return bounds;
}

/** Unbound edited shapes cannot use Spark's unfiltered original/LoD raycast.
 * Use the same 2-sigma ellipsoid convention as the posed CPU picker. */
export function pickEditedSplats(mesh: SplatMesh, active: (index: number) => boolean, raycaster: Raycaster): number {
  mesh.updateWorldMatrix(true, false);
  const ray = raycaster.ray.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
  const localRay = new Ray(), sphere = new Sphere(new Vector3(), 1);
  const invRotation = new Quaternion(), radii = new Vector3(), point = new Vector3();
  const worldLinear = new Matrix3().setFromMatrix4(mesh.matrixWorld);
  let nearest = Infinity;
  (mesh.extSplats ?? mesh.packedSplats)?.forEachSplat((index, center, scales, quaternion, opacity) => {
    if (!active(index) || opacity * mesh.opacity < mesh.minRaycastOpacity || ray.distanceSqToPoint(center) > 4 * Math.max(scales.x, scales.y, scales.z) ** 2) return;
    if (Math.min(scales.x, scales.y, scales.z) <= 0) return;
    invRotation.copy(quaternion).invert();
    radii.copy(scales).multiplyScalar(2);
    localRay.origin.copy(ray.origin).sub(center).applyQuaternion(invRotation).divide(radii);
    localRay.direction.copy(ray.direction).applyQuaternion(invRotation).divide(radii).normalize();
    if (!localRay.intersectSphere(sphere, point)) return;
    // A vector from the original ray origin avoids precision loss under translations.
    const distance = point.sub(localRay.origin).multiply(radii).applyQuaternion(quaternion).applyMatrix3(worldLinear).length();
    if (distance >= raycaster.near && distance <= raycaster.far) nearest = Math.min(nearest, distance);
  });
  return nearest;
}
