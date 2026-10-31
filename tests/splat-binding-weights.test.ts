import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ExtSplats, type SplatMesh, type SplatSkinning } from "@sparkjsdev/spark";
import { createBinding } from "../src/splat-binding.ts";
import { elasticityDefaults } from "../src/elasticity.ts";
import type { SkinBinding } from "../src/scene-document.ts";

function fixture(overrides?: SkinBinding["weights"], opacity = 1) {
  const source = new ExtSplats({ maxSplats: 8 });
  for (const x of [0, 0.1]) source.pushSplat(new THREE.Vector3(x, 0.1, 0), new THREE.Vector3(0.06, 0.06, 0.005), new THREE.Quaternion(), opacity, new THREE.Color(1, 1, 1));
  const mesh = new THREE.Object3D() as unknown as SplatMesh;
  Object.assign(mesh, { extSplats: source, numSplats: 2, minRaycastOpacity: 0.01, enableLod: true, updateGenerator: vi.fn() });
  const rest = [new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(0.1, 0, 0)];
  const binding: SkinBinding = { jointIds: ["a", "b"], restMatrices: rest.map(matrix => matrix.toArray()), ...(overrides ? { weights: overrides } : {}) };
  return { source, mesh, rest, binding };
}

describe("authored skin weights in Spark binding", () => {
  it("preserves the previous automatic nearest-influence weights", () => {
    const f = fixture(), runtime = createBinding(f.mesh, f.binding);
    const center = f.source.getSplat(0).center;
    const weights = f.rest.map(matrix => 1 / Math.max(1e-8, center.distanceToSquared(new THREE.Vector3().setFromMatrixPosition(matrix))));
    const sum = weights.reduce((a, b) => a + b);
    expect(runtime.getWeights(0)).toEqual([{ jointId: "a", weight: weights[0] / sum }, { jointId: "b", weight: weights[1] / sum }]);
    const skin = f.mesh.skinning as SplatSkinning;
    expect(skin.skinData[0] & 255).toBe(Math.round(weights[0] / sum * 255));
    expect(skin.skinData[1] >> 8).toBe(1);
    runtime.dispose(); f.source.dispose();
  });

  it("returns precise authored values while previewing exactly the packed GPU pose", () => {
    const authored = 0.123456789;
    const f = fixture({ count: 2, overrides: {
      "0": [{ jointId: "a", weight: authored }, { jointId: "b", weight: 1 - authored }],
      "1": [{ jointId: "a", weight: 0.5 }, { jointId: "b", weight: 0.5 }],
    } });
    const runtime = createBinding(f.mesh, f.binding);
    const current = [new THREE.Matrix4().makeTranslation(1, 0, 0), new THREE.Matrix4().makeTranslation(0.1, 2, 0)];
    runtime.update(id => current[id === "a" ? 0 : 1]);
    expect(runtime.getWeights(0)).toEqual(f.binding.weights!.overrides["0"]);
    const copy = runtime.getWeights(0); copy[0].weight = 0;
    expect(runtime.getWeights(0)[0].weight).toBe(authored);
    const skin = f.mesh.skinning as SplatSkinning;
    expect((skin.skinData[4] & 255) + (skin.skinData[5] & 255)).toBe(256);
    const expected = runtime.selection().centers;
    const getSplat = vi.spyOn(f.source, "getSplat");
    expect([...runtime.getComponentPositions([1, 0])]).toEqual([...expected.slice(3, 6), ...expected.slice(0, 3)]);
    expect(getSplat).toHaveBeenCalledTimes(2);
    expect(runtime.componentCount).toBe(2);
    runtime.dispose(); f.source.dispose();
  });

  it("matches opacity filtering and rejects invalid component indices before reading data", () => {
    const f = fixture(undefined, 0), runtime = createBinding(f.mesh, f.binding);
    expect([...runtime.getComponentPositions([0])].every(Number.isNaN)).toBe(true);
    const getSplat = vi.spyOn(f.source, "getSplat");
    for (const index of [-1, 2, 0.5, NaN, Infinity]) {
      expect(() => runtime.getWeights(index)).toThrow(/index/);
      expect(() => runtime.getComponentPositions([0, index])).toThrow(/index/);
    }
    expect(getSplat).not.toHaveBeenCalled();
    expect(runtime.getComponentPositions([])).toHaveLength(0);
    runtime.dispose(); runtime.dispose(); f.source.dispose();
  });

  it("rejects mismatched source counts before attaching skinning", () => {
    const f = fixture({ count: 3, overrides: {} });
    expect(() => createBinding(f.mesh, f.binding)).toThrow(/count|component|splat/i);
    expect(f.mesh.skinning).toBeFalsy();
    expect(f.mesh.updateGenerator).not.toHaveBeenCalled();
    f.source.dispose();
  });

  it("passes authored weights into elasticity and excludes generated fill from editable components", () => {
    const f = fixture({ count: 2, overrides: { "0": [{ jointId: "a", weight: 1 }], "1": [{ jointId: "b", weight: 1 }] } });
    const runtime = createBinding(f.mesh, f.binding, { ...elasticityDefaults, budget: 4 }, [
      { id: "a", name: "a", parentId: null, position: [0, 0, 0] },
      { id: "b", name: "b", parentId: "a", position: [0.1, 0, 0] },
    ]);
    runtime.update(id => id === "a" ? f.rest[0] : new THREE.Matrix4().makeTranslation(0.5, 0, 0));
    expect(f.source.numSplats).toBeGreaterThan(2);
    expect(runtime.componentCount).toBe(2);
    expect(runtime.getWeights(0)).toEqual([{ jointId: "a", weight: 1 }]);
    expect(runtime.getWeights(1)).toEqual([{ jointId: "b", weight: 1 }]);
    const skin = f.mesh.skinning as SplatSkinning;
    const fill = [...skin.skinData.slice(8, 12)].filter(value => (value & 255) > 0);
    expect(fill.map(value => value >> 8).sort()).toEqual([0, 1]);
    expect(() => runtime.getComponentPositions([2])).toThrow(/index/);
    expect([...runtime.getComponentPositions([0, 1])]).toEqual([...runtime.selection().centers.slice(0, 6)]);
    runtime.dispose(); expect(f.source.numSplats).toBe(2); f.source.dispose();
  });
});
