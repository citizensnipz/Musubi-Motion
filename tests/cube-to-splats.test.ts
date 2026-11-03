import { expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { createMeshPrimitive, findMeshShape } from "../src/mesh-modeling";
import { createSceneStore } from "../src/scene-store";
import { addSplat } from "../src/scene-document";
import { cubeSplatFaces, cubeToSplatBytes, defaultCubeSplatSettings } from "../src/cube-to-splats";
import { decodeProjectBlob, encodeProjectBlob } from "../src/project-archive";
function fixture() {
  const store = createSceneStore(), id = createMeshPrimitive(store, "cube");
  return { store, shape: findMeshShape(store.getState().document, id)! };
}
it.each([16, 32, 64])("covers six faces with %i by %i finite, oriented, flattened splats", resolution => {
  const { shape } = fixture(), faces = cubeSplatFaces(shape), bytes = cubeToSplatBytes(shape, { ...defaultCubeSplatSettings, resolution });
  expect(bytes.length).toBe(6 * resolution ** 2 * 32);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length / 32; i++) {
    const offset = i * 32, face = faces[Math.floor(i / resolution ** 2)];
    const p = new Vector3(...[0, 1, 2].map(axis => view.getFloat32(offset + axis * 4, true)));
    expect(Math.abs(p.clone().sub(face.a).dot(face.normal))).toBeLessThan(1e-6);
    expect(view.getFloat32(offset + 12, true)).toBeCloseTo(face.side / resolution * .65);
    expect(view.getFloat32(offset + 20, true)).toBeLessThan(view.getFloat32(offset + 12, true));
    const q = [0, 1, 2, 3].map(axis => (bytes[offset + 28 + axis] - 128) / 128);
    const normal = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(q[1], q[2], q[3], q[0]).normalize());
    expect(normal.dot(face.normal)).toBeGreaterThan(.999);
  }
});
it("rejects unsupported geometry and invalid settings", () => {
  const { shape } = fixture();
  expect(() => cubeSplatFaces({ ...shape, faces: shape.faces.slice(1) })).toThrow(/cube/);
  expect(() => cubeSplatFaces({ ...shape, vertices: shape.vertices.map((v, i) => i ? v : { ...v, position: [0, 0, 0] }) })).toThrow(/cube/);
  expect(() => cubeToSplatBytes(shape, { ...defaultCubeSplatSettings, overlap: NaN })).toThrow(/settings/);
});
it("persists the generated splat asset through project save and reopen", async () => {
  const { store, shape } = fixture(), bytes = cubeToSplatBytes(shape, defaultCubeSplatSettings);
  const asset = { id: "converted", kind: "file" as const, fileName: "cube.splat", byteLength: bytes.length };
  const { document } = addSplat(store.getState().document, asset, "cube_splats", [0, 0, 0]);
  const archive = await encodeProjectBlob(document, new Map([[asset.id, new Blob([bytes])]]), { camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45, near: .01, far: 1000 }, time: 0 });
  const reopened = await decodeProjectBlob(archive);
  expect(reopened.scene).toEqual(document);
  expect(new Uint8Array(await reopened.files.get(asset.id)!.arrayBuffer())).toEqual(bytes);
});
