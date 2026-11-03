import { describe, expect, it } from "vitest";
import { AnimationClip, AnimationMixer, NumberKeyframeTrack, Texture, Bone, BufferGeometry, Float32BufferAttribute, Group, LoopOnce, Mesh, MeshStandardMaterial, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3, VectorKeyframeTrack } from "three";
import { convertFBX, importFBX, hasCompletePNG } from "../src/fbx-import.ts";
import { addSplat, deleteSceneItems, emptyScene, type MeshShapeNode } from "../src/scene-document.ts";
import { evaluateSceneAnimation } from "../src/animation.ts";
import { jointWorldMatrices } from "../src/ik.ts";
import { deformMeshPositions } from "../src/mesh-skin.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { createMeshRenderable } from "../src/mesh-renderer.ts";
import { extrudeMeshFaces } from "../src/mesh-modeling.ts";

function triangle() {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  return geometry;
}
function character() {
  const group = new Group(); group.position.x = 3; group.scale.setScalar(2);
  const root = new Bone(), child = new Bone(); root.name = "L_root"; child.name = "L_tip"; child.position.y = 1; root.add(child); group.add(root);
  const geometry = triangle();
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ color: "#cc8844" })); mesh.name = "Body"; group.add(mesh);
  group.updateMatrixWorld(true); mesh.bind(new Skeleton([root, child]));
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  group.animations = [new AnimationClip("Walk", 1, [new VectorKeyframeTrack("L_root.position", [0, 1], [0, 0, 0, 1, 0, 0]),
    new QuaternionKeyframeTrack("L_tip.quaternion", [0, 1], [0, 0, 0, 1, ...q.toArray()])])];
  return { group, mesh, root, child };
}
function shapeOf(doc: ReturnType<typeof emptyScene>) { return Object.values(doc.nodes).find(n => n.type === "meshShape") as MeshShapeNode; }

describe("FBX scene import", () => {
  it("adds an FBX to a scene containing a PLY larger than the former archive limit without allocating the PLY", async () => {
    const asset = { id: "large-ply", kind: "file" as const, fileName: "large.ply", byteLength: 512 * 1024 * 1024 + 1 };
    const existing = addSplat(emptyScene(), asset, "Capture", [0, 0, 0]);
    const result = convertFBX(character().group, existing.document, "Character");
    expect(result.document.assets[asset.id]).toBe(asset);
    expect(result.document.nodes[existing.id]).toBe(existing.document.nodes[existing.id]);
    expect(result.document.rootIds).toContain(existing.id);
    expect(result.objectIds).toHaveLength(1);
    expect(() => validateScene(result.document)).not.toThrow();
    const store = createSceneStore(existing.document);
    store.setState({ document: result.document, editLabel: "Import FBX" });
    store.temporal.getState().undo(); expect(store.getState().document).toBe(existing.document);
    store.temporal.getState().redo(); expect(store.getState().document).toBe(result.document);
    const invalid = structuredClone(result.document);
    (invalid.assets[asset.id] as typeof asset).byteLength = NaN;
    expect(() => validateScene(invalid)).toThrow(/large.ply/);
  });
  it("detects truncated embedded PNGs before browsers render partially decoded transparent images", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    expect(hasCompletePNG(png)).toBe(true);
    expect(hasCompletePNG(png.slice(0, -20))).toBe(false);
    expect(hasCompletePNG("data:image/png;base64,invalid")).toBe(false);
  });
  it("uses opacity-map pixels when FBX exports a zero scalar but preserves intentional scalar transparency", () => {
    const source = new Group(), mapped = new MeshStandardMaterial({ opacity: 0, transparent: true }), hidden = mapped.clone();
    mapped.alphaMap = new Texture();
    mapped.alphaMap.userData.musubiDataURI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const visible = new Mesh(triangle(), mapped); visible.geometry.setAttribute("uv", new Float32BufferAttribute([0,0,1,0,0,1],2));
    source.add(visible, new Mesh(triangle(), hidden));
    const result = convertFBX(source, emptyScene(), "Opacity");
    const shapes = Object.values(result.document.nodes).filter(n => n.type === "meshShape");
    expect(shapes[0].materials![0].opacity).toBe(1); expect(shapes[0].materials![0].alphaMap).toBeDefined();
    expect(shapes[1].materials![0].opacity).toBe(0);
    expect(mapped.opacity).toBe(0); expect(result.warnings.join(" ")).toContain("zero opacity scalar");
    delete mapped.alphaMap!.userData.musubiDataURI;
    const missing = convertFBX(source, emptyScene(), "MissingOpacityImage");
    const fallback = Object.values(missing.document.nodes).find(n => n.type === "meshShape")! as MeshShapeNode;
    expect(fallback.materials![0].opacity).toBe(1); expect(fallback.materials![0].alphaMap).toBeUndefined();
    expect(missing.warnings.join(" ")).toContain("normalized exporter");
  });

  it("round trips textured material slots, UVs, and skinned animated blend shapes", async () => {
    const { group, mesh } = character();
    const texture = new Texture(); texture.userData.musubiDataURI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    mesh.material.map = texture;
    mesh.geometry.setAttribute("uv", new Float32BufferAttribute([0,0,1,0,0,1], 2));
    mesh.geometry.morphAttributes.position = [new Float32BufferAttribute([0,0,0,0,0,0,1,0,0],3)];
    mesh.geometry.morphAttributes.position[0].name = "Smile"; mesh.geometry.morphTargetsRelative = true; mesh.updateMorphTargets();
    group.animations[0].tracks.push(new NumberKeyframeTrack("Body.morphTargetInfluences[Smile]", [0,1], [0,1]));
    const result = convertFBX(group, emptyScene(), "Morph"), shape = shapeOf(result.document);
    expect(shape.materials![0].map!.dataURI).toBe(texture.userData.musubiDataURI);
    expect(shape.uvs!.v2).toEqual([0,1]);
    expect(result.document.animation!.tracks.some(t => t.channel === "morph.0")).toBe(true);
    const mixer = new AnimationMixer(group), action = mixer.clipAction(group.animations[0]); action.setLoop(LoopOnce,1); action.clampWhenFinished = true; action.play();
    for (const frame of [0,6,12,24]) {
      mixer.setTime(frame/24); group.updateMatrixWorld(true);
      const poses = evaluateSceneAnimation(result.document, frame), worlds = jointWorldMatrices(result.document, poses);
      const actual = deformMeshPositions(shape, key => worlds.get(key), undefined, poses.get(shape.parentId)!.morphWeights);
      const expected = mesh.getVertexPosition(2,new Vector3()).applyMatrix4(mesh.matrixWorld);
      expect(actual[6]).toBeCloseTo(expected.x,4); expect(actual[7]).toBeCloseTo(expected.y,4);
    }
    mixer.stopAllAction(); mixer.uncacheRoot(group);
    const bytes = await encodeProject(result.document,new Map(),{camera:{position:[0,0,10],target:[0,0,0],fov:45,near:.01,far:1000},time:0});
    expect((await decodeProject(bytes)).scene).toEqual(result.document);
    const bad = structuredClone(result.document); shapeOf(bad).morphTargets![0].deltas.v0[0] = Infinity;
    expect(()=>validateScene(bad)).toThrow(/blend shapes/);
  });
  it("preserves vertices separated only by a morph delta or UV seam and converts absolute targets", () => {
    const source = new Group(), geometry = new BufferGeometry();
    geometry.setAttribute("position",new Float32BufferAttribute([0,0,0,1,0,0,0,1,0,0,0,0,-1,0,0,0,-1,0],3));
    geometry.setAttribute("uv",new Float32BufferAttribute([0,0,1,0,0,1,1,1,0,0,1,0],2));
    geometry.morphAttributes.position = [new Float32BufferAttribute([0,0,0,1,0,0,0,1,1,0,0,2,-1,0,0,0,-1,0],3)];
    const mesh = new Mesh(geometry,new MeshStandardMaterial()); source.add(mesh);
    const shape = shapeOf(convertFBX(source,emptyScene(),"Absolute").document);
    expect(shape.vertices.length).toBe(6); expect(shape.morphTargets![0].deltas.v3).toEqual([0,0,2]);
    const renderer = createMeshRenderable(shape); renderer.applySkin(()=>undefined,[1]);
    expect(renderer.mesh.geometry.getAttribute("position").getZ(3)).toBe(2); renderer.dispose();
  });

  it("parses an authored ASCII FBX through the actual file importer", async () => {
    const ascii = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}
Objects:  {
\tGeometry: 1, "Geometry::Triangle", "Mesh" {
\t\tVertices: *9 {
\t\t\ta: 0,0,0,1,0,0,0,1,0
\t\t}
\t\tPolygonVertexIndex: *3 {
\t\t\ta: 0,1,-3
\t\t}
\t}
\tModel: 2, "Model::Triangle", "Mesh" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0
\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
\t\t}
\t}
}
Connections:  {
\tC: "OO",1,2
\tC: "OO",2,0
}
`;
    const result = await importFBX(new File([ascii], "triangle.fbx"), emptyScene());
    expect(result.objectIds).toHaveLength(1); expect(shapeOf(result.document).faces).toHaveLength(1);
    expect(shapeOf(result.document).vertices.map(v => v.position)).toEqual([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
  });
  it("separates disconnected fans that share a position without discarding faces", () => {
    const group = new Group(), geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 0,0,0, -1,0,0, 0,-1,0], 3));
    group.add(new Mesh(geometry, new MeshStandardMaterial()));
    const result = convertFBX(group, emptyScene(), "Fans"), shape = shapeOf(result.document);
    expect(shape.faces).toHaveLength(2); expect(shape.vertices).toHaveLength(6);
    expect(result.warnings.join(" ")).toContain("separated"); expect(() => validateScene(result.document)).not.toThrow();
  });
  it("preserves skinned vertex motion and editable joint animation under a scaled parent", () => {
    const { group, mesh } = character(), result = convertFBX(group, emptyScene(), "Character");
    expect(result.jointIds).toHaveLength(2); expect(result.clips).toEqual([{ name: "Walk", start: 0, end: 24 }]);
    const shape = shapeOf(result.document), mixer = new AnimationMixer(group);
    const action = mixer.clipAction(group.animations[0]); action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
    for (const frame of [0, 6, 12, 24]) {
      mixer.setTime(frame / 24); group.updateMatrixWorld(true);
      const worlds = jointWorldMatrices(result.document, evaluateSceneAnimation(result.document, frame));
      const actual = deformMeshPositions(shape, id => worlds.get(id));
      for (let i = 0; i < 3; i++) {
        const expected = mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld);
        expect(actual[i * 3]).toBeCloseTo(expected.x, 5); expect(actual[i * 3 + 1]).toBeCloseTo(expected.y, 5); expect(actual[i * 3 + 2]).toBeCloseTo(expected.z, 5);
      }
    }
    mixer.stopAllAction(); mixer.uncacheRoot(group);
  });
  it("round trips skeleton, weights, and animation through MSB and undo/redo", async () => {
    const doc = convertFBX(character().group, emptyScene(), "Character").document;
    const store = createSceneStore(emptyScene()); store.setState({ document: doc, editLabel: "Import FBX" });
    store.temporal.getState().undo(); expect(store.getState().document.nodes).toEqual({});
    store.temporal.getState().redo(); expect(store.getState().document).toEqual(doc);
    const bytes = await encodeProject(doc, new Map(), { camera: { position: [0, 0, 10], target: [0, 0, 0], fov: 45, near: .01, far: 1000 }, time: .5 });
    const loaded = await decodeProject(bytes); expect(loaded.scene).toEqual(doc);
    const shape = shapeOf(loaded.scene), worlds = jointWorldMatrices(loaded.scene, evaluateSceneAnimation(loaded.scene, 12));
    const renderer = createMeshRenderable(shape); renderer.applySkin(id => worlds.get(id));
    expect(Array.from(renderer.mesh.geometry.getAttribute("position").array)).toEqual(Array.from(deformMeshPositions(shape, id => worlds.get(id))));
    const unbound = deleteSceneItems(loaded.scene, [loaded.scene.joints![0].id]);
    expect(shapeOf(unbound).skin).toBeUndefined(); expect(() => validateScene(unbound)).not.toThrow();
    renderer.update(shapeOf(unbound)); expect(Array.from(renderer.mesh.geometry.getAttribute("position").array)).toEqual(shape.vertices.flatMap(v => v.position));
    renderer.dispose();
  });
  it("imports rigid mesh hierarchy motion and appends multiple clips after existing animation", () => {
    const group = new Group(), mesh = new Mesh(triangle(), new MeshStandardMaterial()); mesh.name = "Triangle"; group.name = "Parent"; group.add(mesh);
    group.animations = [new AnimationClip("First", 1, [new VectorKeyframeTrack("Parent.position", [0, 1], [0, 0, 0, 2, 0, 0])]),
      new AnimationClip("Second", 1, [new VectorKeyframeTrack("Parent.position", [0, 1], [10, 0, 0, 12, 0, 0])])];
    const existing = convertFBX(character().group, emptyScene(), "Existing").document;
    const result = convertFBX(group, existing, "Triangle");
    expect(result.clips[0].start).toBe(existing.animation!.end + 1);
    expect(evaluateSceneAnimation(result.document, result.clips[0].start + 12).get(result.objectIds[0])!.position[0]).toBeCloseTo(1);
    expect(evaluateSceneAnimation(result.document, result.clips[1].start).get(result.objectIds[0])!.position[0]).toBeCloseTo(10);
    expect(existing.rootIds).toHaveLength(1);
  });
  it("rejects unsupported animated bone scale without changing the destination", () => {
    const { group } = character(); group.animations[0].tracks.push(new VectorKeyframeTrack("L_tip.scale", [0, 1], [1, 1, 1, 2, 2, 2]));
    const doc = emptyScene(), before = JSON.stringify(doc);
    expect(() => convertFBX(group, doc, "Character")).toThrow(/animated joint scaling/); expect(JSON.stringify(doc)).toBe(before);
  });
  it("validates bindings and prevents topology edits from invalidating imported weights", () => {
    const doc = convertFBX(character().group, emptyScene(), "Character").document, shape = shapeOf(doc);
    const broken = structuredClone(doc); shapeOf(broken).skin!.jointIds[0] = "missing";
    expect(() => validateScene(broken)).toThrow(/binding/);
    const store = createSceneStore(doc);
    expect(() => extrudeMeshFaces(store, shape.id, [shape.faces[0].id], .5)).toThrow(/skinned meshes/);
    expect(store.getState().document).toBe(doc);
  });
  it("rejects oversized and malformed FBX files", async () => {
    await expect(importFBX({ size: 129 * 1024 * 1024 } as File, emptyScene())).rejects.toThrow(/128 MiB/);
    await expect(importFBX(new File(["not fbx"], "bad.fbx"), emptyScene())).rejects.toThrow();
  });
  it("supports skeleton-only animation and repeated imports with fresh IDs", () => {
    const { group, mesh } = character(); group.remove(mesh);
    const first = convertFBX(group, emptyScene(), "Rig"), second = convertFBX(group, first.document, "Rig");
    expect(first.objectIds).toEqual([]); expect(second.document.joints).toHaveLength(4);
    expect(new Set(second.document.joints!.map(j => j.name)).size).toBe(4);
    expect(() => validateScene(second.document)).not.toThrow();
  });
});
