import { describe, expect, it, vi } from "vitest";
import { Raycaster, Vector3 } from "three";
import { createControllerRenderable } from "../src/controller-renderer.ts";
import type { CurveShapeNode } from "../src/scene-document.ts";

function shape(patch: Partial<CurveShapeNode> = {}): CurveShapeNode {
  return { id: "curve", type: "curveShape", name: "controlShape", parentId: "control",
    degree: 1, points: [[-1, 0, 0, 1], [1, 0, 0, 1]], knots: [0, 0, 1, 1],
    closed: false, color: "#44aaff", ...patch };
}

describe("controller curve renderer", () => {
  it("retains line and bounds identity while replacing and disposing edited geometry", () => {
    const renderable = createControllerRenderable(shape());
    const { mesh, bounds, centers } = renderable;
    const previous = mesh.geometry, dispose = vi.spyOn(previous, "dispose");
    expect(bounds.min.toArray()).toEqual([-1, 0, 0]);
    expect(bounds.max.toArray()).toEqual([1, 0, 0]);
    expect(renderable.count).toBe(0);
    renderable.update(shape({ points: [[-3, 2, 1, 1], [4, 5, 1, 1]] }));
    expect(renderable.mesh).toBe(mesh);
    expect(renderable.bounds).toBe(bounds);
    expect(mesh.geometry).not.toBe(previous);
    expect(renderable.centers).not.toBe(centers);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(bounds.min.toArray()).toEqual([-3, 2, 1]);
    expect(bounds.max.toArray()).toEqual([4, 5, 1]);
    expect(mesh.geometry.boundingSphere!.radius).toBeGreaterThan(3);
    renderable.dispose();
  });

  it("updates name and color without reallocating geometry or material", () => {
    const renderable = createControllerRenderable(shape());
    const geometry = renderable.mesh.geometry, material = renderable.mesh.material;
    renderable.update(shape({ color: "#ff3300", name: "renamedShape" }));
    expect(renderable.mesh.geometry).toBe(geometry);
    expect(renderable.mesh.material).toBe(material);
    expect(material.color.getHexString()).toBe("ff3300");
    expect(renderable.mesh.name).toBe("renamedShape");
    renderable.dispose();
  });

  it("adds the closing segment and makes it available to standard line raycasting", () => {
    const open = shape({ points: [[-1, -1, 0, 1], [1, -1, 0, 1], [1, 1, 0, 1]],
      knots: [0, 0, 0.5, 1, 1] });
    const renderable = createControllerRenderable(open);
    const ray = new Raycaster(new Vector3(0, 0, 5), new Vector3(0, 0, -1));
    ray.params.Line.threshold = 0.05;
    renderable.mesh.updateMatrixWorld(true);
    expect(ray.intersectObject(renderable.mesh)).toHaveLength(0);
    renderable.update({ ...open, closed: true });
    expect([...renderable.centers.slice(-3)]).toEqual([...renderable.centers.slice(0, 3)]);
    expect(ray.intersectObject(renderable.mesh).length).toBeGreaterThan(0);
    renderable.update(open);
    expect(ray.intersectObject(renderable.mesh)).toHaveLength(0);
    renderable.dispose();
  });

  it("raycasts with the owning transform and disposes its current resources once", () => {
    const renderable = createControllerRenderable(shape());
    renderable.mesh.position.set(5, 2, 0); renderable.mesh.updateMatrixWorld(true);
    const ray = new Raycaster(new Vector3(5, 2, 5), new Vector3(0, 0, -1));
    ray.params.Line.threshold = 0.01;
    expect(ray.intersectObject(renderable.mesh).length).toBeGreaterThan(0);
    const geometryDispose = vi.spyOn(renderable.mesh.geometry, "dispose");
    const materialDispose = vi.spyOn(renderable.mesh.material, "dispose");
    renderable.dispose(); renderable.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(() => renderable.update(shape())).toThrow(/disposed/);
  });

  it("leaves the current line intact when replacement curve validation fails", () => {
    const renderable = createControllerRenderable(shape());
    const geometry = renderable.mesh.geometry, centers = renderable.centers;
    const dispose = vi.spyOn(geometry, "dispose");
    expect(() => renderable.update(shape({ points: [[0, 0, 0, 0], [2, 0, 0, 1]], color: "#ff0000" }))).toThrow(/weight/i);
    expect(renderable.mesh.geometry).toBe(geometry);
    expect(renderable.centers).toBe(centers);
    expect(renderable.mesh.material.color.getHexString()).toBe("44aaff");
    expect(dispose).not.toHaveBeenCalled();
    renderable.dispose();
  });
});
