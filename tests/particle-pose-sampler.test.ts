import { describe, expect, it } from "vitest";
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import { defaultAnimation, evaluateSceneAnimation, type AnimationChannel, type AnimationTrack } from "../src/animation.ts";
import { constraintWorldMatrices, createConstraint, evaluateConstraints } from "../src/constraints.ts";
import { evaluateDrivenKeys, setDrivenKey } from "../src/driven-keys.ts";
import { createIKHandle, evaluateIK } from "../src/ik.ts";
import { createParticlePoseSampler } from "../src/particle-pose-sampler.ts";
import { emptyScene, type SceneDocument, type TransformNode } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";

function fixture(): SceneDocument {
  const doc = emptyScene();
  for (const id of ["parent", "emitter", "driver", "control"]) {
    doc.nodes[id] = { id, type: "transform", name: id, parentId: id === "emitter" ? "parent" : null,
      position: id === "emitter" ? [1, 0, 0] : [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
    if (id !== "emitter") doc.rootIds.push(id);
  }
  return doc;
}
function track(targetId: string, channel: AnimationChannel, a: number, b: number, end = 10): AnimationTrack {
  const id = `${targetId}-${channel.replace(".", "-")}`;
  return { id, targetId, channel, keys: [
    { id: `${id}-a`, time: 0, value: a, interpolation: "linear", tangentMode: "auto" },
    { id: `${id}-b`, time: end, value: b, interpolation: "linear", tangentMode: "auto" },
  ] };
}
const position = (world: ReadonlyMap<string, Matrix4>, id = "emitter") => new Vector3().setFromMatrixPosition(world.get(id)!);
function fresh(doc: SceneDocument, frame: number) {
  const poses = evaluateSceneAnimation(doc, frame); evaluateDrivenKeys(doc, poses); evaluateIK(doc, poses); evaluateConstraints(doc, poses); return constraintWorldMatrices(doc, poses);
}
function freeze(value: unknown) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child); Object.freeze(value);
}

describe("historical particle emitter poses", () => {
  it("samples animated emitter and parent world transforms at fractional birth frames", () => {
    const doc = fixture(); doc.animation = { ...defaultAnimation(), tracks: [track("parent", "position.x", 0, 10), track("parent", "rotation.z", 0, 90), track("emitter", "rotation.z", 0, 30)] };
    const sampler = createParticlePoseSampler(doc);
    for (const frame of [10, 2.5, 0, 7.125, 5]) {
      const world = sampler.worldAt(frame), angle = MathUtils.degToRad(frame * 9);
      expect(position(world).distanceTo(new Vector3(frame + Math.cos(angle), Math.sin(angle), 0))).toBeLessThan(1e-10);
      const actual = new Quaternion().setFromRotationMatrix(world.get("emitter")!);
      const expected = new Quaternion().setFromEuler(new Euler(0, 0, MathUtils.degToRad(frame * 12)));
      expect(actual.angleTo(expected)).toBeLessThan(1e-7);
    }
  });
  it("does not quantize close fractional frames or apply playback-range clamping", () => {
    const doc = fixture(); doc.animation = { ...defaultAnimation(), tracks: [track("parent", "position.x", 0, 100, 1)] };
    const sampler = createParticlePoseSampler(doc), a = sampler.worldAt(0.5), b = sampler.worldAt(0.50000001);
    expect(a).not.toBe(b); expect(position(b).x - position(a).x).toBeCloseTo(0.000001, 11);
    expect(position(sampler.worldAt(-10)).x).toBe(1); expect(position(sampler.worldAt(1000)).x).toBe(101);
  });
  it("evaluates animated SDK inputs before historical parent constraints", () => {
    const doc = fixture(); doc.animation = { ...defaultAnimation(), tracks: [track("driver", "position.x", 0, 1), track("parent", "rotation.z", 0, 90)] };
    const store = createSceneStore(doc);
    for (const [channel, end] of [["position.x", 4], ["rotation.z", 90]] as const) {
      setDrivenKey(store, { targetId: "driver", channel: "position.x" }, { targetId: "control", channel }, 0, 0);
      setDrivenKey(store, { targetId: "driver", channel: "position.x" }, { targetId: "control", channel }, 1, end);
    }
    createConstraint(store, "parent", "control", "emitter", false);
    const sampler = createParticlePoseSampler(store.getState().document);
    expect(position(sampler.worldAt(2.5)).x).toBeCloseTo(1, 10); expect(position(sampler.worldAt(7.5)).x).toBeCloseTo(3, 10);
    const orientation = new Quaternion().setFromRotationMatrix(sampler.worldAt(5).get("emitter")!);
    expect(orientation.angleTo(new Quaternion().setFromEuler(new Euler(0, 0, Math.PI / 4)))).toBeLessThan(1e-7);
  });
  it("evaluates IK before constraints that attach emitters to solved joints", () => {
    const doc = fixture(); doc.joints = [
      { id: "root", name: "Root", parentId: null, position: [0, 0, 0] },
      { id: "middle", name: "Middle", parentId: "root", position: [0, 1, 0] },
      { id: "end", name: "End", parentId: "middle", position: [0, 1, 0] },
    ];
    const store = createSceneStore(doc); createIKHandle(store, "root", "end", [1, 1, 0], { solver: "two-bone", poleTarget: [0, 0, 2] });
    createConstraint(store, "point", "end", "emitter", false);
    const world = createParticlePoseSampler(store.getState().document).worldAt(4.5);
    expect(position(world).distanceTo(new Vector3(1, 1, 0))).toBeLessThan(1e-8);
    expect(position(world, "end").distanceTo(position(world))).toBeLessThan(1e-10);
  });
  it("keeps independent document snapshots and never mutates authored scene data", () => {
    const first = fixture(); first.animation = { ...defaultAnimation(), tracks: [track("parent", "position.x", 0, 10)] };
    const second: SceneDocument = { ...first, nodes: { ...first.nodes, emitter: { ...first.nodes.emitter as TransformNode, position: [4, 0, 0] } } };
    const beforeFirst = JSON.stringify(first), beforeSecond = JSON.stringify(second); freeze(first); freeze(second);
    const a = createParticlePoseSampler(first), b = createParticlePoseSampler(second);
    expect(position(a.worldAt(5)).x).toBe(6); expect(position(b.worldAt(5)).x).toBe(9); expect(position(a.worldAt(5)).x).toBe(6);
    expect(JSON.stringify(first)).toBe(beforeFirst); expect(JSON.stringify(second)).toBe(beforeSecond);
  });
  it("matches fresh evaluations regardless of sampling order and returns cached matrices on repeat", () => {
    const doc = fixture(); doc.animation = { ...defaultAnimation(), tracks: [track("parent", "position.x", 0, 10), track("parent", "rotation.z", 0, 360)] };
    const sampler = createParticlePoseSampler(doc);
    for (const frame of [8, 1.125, 10, 3, 8, -2, 1.125]) {
      const result = sampler.worldAt(frame), expected = fresh(doc, frame);
      for (const [id, matrix] of expected) expect(result.get(id)!.elements).toEqual(matrix.elements);
      expect(sampler.worldAt(frame)).toBe(result);
    }
  });
  it("bounds its cache to 256 frames and refreshes recently requested entries", () => {
    const sampler = createParticlePoseSampler(fixture()), zero = sampler.worldAt(0), one = sampler.worldAt(1);
    for (let frame = 2; frame < 256; frame++) sampler.worldAt(frame);
    expect(sampler.worldAt(0)).toBe(zero); sampler.worldAt(256);
    expect(sampler.worldAt(0)).toBe(zero); expect(sampler.worldAt(1)).not.toBe(one);
  });
  it("propagates historical constraint errors without evicting a valid cached pose", () => {
    const doc = fixture(), store = createSceneStore(doc); createConstraint(store, "orient", "control", "emitter", false);
    const constrained = store.getState().document;
    const animated = { ...constrained, animation: { ...defaultAnimation(), tracks: [track("parent", "scale.x", 1, 2, 1)] } };
    const sampler = createParticlePoseSampler(animated), good = sampler.worldAt(0);
    expect(() => sampler.worldAt(1)).toThrow(/Unsupported pose/); expect(() => sampler.worldAt(1)).toThrow(/Unsupported pose/);
    expect(sampler.worldAt(0)).toBe(good);
    for (const frame of [NaN, Infinity, -Infinity]) expect(() => sampler.worldAt(frame)).toThrow(/finite/);
  });
});
