import { Box3, BufferAttribute, BufferGeometry, DynamicDrawUsage, Matrix4, Mesh, MeshBasicMaterial, OctahedronGeometry, Points, ShaderMaterial, Vector3 } from "three";
import type { ParticleFrame } from "./particle-simulation.ts";

/** World-space particle buffers live beneath a selectable local emitter marker. */
export function createParticleRenderable() {
  const markerMaterial = new MeshBasicMaterial({ color: 0xc0ced8, wireframe: true, depthTest: false, transparent: true, opacity: .85 });
  const mesh = new Mesh(new OctahedronGeometry(.12), markerMaterial); mesh.renderOrder = 100003;
  let geometry = new BufferGeometry(); geometry.setDrawRange(0, 0);
  const material = new ShaderMaterial({ transparent: true, depthWrite: false, vertexShader: `
    attribute vec3 particleColor;
    attribute float particleSize;
    attribute float particleOpacity;
    uniform float viewportHeight;
    uniform float maximumPointSize;
    varying vec3 vColor;
    varying float vOpacity;
    void main() {
      vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewPosition;
      float pixels = particleSize * projectionMatrix[1][1] * viewportHeight * 0.5;
      if (projectionMatrix[2][3] == -1.0) pixels /= max(0.0001, -viewPosition.z);
      gl_PointSize = clamp(pixels, 1.0, maximumPointSize);
      vColor = particleColor;
      vOpacity = particleSize > 0.0 && viewPosition.z < 0.0 ? particleOpacity : 0.0;
    }`, fragmentShader: `
    varying vec3 vColor;
    varying float vOpacity;
    void main() {
      float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
      float alpha = vOpacity * (1.0 - smoothstep(0.7, 1.0, radius));
      if (alpha < 0.001) discard;
      gl_FragColor = vec4(vColor, alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`, uniforms: { viewportHeight: { value: 1 }, maximumPointSize: { value: 64 } } });
  const cloud = new Points(geometry, material); cloud.matrixAutoUpdate = false; cloud.frustumCulled = false; mesh.add(cloud);
  const markerBounds = new Box3(new Vector3(-.12, -.12, -.12), new Vector3(.12, .12, .12));
  const bounds = markerBounds.clone(), worldBounds = new Box3(), inverse = new Matrix4(), previousWorld = new Matrix4();
  const point = new Vector3(); let capacity = 0, disposed = false, poseKnown = false;
  const attributes = ["position", "particleColor", "particleSize", "particleOpacity"] as const;
  function refreshBounds() { bounds.copy(markerBounds); if (!worldBounds.isEmpty()) bounds.union(worldBounds.clone().applyMatrix4(inverse)); }
  return {
    mesh, bounds, centers: new Float32Array([0, 0, 0]),
    setFrame(frame: ParticleFrame) {
      if (disposed) return;
      if (frame.count > capacity) {
        const previousGeometry = geometry; geometry = new BufferGeometry(); cloud.geometry = geometry;
        previousGeometry.dispose();
        capacity = Math.max(frame.count, Math.min(20000, Math.max(64, capacity * 2)));
        for (const name of attributes) {
          const width = name === "position" || name === "particleColor" ? 3 : 1;
          geometry.setAttribute(name, new BufferAttribute(new Float32Array(capacity * width), width).setUsage(DynamicDrawUsage));
        }
      }
      if (frame.count) for (const [index, values] of [frame.positions, frame.colors, frame.sizes, frame.opacities].entries()) {
        const attribute = geometry.getAttribute(attributes[index]) as BufferAttribute;
        (attribute.array as Float32Array).set(values); attribute.clearUpdateRanges(); attribute.addUpdateRange(0, values.length); attribute.needsUpdate = true;
      }
      geometry.setDrawRange(0, frame.count); worldBounds.makeEmpty();
      let radius = 0;
      for (let i = 0; i < frame.count; i++) { worldBounds.expandByPoint(point.fromArray(frame.positions, i * 3)); radius = Math.max(radius, frame.sizes[i] / 2); }
      if (!worldBounds.isEmpty()) worldBounds.expandByScalar(radius);
      refreshBounds();
    },
    clear() { geometry.setDrawRange(0, 0); worldBounds.makeEmpty(); refreshBounds(); },
    setWorldTransform(world: Matrix4) {
      if (poseKnown && world.equals(previousWorld)) return;
      previousWorld.copy(world); poseKnown = true; inverse.copy(world).invert(); cloud.matrix.copy(inverse); cloud.matrixWorldNeedsUpdate = true; refreshBounds();
    },
    setViewport(height: number, maximumPointSize: number) { material.uniforms.viewportHeight.value = height; material.uniforms.maximumPointSize.value = maximumPointSize; },
    setMarkerVisible(visible: boolean) { markerMaterial.visible = visible; },
    dispose() { if (disposed) return; disposed = true; geometry.dispose(); material.dispose(); mesh.geometry.dispose(); markerMaterial.dispose(); mesh.removeFromParent(); },
  };
}
