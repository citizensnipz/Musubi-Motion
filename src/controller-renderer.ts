import { Box3, BufferAttribute, BufferGeometry, Line, LineBasicMaterial, Vector3 } from "three";
import { sampleControllerCurve } from "./controller-curves.ts";
import type { CurveShapeNode } from "./scene-document.ts";

export type ControllerRenderable = {
  mesh: Line<BufferGeometry, LineBasicMaterial>;
  /** Local-space bounds. This object retains its identity across updates. */
  bounds: Box3;
  /** Sampled local points, for selection and bounds rather than splat rendering. */
  readonly centers: Float32Array;
  readonly count: 0;
  update(shape: CurveShapeNode): void;
  dispose(): void;
};

function sample(shape: CurveShapeNode): Float32Array {
  return new Float32Array(sampleControllerCurve(shape).flat());
}

function geometryFor(centers: Float32Array): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(centers, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** One owned line/material per controller; the document retains all curve data. */
export function createControllerRenderable(shape: CurveShapeNode): ControllerRenderable {
  let centers = sample(shape);
  const geometry = geometryFor(centers);
  const material = new LineBasicMaterial({ color: shape.color });
  const mesh = new Line(geometry, material);
  mesh.name = shape.name;
  const bounds = geometry.boundingBox?.clone() ?? new Box3(new Vector3(), new Vector3());
  let disposed = false;

  return {
    mesh,
    bounds,
    get centers() { return centers; },
    count: 0,
    update(next) {
      if (disposed) throw Error("Cannot update a disposed controller renderer.");
      // Sample first so invalid curve data cannot partially update the renderable.
      const nextCenters = sample(next);
      const changed = nextCenters.length !== centers.length
        || nextCenters.some((value, index) => value !== centers[index]);
      if (changed) {
        const nextGeometry = geometryFor(nextCenters);
        const previous = mesh.geometry;
        mesh.geometry = nextGeometry;
        centers = nextCenters;
        bounds.copy(nextGeometry.boundingBox!);
        previous.dispose();
      }
      material.color.set(next.color);
      mesh.name = next.name;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
