import { Matrix4, Vector3 } from "three";
import { meshEdges } from "./mesh-modeling.ts";
import type { MeshShapeNode, Vec3 } from "./scene-document.ts";
import type { MeshComponentMode } from "./mesh-component-selection.ts";

export type MeshComponentVertexChange = { id: string; position: Vec3 };
export type MeshComponentTransform = {
  pivot: Vector3;
  vertexIds: readonly string[];
  baseline: readonly { readonly id: string; readonly position: readonly [number, number, number] }[];
  changes(deltaWorld: Matrix4): MeshComponentVertexChange[];
};
const MAX_SELECTED_COMPONENTS = 20_000;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const validPosition = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && [0, 1, 2].every(index => typeof value[index] === "number" && Number.isFinite(value[index]) && Math.abs(value[index]) <= 1e6);

/** Resolve shared topology once; each selected vertex appears once in authored vertex order. */
export function resolveMeshComponentVertices(shape: MeshShapeNode, mode: MeshComponentMode, ids: readonly string[]): string[] {
  if (shape?.type !== "meshShape" || !Array.isArray(shape.vertices) || !Array.isArray(shape.faces)) throw Error("Choose a polygon mesh for component transforms.");
  if (!["vertex", "edge", "face"].includes(mode)) throw Error("Choose vertex, edge or face component mode.");
  if (!Array.isArray(ids) || !ids.length) throw Error("Select mesh components before transforming them.");
  if (ids.length > MAX_SELECTED_COMPONENTS) throw Error("Transform at most 20,000 selected mesh components per operation.");
  const available = new Set(shape.vertices.map(vertex => vertex.id));
  if (available.size !== shape.vertices.length || [...available].some(id => !validId(id))) throw Error("Mesh vertex IDs must be valid and unique.");
  const requested = new Set<string>();
  for (const id of ids) {
    if (mode === "edge") {
      let pair: unknown;
      try { pair = typeof id === "string" ? JSON.parse(id) : undefined; } catch { throw Error("Malformed mesh edge ID."); }
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(validId) || pair[0] >= pair[1] || JSON.stringify(pair) !== id) throw Error("Malformed mesh edge ID.");
    } else if (!validId(id)) throw Error("Malformed mesh component ID.");
    requested.add(id);
  }
  const selected = new Set<string>();
  if (mode === "vertex") for (const id of requested) { if (!available.has(id)) throw Error("A selected mesh vertex no longer exists."); selected.add(id); }
  else {
    const components = new Map((mode === "edge" ? meshEdges(shape) : shape.faces).map(component => [component.id, component.vertices]));
    for (const id of requested) {
      const vertices = components.get(id);
      if (!vertices) throw Error(`A selected mesh ${mode} no longer exists.`);
      for (const vertex of vertices) { if (!available.has(vertex)) throw Error("Selected mesh topology references a missing vertex."); selected.add(vertex); }
    }
  }
  if (!selected.size) throw Error("The component selection contains no vertices.");
  return shape.vertices.filter(vertex => selected.has(vertex.id)).map(vertex => vertex.id);
}

function affineSnapshot(matrix: Matrix4, label: string): Matrix4 {
  if (!matrix?.isMatrix4 || matrix.elements.length !== 16 || !matrix.elements.every(Number.isFinite)) throw Error(`${label} must contain finite matrix values.`);
  const values = matrix.elements;
  if ([values[3], values[7], values[11]].some(value => Math.abs(value) > 1e-12) || Math.abs(values[15] - 1) > 1e-12) throw Error(`${label} must be affine; perspective component transforms are unsupported.`);
  const result = matrix.clone(); result.elements[3] = result.elements[7] = result.elements[11] = 0; result.elements[15] = 1;
  const determinant = result.determinant();
  if (!Number.isFinite(determinant) || determinant === 0 || !result.clone().invert().elements.every(Number.isFinite)) throw Error(`${label} must be invertible; singular component transforms are unsupported.`);
  return result;
}

/** Capture before a gesture. Every preview uses the same immutable local
 * baseline, so repeated events never accumulate roundoff or edit the document.
 * deltaWorld is the complete world-space delta, including any pivot sandwich. */
export function captureMeshComponentTransform(shape: MeshShapeNode, mode: MeshComponentMode, ids: readonly string[], meshWorld: Matrix4): MeshComponentTransform {
  const vertexIds = Object.freeze(resolveMeshComponentVertices(shape, mode, ids));
  const selected = new Set(vertexIds), world = affineSnapshot(meshWorld, "Mesh world matrix"), inverseWorld = world.clone().invert();
  const baseline = Object.freeze(shape.vertices.filter(vertex => selected.has(vertex.id)).map(vertex => {
    if (!validPosition(vertex.position)) throw Error("Mesh component coordinates must be finite and within ±1,000,000.");
    return Object.freeze({ id: vertex.id, position: Object.freeze([...vertex.position]) as readonly [number, number, number] });
  }));
  const pivot = new Vector3();
  for (const vertex of baseline) pivot.add(new Vector3(...vertex.position).applyMatrix4(world).multiplyScalar(1 / baseline.length));
  if (!pivot.toArray().every(Number.isFinite)) throw Error("Selected components have a non-finite world-space pivot.");
  const identity = new Matrix4();
  return {
    pivot, vertexIds, baseline,
    changes(deltaWorld) {
      const delta = affineSnapshot(deltaWorld, "Component delta matrix");
      // Preserve exact coordinates for a cancelled/no-motion gesture.
      if (delta.equals(identity)) return baseline.map(vertex => ({ id: vertex.id, position: [...vertex.position] as Vec3 }));
      const localDelta = inverseWorld.clone().multiply(delta).multiply(world);
      return baseline.map(vertex => {
        const position = new Vector3(...vertex.position).applyMatrix4(localDelta).toArray() as Vec3;
        if (!validPosition(position)) throw Error("Transformed component coordinates must remain finite and within ±1,000,000.");
        return { id: vertex.id, position };
      });
    },
  };
}
