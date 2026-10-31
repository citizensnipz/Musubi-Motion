import { describe, expect, it, vi } from "vitest";
import { BufferGeometry, Group, Matrix4, Points, ShaderMaterial, Vector3 } from "three";
import { createParticleRenderable } from "../src/particle-renderer.ts";
import type { ParticleFrame } from "../src/particle-simulation.ts";

function frame(positions: number[], sizes?: number[]): ParticleFrame {
  const count = positions.length / 3;
  return { positions: new Float32Array(positions), colors: new Float32Array(Array.from({ length: count }, () => [.25, .5, .75]).flat()),
    sizes: new Float32Array(sizes ?? Array(count).fill(.2)), opacities: new Float32Array(count).fill(.8), count, simulationFrame: 24 };
}
function cloudOf(renderer: ReturnType<typeof createParticleRenderable>) {
  return renderer.mesh.children.find(child => child instanceof Points) as Points<BufferGeometry, ShaderMaterial>;
}
function expectNear(actual: Vector3, expected: Vector3) {
  for (const axis of ["x", "y", "z"] as const) expect(actual[axis]).toBeCloseTo(expected[axis], 9);
}

describe("particle viewport rendering", () => {
  it("copies frame attributes and shrinks draw ranges without reallocating reusable buffers", () => {
    const renderer = createParticleRenderable(), cloud = cloudOf(renderer), first = frame([1, 2, 3, 4, 5, 6], [.4, .8]);
    renderer.setFrame(first);
    const geometry = cloud.geometry, material = cloud.material;
    const positions = geometry.getAttribute("position"), colors = geometry.getAttribute("particleColor");
    expect(Array.from(positions.array).slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(colors.array).slice(0, 6)).toEqual([.25, .5, .75, .25, .5, .75]);
    expect(Array.from(geometry.getAttribute("particleSize").array).slice(0, 2)).toEqual(Array.from(first.sizes));
    expect(Array.from(geometry.getAttribute("particleOpacity").array).slice(0, 2)).toEqual(Array.from(first.opacities));
    first.positions.fill(999); first.colors.fill(0);
    expect(positions.getX(0)).toBe(1); expect(colors.getY(0)).toBe(.5);
    renderer.setFrame(frame([-2, -3, -4], [1]));
    expect(cloud.geometry).toBe(geometry); expect(cloud.material).toBe(material);
    expect(cloud.geometry.getAttribute("position")).toBe(positions);
    expect(geometry.drawRange).toEqual({ start: 0, count: 1 });
    expect(Array.from(positions.array).slice(0, 3)).toEqual([-2, -3, -4]);
    renderer.setViewport(1080, 128);
    expect(material.uniforms.viewportHeight.value).toBe(1080); expect(material.uniforms.maximumPointSize.value).toBe(128);
    renderer.setMarkerVisible(false); expect(renderer.mesh.material.visible).toBe(false); expect(cloud.visible).toBe(true);
    renderer.dispose();
  });

  it("keeps born particles in world space while their emitter hierarchy translates, rotates and scales", () => {
    const renderer = createParticleRenderable(), root = new Group(), parent = new Group(), cloud = cloudOf(renderer);
    root.add(parent); parent.add(renderer.mesh);
    const worldPosition = new Vector3(7, -2, 3); renderer.setFrame(frame(worldPosition.toArray(), [1]));
    for (let step = 0; step < 2; step++) {
      root.position.set(10 + step * 7, -3, 5); root.rotation.set(.1, .2, .3 + step);
      parent.scale.set(2 + step, .5, 1.5); parent.rotation.y = .7;
      renderer.mesh.position.set(1, 2, -3); renderer.mesh.rotation.z = .4;
      root.updateMatrixWorld(true); renderer.setWorldTransform(renderer.mesh.matrixWorld); root.updateMatrixWorld(true);
      expectNear(new Vector3().fromBufferAttribute(cloud.geometry.getAttribute("position"), 0).applyMatrix4(cloud.matrixWorld), worldPosition);
      expectNear(new Vector3().setFromMatrixPosition(cloud.matrixWorld), new Vector3());
      const localCenter = worldPosition.clone().applyMatrix4(renderer.mesh.matrixWorld.clone().invert());
      expect(renderer.bounds.containsPoint(localCenter)).toBe(true);
    }
    renderer.dispose();
  });

  it("includes particle diameters in bounds and restores marker-only bounds for empty frames and clear", () => {
    const renderer = createParticleRenderable(), cloud = cloudOf(renderer);
    renderer.setWorldTransform(new Matrix4()); renderer.setFrame(frame([10, 0, 0], [2]));
    expectNear(renderer.bounds.min, new Vector3(-.12, -1, -1)); expectNear(renderer.bounds.max, new Vector3(11, 1, 1));
    renderer.setWorldTransform(new Matrix4().makeTranslation(20, 0, 0));
    expectNear(renderer.bounds.min, new Vector3(-11, -1, -1)); expectNear(renderer.bounds.max, new Vector3(.12, 1, 1));
    const bounds = renderer.bounds, geometry = cloud.geometry;
    renderer.setFrame(frame([])); expect(cloud.geometry.drawRange.count).toBe(0); expect(cloud.geometry).toBe(geometry);
    expect(renderer.bounds).toBe(bounds); expectNear(bounds.min, new Vector3(-.12, -.12, -.12)); expectNear(bounds.max, new Vector3(.12, .12, .12));
    renderer.setFrame(frame([100, 100, 100])); renderer.clear();
    expect(cloud.geometry.drawRange.count).toBe(0); expectNear(bounds.min, new Vector3(-.12, -.12, -.12)); expectNear(bounds.max, new Vector3(.12, .12, .12));
    renderer.dispose();
  });

  it("disposes superseded growth geometry and releases every current resource exactly once", () => {
    const renderer = createParticleRenderable(), parent = new Group(); parent.add(renderer.mesh);
    const cloud = cloudOf(renderer); renderer.setFrame(frame([1, 2, 3]));
    const previous = cloud.geometry, previousDisposed = vi.spyOn(previous, "dispose"), material = cloud.material;
    // Request more than the observed capacity without assuming an allocation policy.
    const nextCount = previous.getAttribute("position").count + 1;
    renderer.setFrame(frame(Array.from({ length: nextCount }, (_, index) => [index, 0, 0]).flat()));
    expect(cloud.geometry).not.toBe(previous); expect(previousDisposed).toHaveBeenCalledTimes(1);
    expect(cloud.material).toBe(material); expect(cloud.geometry.drawRange.count).toBe(nextCount);
    const currentGeometry = cloud.geometry;
    const resources = [currentGeometry, cloud.material, renderer.mesh.geometry, renderer.mesh.material];
    const disposed = resources.map(resource => vi.spyOn(resource, "dispose"));
    renderer.dispose(); renderer.dispose(); renderer.setFrame(frame([9, 9, 9]));
    for (const spy of disposed) expect(spy).toHaveBeenCalledTimes(1);
    expect(previousDisposed).toHaveBeenCalledTimes(1); expect(renderer.mesh.parent).toBeNull(); expect(cloud.geometry).toBe(currentGeometry);
  });
});
