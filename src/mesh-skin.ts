import { Matrix4, Vector3 } from "three";
import type { MeshShapeNode } from "./scene-document.ts";

/** Inverse bind matrices operate on the imported world-space rest vertices. */
export type MeshSkin = {
  jointIds: string[];
  inverseBindMatrices: number[][];
  weights: Record<string, { joint: number; weight: number }[]>;
};

export function validateMeshSkin(shape: MeshShapeNode, joints?: ReadonlySet<string>) {
  const skin = shape.skin;
  if (skin === undefined) return;
  if (!skin || !Array.isArray(skin.jointIds) || !skin.jointIds.length || skin.jointIds.length > 1000
    || new Set(skin.jointIds).size !== skin.jointIds.length
    || skin.jointIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || (joints && !joints.has(id)))
    || !Array.isArray(skin.inverseBindMatrices) || skin.inverseBindMatrices.length !== skin.jointIds.length)
    throw Error("Invalid mesh skeleton binding.");
  for (const matrix of skin.inverseBindMatrices) {
    if (!Array.isArray(matrix) || matrix.length !== 16 || matrix.some(n => typeof n !== "number" || !Number.isFinite(n))
      || Math.abs(new Matrix4().fromArray(matrix).determinant()) < 1e-15)
      throw Error("Invalid mesh inverse bind matrix.");
  }
  if (!skin.weights || typeof skin.weights !== "object" || Array.isArray(skin.weights)
    || Object.keys(skin.weights).length !== shape.vertices.length) throw Error("Mesh skin weights must match its vertices.");
  for (const vertex of shape.vertices) {
    const influences = skin.weights[vertex.id];
    if (!Array.isArray(influences) || !influences.length || influences.length > 4
      || new Set(influences.map(i => i?.joint)).size !== influences.length
      || influences.some(i => !i || !Number.isInteger(i.joint) || i.joint < 0 || i.joint >= skin.jointIds.length
        || typeof i.weight !== "number" || !Number.isFinite(i.weight) || i.weight <= 0 || i.weight > 1)
      || Math.abs(influences.reduce((sum, i) => sum + i.weight, 0) - 1) > 1e-5)
      throw Error("Invalid mesh vertex skin weights.");
  }
}

export function deformMeshPositions(shape: MeshShapeNode, world: (id: string) => Matrix4 | undefined, output: Float32Array = new Float32Array(shape.vertices.length * 3), morphWeights?: number[]) {
  const skin = shape.skin;

  const matrices = skin?.jointIds.map((id, i) => {
    const matrix = world(id);
    // Deleted joints leave the mesh in its rest pose until the binding is repaired.
    return matrix ? matrix.clone().multiply(new Matrix4().fromArray(skin!.inverseBindMatrices[i])) : new Matrix4();
  }) ?? [];
  const source = new Vector3(), result = new Vector3(), transformed = new Vector3();
  shape.vertices.forEach((vertex, i) => {
    source.fromArray(vertex.position);
    shape.morphTargets?.forEach((m, j) => { const delta = m.deltas[vertex.id]; source.addScaledVector(transformed.fromArray(delta), morphWeights?.[j] ?? m.weight); });
    if (!skin) { source.toArray(output, i * 3); return; }
    result.set(0, 0, 0);
    for (const influence of skin.weights[vertex.id]) result.addScaledVector(transformed.copy(source).applyMatrix4(matrices[influence.joint]), influence.weight);
    result.toArray(output, i * 3);
  });
  return output;
}
