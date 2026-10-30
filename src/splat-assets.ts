import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
export function makeDemo() {
  // Sample a knot surface into real anisotropic Gaussian splats, without fetching an asset.
  const geometry = new THREE.TorusKnotGeometry(1.3, 0.37, 400, 28, 2, 3);
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(0.034, 0.034, 0.012);
  const color = new THREE.Color();
  const light = new THREE.Vector3(-0.4, 0.8, 1).normalize();
  const mesh = new SplatMesh({
    extSplats: true,
    covSplats: true,
    constructSplats(splats) {
      for (let i = 0; i < positions.count; i++) {
        position.fromBufferAttribute(positions, i);
        normal.fromBufferAttribute(normals, i);
        rotation.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        const shade = 0.19 + 0.65 * Math.max(0, normal.dot(light));
        color.setRGB(shade, shade, shade);
        splats.pushSplat(position, scale, rotation, 0.95, color);
      }
    },
  });
  geometry.dispose();
  return mesh;
}

export async function prepareSplat(mesh: SplatMesh) {
  await mesh.initialized;
  const extended = mesh.extSplats;
  // Spark 2.4 procedural construction does not finalize GPU textures.
  if (extended && extended.numSplats > 0 && !extended.textures[0].image.data) {
    extended.initialize({
      extArrays: extended.extArrays,
      numSplats: extended.numSplats,
      extra: extended.extra,
      lodSplats: extended.lodSplats,
    });
    mesh.updateGenerator();
  }
  const bounds = mesh.getBoundingBox(false);
  if (
    bounds.isEmpty() ||
    !Number.isFinite(bounds.min.length() + bounds.max.length())
  )
    throw new Error("The file contains no usable splats.");
  const count = mesh.packedSplats?.numSplats ?? mesh.extSplats?.numSplats ?? 0;
  const centers = new Float32Array(count * 3);
  mesh.forEachSplat((index, center, _scale, _rotation, opacity) => {
    centers.set(
      opacity >= mesh.minRaycastOpacity
        ? [center.x, center.y, center.z]
        : [NaN, NaN, NaN],
      index * 3,
    );
  });
  return { bounds, centers, count };
}
