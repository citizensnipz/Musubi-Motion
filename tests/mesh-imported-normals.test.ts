import { expect, it } from "vitest";
import { BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { convertFBX } from "../src/fbx-import.ts";
import { emptyScene, type MeshShapeNode, type Vec3 } from "../src/scene-document.ts";
import { createMeshRenderable } from "../src/mesh-renderer.ts";

it("preserves imported normals, keeps UV seam duplicates smooth after morphing, and retains hard boundaries", () => {
  const group = new Group(), geometry = new BufferGeometry(), smooth = new Vector3(0, 1, 1).normalize();
  geometry.setAttribute("position", new Float32BufferAttribute([
    0,0,0, 1,0,0, 0,1,0,
    0,0,0, 0,0,1, 1,0,0,
    0,0,0, -1,0,0, 0,0,-1,
  ], 3));
  geometry.setAttribute("normal", new Float32BufferAttribute([
    ...smooth.toArray(), 0,0,1, 0,0,1,
    ...smooth.toArray(), 0,1,0, 0,1,0,
    1,0,0, 1,0,0, 1,0,0,
  ], 3));
  geometry.setAttribute("uv", new Float32BufferAttribute([0,0, 1,0, 0,1, 1,1, 0,1, 1,0, .5,.5, 0,0, 1,1], 2));
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [new Float32BufferAttribute(new Float32Array(27), 3)];
  group.add(new Mesh(geometry, new MeshStandardMaterial()));
  const result = convertFBX(group, emptyScene(), "Test"), shape = Object.values(result.document.nodes).find(n => n.type === "meshShape") as MeshShapeNode;
  const origin = shape.vertices.filter(v => v.position.every(n => n === 0));
  expect(origin).toHaveLength(3);
  expect(shape.normals![origin[0].id][1]).toBeCloseTo(smooth.y);
  const renderer = createMeshRenderable(shape), initial = renderer.mesh.geometry.getAttribute("normal");
  const firstIndex = shape.vertices.findIndex(v => v.id === origin[0].id), seamIndex = shape.vertices.findIndex(v => v.id === origin[1].id), hardIndex = shape.vertices.findIndex(v => v.id === origin[2].id);
  expect(initial.getY(firstIndex)).toBeCloseTo(smooth.y);
  expect(initial.getX(hardIndex)).toBeCloseTo(1);
  renderer.applySkin(() => undefined, [1]);
  const normal = renderer.mesh.geometry.getAttribute("normal"), a = new Vector3().fromBufferAttribute(normal, firstIndex), b = new Vector3().fromBufferAttribute(normal, seamIndex);
  expect(a.distanceTo(b)).toBeLessThan(1e-6);
  expect(a.distanceTo(new Vector3().fromBufferAttribute(normal, hardIndex))).toBeGreaterThan(.1);
  const changed = { ...shape, normals: Object.fromEntries(shape.vertices.map(v => [v.id, [0, 0, 1] as Vec3])) };
  renderer.update(changed); expect(renderer.mesh.geometry.getAttribute("normal").getZ(firstIndex)).toBe(1);
  renderer.dispose();
});
