import { expect, it } from "vitest";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { transformSpace } from "../src/transform-space.ts";
import { globalObjectTransform, objectLocalMatrix, relocateObjectPivot } from "../src/object-pivot.ts";
import { addSplat, emptyScene, normalizedChannels, type TransformNode, type Vec3 } from "../src/scene-document.ts";
import { createConstraint } from "../src/constraints.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { encodeProject, decodeProject, validateScene } from "../src/project-archive.ts";

const original: TransformNode = { id: "object", type: "transform", name: "object", parentId: null, position: [2,3,4], rotation: [35,60,15], scale: [2,1,.5], rotationOrder: "XYZ" };
const points = [[0,0,0], [1,0,0], [0,1,0], [0,0,1], [2,-3,4]] as Vec3[];
function near(a: Vector3, b: Vector3) { expect(a.distanceTo(b)).toBeLessThan(1e-8); }

it("keeps rotate and scale controls on global axes", () => {
  for (const mode of ["rotate", "scale", "translate"]) expect(transformSpace(mode)).toBe("world");
});

it("offers object axes for all object tools and leaves components in world space", () => {
  for (const mode of ["rotate", "scale", "translate"]) {
    expect(transformSpace(mode, false, "object")).toBe("local");
    expect(transformSpace(mode, true, "object")).toBe("world");
  }
});

it("switches gizmo orientation without moving geometry, then scales the rotated object's own X axis", () => {
  const node = relocateObjectPivot(original, original, [1,-2,3]), before = objectLocalMatrix(node,node);
  const basis = new Quaternion().setFromEuler(new Euler(...node.rotation.map(v => v * Math.PI / 180) as Vec3));
  const anchor = new Vector3(...node.pivot!).applyMatrix4(before);
  const unchanged = globalObjectTransform(node,node,before,new Matrix4(),{position:anchor,quaternion:basis,scale:new Vector3(1,1,1)},"scale",basis);
  const stationary = objectLocalMatrix(unchanged.node,unchanged.channels);
  for(const p of points) near(new Vector3(...p).applyMatrix4(stationary),new Vector3(...p).applyMatrix4(before));
  const result = globalObjectTransform(node,node,before,new Matrix4(),{position:anchor,quaternion:basis,scale:new Vector3(2,1,1)},"scale",basis);
  expect(result.node.affine).toBeUndefined(); expect(result.channels.rotation).toEqual(node.rotation);
  const actual = objectLocalMatrix(result.node,result.channels), expected = objectLocalMatrix(node,{...node,scale:[4,1,.5]});
  for(const p of points) near(new Vector3(...p).applyMatrix4(actual),new Vector3(...p).applyMatrix4(expected));
  near(new Vector3(...node.pivot!).applyMatrix4(actual),anchor);
});

it("rotates about the object's own Y axis using the initial gizmo basis", () => {
  const node=relocateObjectPivot(original,original,[1,2,3]), before=objectLocalMatrix(node,node);
  const basis=new Quaternion().setFromEuler(new Euler(...node.rotation.map(v=>v*Math.PI/180) as Vec3));
  const anchor=new Vector3(...node.pivot!).applyMatrix4(before), localRotation=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),.4);
  const nextBasis=basis.clone().multiply(localRotation);
  const result=globalObjectTransform(node,node,before,new Matrix4(),{position:anchor,quaternion:nextBasis,scale:new Vector3(1,1,1)},"rotate",basis);
  const after=objectLocalMatrix(result.node,result.channels), worldRotation=basis.clone().multiply(localRotation).multiply(basis.clone().invert());
  for(const p of points) near(new Vector3(...p).applyMatrix4(after),new Vector3(...p).applyMatrix4(before).sub(anchor).applyQuaternion(worldRotation).add(anchor));
});

it("scales actual world X around a moved pivot under a rotated nonuniform parent, preserving rotation", () => {
  const node = relocateObjectPivot(original, original, [1,-2,3]);
  const parent = new Matrix4().compose(new Vector3(8,3,-1), new Quaternion().setFromEuler(new Euler(.3,.8,.2)), new Vector3(2,3,1));
  const before = parent.clone().multiply(objectLocalMatrix(node,node)), anchor = new Vector3(...node.pivot!).applyMatrix4(before);
  const result = globalObjectTransform(node,node,before,parent,{position:anchor,quaternion:new Quaternion(),scale:new Vector3(2,1,1)},"scale");
  const after = parent.clone().multiply(objectLocalMatrix(result.node,result.channels));
  expect(result.channels.rotation).toEqual(node.rotation); expect(result.node.affine).toBeDefined();
  for (const p of points) {
    const expected = new Vector3(...p).applyMatrix4(before); expected.x = anchor.x + 2 * (expected.x - anchor.x);
    near(new Vector3(...p).applyMatrix4(after),expected);
  }
  near(new Vector3(...node.pivot!).applyMatrix4(after),anchor);
  const moved = relocateObjectPivot(result.node,result.channels,[4,2,1]);
  const preserved = objectLocalMatrix(moved,result.channels); objectLocalMatrix(result.node,result.channels).elements.forEach((v,i)=>expect(preserved.elements[i]).toBeCloseTo(v,9));
});

it("rotates world Y after global scaling and exactly preserves the pivot", () => {
  const node = relocateObjectPivot(original,original,[1,2,-1]), parent = new Matrix4();
  const first = parent.clone().multiply(objectLocalMatrix(node,node)), anchor = new Vector3(...node.pivot!).applyMatrix4(first);
  const scaled = globalObjectTransform(node,node,first,parent,{position:anchor,quaternion:new Quaternion(),scale:new Vector3(2,1,.6)},"scale");
  const before = objectLocalMatrix(scaled.node,scaled.channels), delta = new Quaternion().setFromAxisAngle(new Vector3(0,1,0),Math.PI/2);
  const rotated = globalObjectTransform(scaled.node,scaled.channels,before,parent,{position:anchor,quaternion:delta,scale:new Vector3(1,1,1)},"rotate");
  const after = objectLocalMatrix(rotated.node,rotated.channels);
  for(const p of points) near(new Vector3(...p).applyMatrix4(after),new Vector3(...p).applyMatrix4(before).sub(anchor).applyQuaternion(delta).add(anchor));
});

it("keeps preview and authored matrices equal near the minimum channel scale", () => {
  const node = {...original,scale:[.001,1,1] as Vec3}; const before = objectLocalMatrix(node,node), anchor = new Vector3().applyMatrix4(before);
  const result = globalObjectTransform(node,node,before,new Matrix4(),{position:anchor,quaternion:new Quaternion(),scale:new Vector3(.5,1,1)},"scale");
  expect(result.channels.scale[0]).toBe(.001);
  const preview = objectLocalMatrix(result.node,result.channels), committed = objectLocalMatrix(result.node,normalizedChannels(result.channels));
  for (const p of points) {
    const expected = new Vector3(...p).applyMatrix4(before); expected.x = anchor.x + .5 * (expected.x - anchor.x);
    near(new Vector3(...p).applyMatrix4(preview),expected);
    near(new Vector3(...p).applyMatrix4(committed),expected);
  }
});

it("round trips exact global-scale affine data and rejects singular or malformed matrices", async () => {
  const added = addSplat(emptyScene(),{id:"demo",kind:"procedural",generator:"knot-v1"},"Object",[0,0,0]);
  const node = {...original,id:added.id,name:"Object"};
  const before = objectLocalMatrix(node,node), anchor = new Vector3().applyMatrix4(before);
  const result = globalObjectTransform(node,node,before,new Matrix4(),{position:anchor,quaternion:new Quaternion(),scale:new Vector3(2,1,1)},"scale");
  added.document.nodes[node.id]={...result.node,...result.channels};
  const bytes=await encodeProject(added.document,new Map(),{camera:{position:[0,0,10],target:[0,0,0],fov:45,near:.01,far:1000},time:0});
  const opened=await decodeProject(bytes); expect(opened.scene).toEqual(added.document);
  const invalid=structuredClone(added.document);(invalid.nodes[node.id] as TransformNode).affine=Array(9).fill(0);
  expect(()=>validateScene(invalid)).toThrow(/nonsingular/);
});

it("allows point constraints but explicitly rejects unsupported orient constraints on affine targets", () => {
  const a = addSplat(emptyScene(),{id:"a",kind:"procedural",generator:"knot-v1"},"Source",[0,0,0]);
  const b = addSplat(a.document,{id:"b",kind:"procedural",generator:"knot-v1"},"Target",[0,0,0]);
  const store = createSceneStore(b.document); createConstraint(store,"point",a.id,b.id,false);
  const doc = structuredClone(store.getState().document); (doc.nodes[b.id] as TransformNode).affine = [1,0,0,.5,1,0,0,0,1];
  expect(()=>validateScene(doc)).not.toThrow();
  doc.constraints![0].type = "orient"; expect(()=>validateScene(doc)).toThrow(/affine world scaling/);
});
