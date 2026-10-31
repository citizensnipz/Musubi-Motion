import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferGeometry, Euler, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { defaultAnimation } from "../src/animation.ts";
import { defaultParticleSettings, type ParticleShapeNode } from "../src/particle-emitter.ts";
import { createParticleSimulation, type ParticleFrame, type ParticlePoseSampler, type ParticleSimulation } from "../src/particle-simulation.ts";
import { emptyScene, type MeshShapeNode, type SceneDocument, type TransformNode } from "../src/scene-document.ts";

const active: ParticleSimulation[] = [];
afterEach(() => { active.splice(0).forEach(simulation => simulation.dispose()); vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(patch: Partial<ParticleShapeNode> = {}) {
  const doc = emptyScene();
  doc.animation = defaultAnimation();
  const transform: TransformNode = { id: "emitter", type: "transform", name: "Emitter", parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: "XYZ" };
  const shape: ParticleShapeNode = { ...defaultParticleSettings(), id: "particles", type: "particleShape", name: "Particles", parentId: transform.id,
    rate: 120, lifetime: 10, startFrame: 0, endFrame: 120, speed: 0, speedRandom: 0, acceleration: [0, 0, 0], drag: 0, sizes: [1, 1], opacities: [1, 1], ...patch };
  doc.nodes[transform.id] = transform; doc.nodes[shape.id] = shape; doc.rootIds.push(transform.id);
  return { doc, shape, transform };
}
function simulation(doc: SceneDocument, shape: ParticleShapeNode, sampler?: ParticlePoseSampler) {
  const result = createParticleSimulation(doc, shape, sampler); active.push(result); return result;
}
function fakePoses(matrixAt: (frame: number) => Matrix4): ParticlePoseSampler {
  return { worldAt: vi.fn(frame => new Map([["emitter", matrixAt(frame)]])) };
}
function points(frame: ParticleFrame): Vector3[] {
  return Array.from({ length: frame.count }, (_, index) => new Vector3().fromArray(frame.positions, index * 3));
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze); Object.freeze(value);
}
function surfaceFixture(patch: Partial<ParticleShapeNode> = {}) {
  const result = fixture({ emission: "surface", surfaceId: "surface", rate: 1200, spread: 0, ...patch });
  const parent: TransformNode = { ...result.transform, id: "source", name: "Source" };
  result.transform.parentId = parent.id; result.doc.nodes[parent.id] = parent; result.doc.rootIds = [parent.id];
  const mesh: MeshShapeNode = { id: "surface", type: "meshShape", name: "Surface", parentId: parent.id, color: "#888888", shading: "flat", wireframe: false,
    vertices: [
      { id: "a", position: [0, 0, 0] }, { id: "b", position: [1, 0, 0] }, { id: "c", position: [0, 1, 0] },
      { id: "d", position: [10, 0, 0] }, { id: "e", position: [10, 1, 0] }, { id: "f", position: [10, 0, 1] },
    ], faces: [{ id: "xy", vertices: ["a", "b", "c"] }, { id: "yz", vertices: ["d", "e", "f"] }] };
  result.doc.nodes[mesh.id] = mesh;
  return { ...result, mesh, parent };
}

describe("seeded Nebula particle timeline", () => {
  it("reproduces forward, backward and out-of-order seeks byte for byte without changing the document", async () => {
    const { doc, shape } = fixture({ speed: 2, speedRandom: 3, acceleration: [0, -2, 0], drag: .3, lifetime: 2, turbulence: { strength: .4, scale: 1 } });
    freeze(doc);
    const subject = simulation(doc, shape), before = JSON.stringify(doc);
    const expected = await simulation(doc, shape).snapshotAt(36);
    await subject.snapshotAt(12); expect(await subject.snapshotAt(36)).toEqual(expected);
    await subject.snapshotAt(60); await subject.snapshotAt(4);
    expect(await subject.snapshotAt(36)).toEqual(expected);
    expect(JSON.stringify(doc)).toBe(before);
    const changed = { ...shape, seed: 8 };
    expect((await simulation(doc, changed).snapshotAt(36)).positions).not.toEqual(expected.positions);
  });

  it("uses only completed 120 Hz steps and never advances on a zero or fractional remainder", async () => {
    const { doc, shape } = fixture();
    const subject = simulation(doc, shape);
    expect((await subject.snapshotAt(0)).count).toBe(0);
    expect((await subject.snapshotAt(.199999)).count).toBe(0);
    const first = await subject.snapshotAt(.2);
    expect(first.count).toBe(1); expect(first.simulationFrame).toBeCloseTo(.2, 12);
    expect(await subject.snapshotAt(.399999)).toEqual(first);
    expect(await subject.snapshotAt(1)).toEqual(await simulation(doc, shape).snapshotAt(1));
    const negative = fixture({ startFrame: -12, endFrame: 12 });
    expect((await simulation(negative.doc, negative.shape).snapshotAt(-11.8)).count).toBe(1);
    expect((await subject.snapshotAt(-20)).count).toBe(0);
  });

  it("schedules fractional rates as integer t=0 births, excludes end and drains after lifetime", async () => {
    const { doc, shape } = fixture({ rate: 3.5, lifetime: 1, endFrame: 24 });
    const subject = simulation(doc, shape);
    expect((await subject.snapshotAt(.2)).count).toBe(1);
    expect((await subject.snapshotAt(23.8)).count).toBe(4);
    const afterEnd = await subject.snapshotAt(24.2);
    expect(afterEnd.count).toBe(3);
    expect((await subject.snapshotAt(48.4)).count).toBe(0);
    const exact = fixture({ rate: 120, lifetime: 10, endFrame: 24 });
    expect((await simulation(exact.doc, exact.shape).snapshotAt(24.2)).count).toBe(120);
    const slow = fixture({ rate: 1e-20 });
    expect((await simulation(slow.doc, slow.shape).snapshotAt(.2)).count).toBe(1);
  });

  it("returns empty without historical evaluation for disabled, zero rate, pre-start and expired effects", async () => {
    const poses = { worldAt: vi.fn(() => { throw Error("Should not evaluate"); }) };
    for (const patch of [{ enabled: false }, { rate: 0 }]) {
      const { doc, shape } = fixture(patch);
      expect((await simulation(doc, shape, poses).snapshotAt(24)).count).toBe(0);
    }
    const { doc, shape } = fixture({ endFrame: 24, lifetime: 1 });
    const subject = simulation(doc, shape, poses);
    expect((await subject.snapshotAt(-24)).count).toBe(0);
    expect((await subject.snapshotAt(100000)).count).toBe(0);
    expect(poses.worldAt).not.toHaveBeenCalled();
  });

  it("samples each historical birth matrix and keeps previously born particles in world space", async () => {
    const { doc, shape } = fixture();
    const poses = fakePoses(frame => new Matrix4().makeTranslation(frame, 0, 0));
    const first = await simulation(doc, shape, poses).snapshotAt(1);
    expect(points(first).map(point => point.x)).toEqual([0, .2, .4, .6, .8].map(Math.fround));
    vi.mocked(poses.worldAt).mock.calls.forEach((call, index) => expect(call[0]).toBeCloseTo(index / 5, 12));
    const authored = fixture({ rate: 24 });
    authored.doc.animation!.tracks = [{ id: "move", targetId: "emitter", channel: "position.x", keys: [
      { id: "first", time: 0, value: 0, interpolation: "linear", tangentMode: "auto" },
      { id: "last", time: 24, value: 24, interpolation: "linear", tangentMode: "auto" },
    ] }];
    const actual = await simulation(authored.doc, authored.shape).snapshotAt(3);
    expect(points(actual).map(point => point.x)).toEqual([0, 1, 2]);
  });

  it("rotates directional velocity without scaling its speed or particle diameter", async () => {
    const { doc, shape } = fixture({ emission: "directional", direction: [1, 0, 0], spread: 0, speed: 2, sizes: [2, 2], rate: 1 });
    const world = new Matrix4().compose(new Vector3(4, 5, 6), new Quaternion().setFromEuler(new Euler(0, 0, Math.PI / 2)), new Vector3(8, 3, 2));
    const result = await simulation(doc, shape, fakePoses(() => world)).snapshotAt(24);
    expect(result.count).toBe(1); expect(points(result)[0].distanceTo(new Vector3(4, 7, 6))).toBeLessThan(1e-5);
    expect(result.sizes[0]).toBe(2); expect(world.elements).toEqual(new Matrix4().compose(new Vector3(4, 5, 6), new Quaternion().setFromEuler(new Euler(0, 0, Math.PI / 2)), new Vector3(8, 3, 2)).elements);
  });

  it("applies Nebula acceleration, exponential drag, attraction and seeded turbulence", async () => {
    const accelerated = fixture({ rate: 1, acceleration: [10, 0, 0] });
    const force = await simulation(accelerated.doc, accelerated.shape).snapshotAt(24);
    expect(force.positions[0]).toBeCloseTo(10 * (120 * 119 / 2) / 120 ** 2, 5);
    const dragged = fixture({ emission: "directional", spread: 0, direction: [1, 0, 0], speed: 10, drag: 2, rate: 1 });
    const drag = await simulation(dragged.doc, dragged.shape).snapshotAt(24);
    expect(drag.positions[0]).toBeCloseTo(10 / 120 * (1 - Math.exp(-2)) / (1 - Math.exp(-2 / 120)), 5);
    const attracted = fixture({ rate: 1, attraction: { position: [10, 0, 0], strength: 10, radius: 20 } });
    expect((await simulation(attracted.doc, attracted.shape).snapshotAt(24)).positions[0]).toBeGreaterThan(1);
    const turbulent = fixture({ rate: 1, turbulence: { strength: 2, scale: 1 } });
    const noise = await simulation(turbulent.doc, turbulent.shape).snapshotAt(24);
    expect(points(noise)[0].length()).toBeGreaterThan(.01);
    expect(await simulation(turbulent.doc, turbulent.shape).snapshotAt(24)).toEqual(noise);
  });

  it("uses lifetime appearance with world diameters and linear output colors", async () => {
    const { doc, shape } = fixture({ rate: 1, endFrame: 1, lifetime: 1, sizes: [2, 4], opacities: [1, 0], colors: ["#000000", "#ffffff"] });
    const subject = simulation(doc, shape), result = await subject.snapshotAt(12);
    expect(result.count).toBe(1); expect(result.sizes[0]).toBeCloseTo(3, 6); expect(result.opacities[0]).toBeCloseTo(.5, 6);
    expect(Array.from(result.colors)).toEqual(Array(3).fill(Math.fround(.21404114048223255)));
    expect((await subject.snapshotAt(24.4)).count).toBe(0);
    const growing = fixture({ sizes: [0, 4], lifetime: 1, rate: 1 });
    expect((await simulation(growing.doc, growing.shape).snapshotAt(12)).sizes[0]).toBeCloseTo(2, 5);
  });

  it("samples uniform box and ellipsoid volumes with seeded bounded positions", async () => {
    const box = fixture({ emission: "box", volume: [2, 4, 6], rate: 1200 });
    const boxPoints = points(await simulation(box.doc, box.shape).snapshotAt(24));
    expect(boxPoints.length).toBe(1200);
    expect(boxPoints.every(point => Math.abs(point.x) <= 1 && Math.abs(point.y) <= 2 && Math.abs(point.z) <= 3)).toBe(true);
    expect(Math.abs(boxPoints.reduce((sum, point) => sum + point.x, 0) / boxPoints.length)).toBeLessThan(.07);
    const sphere = fixture({ emission: "sphere", volume: [2, 4, 6], rate: 1200 });
    const spherePoints = points(await simulation(sphere.doc, sphere.shape).snapshotAt(24));
    const radiiSquared = spherePoints.map(point => point.x ** 2 + (point.y / 2) ** 2 + (point.z / 3) ** 2);
    expect(radiiSquared.every(radius => radius <= 1.000001)).toBe(true);
    expect(radiiSquared.reduce((a, b) => a + b, 0) / radiiSquared.length).toBeCloseTo(.6, 1);
  });

  it("honors volume direction, spread and absolute random speed", async () => {
    const still = fixture({ emission: "box", volume: [1e-8, 1e-8, 1e-8], direction: [1, 0, 0], spread: 0, speed: 2, speedRandom: 4, rate: 1200 });
    const result = await simulation(still.doc, still.shape).snapshotAt(.2);
    expect(result.count).toBe(10);
    for (const point of points(result)) { expect(point.x).toBeGreaterThanOrEqual(-1e-8); expect(point.x).toBeLessThanOrEqual(4 / 120 + 1e-8); expect(Math.abs(point.y)).toBeLessThan(1e-8); }
    const spread = fixture({ emission: "directional", spread: 1, speed: 1, rate: 1200 });
    const scattered = points(await simulation(spread.doc, spread.shape).snapshotAt(.2));
    expect(scattered.some(point => point.y < 0)).toBe(true); expect(scattered.some(point => point.y > 0)).toBe(true);
  });

  it("samples actual surfaces by world area under nonuniform scale, with no geometry mutation", async () => {
    const { doc, shape, mesh } = surfaceFixture();
    const before = JSON.stringify(mesh), poses = fakePoses(() => new Matrix4().makeScale(1, 1, 5));
    const scaled = points(await simulation(doc, shape, poses).snapshotAt(24));
    const yzRatio = scaled.filter(point => point.x > 5).length / scaled.length;
    expect(yzRatio).toBeGreaterThan(.78); expect(yzRatio).toBeLessThan(.88);
    for (const point of scaled) {
      if (point.x > 5) { expect(point.x).toBe(10); expect(point.y + point.z / 5).toBeLessThanOrEqual(1.000001); }
      else { expect(point.z).toBe(0); expect(point.x + point.y).toBeLessThanOrEqual(1.000001); }
    }
    const unscaled = points(await simulation(doc, shape).snapshotAt(24));
    const unscaledRatio = unscaled.filter(point => point.x > 5).length / unscaled.length;
    expect(unscaledRatio).toBeGreaterThan(.44); expect(unscaledRatio).toBeLessThan(.56);
    expect(JSON.stringify(mesh)).toBe(before);
  });

  it("emits along surface normals and reuses surface weights across translations and rotations", async () => {
    const { doc, shape, mesh } = surfaceFixture({ rate: 120, speed: 1 });
    mesh.faces = [mesh.faces[0]];
    const build = vi.spyOn(MeshSurfaceSampler.prototype, "build");
    const poses = fakePoses(frame => new Matrix4().compose(new Vector3(frame, 0, 0), new Quaternion().setFromEuler(new Euler(0, 0, frame / 10)), new Vector3(1, 1, 1)));
    const result = await simulation(doc, shape, poses).snapshotAt(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(result.count).toBe(5);
    expect(points(result).map(point => point.z)).toEqual([5, 4, 3, 2, 1].map(value => Math.fround(value / 120)));
  });

  it("rebuilds surface probabilities when historical scale changes and rejects collapsed poses", async () => {
    const { doc, shape } = surfaceFixture({ rate: 120 });
    const build = vi.spyOn(MeshSurfaceSampler.prototype, "build");
    const poses = fakePoses(frame => new Matrix4().makeScale(1, 1, frame < .4 ? 1 : 5));
    await simulation(doc, shape, poses).snapshotAt(1);
    expect(build).toHaveBeenCalledTimes(2);
    const collapsed = simulation(doc, shape, fakePoses(() => new Matrix4().makeScale(1, 0, 1)));
    await expect(collapsed.snapshotAt(1)).rejects.toThrow(/collapsed|invertible/);
  });

  it("treats empty mesh surfaces as empty and releases owned sampler resources once", async () => {
    const empty = surfaceFixture(); empty.mesh.faces = [];
    expect((await simulation(empty.doc, empty.shape).snapshotAt(24)).count).toBe(0);
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, "dispose"), materialDispose = vi.spyOn(MeshBasicMaterial.prototype, "dispose");
    const full = surfaceFixture(), subject = simulation(full.doc, full.shape);
    await subject.snapshotAt(.2); subject.dispose(); subject.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1); expect(materialDispose).toHaveBeenCalledTimes(1);
    await expect(subject.snapshotAt(1)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps only four output snapshots and returns caller-owned arrays", async () => {
    const { doc, shape } = fixture(), poses = fakePoses(() => new Matrix4());
    const subject = simulation(doc, shape, poses);
    const original = await subject.snapshotAt(.2); original.positions[0] = 99;
    expect((await subject.snapshotAt(.2)).positions[0]).toBe(0);
    for (const frame of [.4, .6, .8, 1]) await subject.snapshotAt(frame);
    vi.mocked(poses.worldAt).mockClear();
    await subject.snapshotAt(.2);
    expect(poses.worldAt).toHaveBeenCalledWith(0);
  });

  it("rejects excessive budgets and invalid inputs before allocating an engine", async () => {
    const excessive = fixture({ rate: 10000, lifetime: 3 });
    expect(() => simulation(excessive.doc, excessive.shape)).toThrow(/20,000/);
    const { doc, shape } = fixture(), subject = simulation(doc, shape);
    await expect(subject.snapshotAt(NaN)).rejects.toThrow(/finite/);
    await expect(subject.snapshotAt(Infinity)).rejects.toThrow(/finite/);
    const allowed = fixture({ rate: 10000, lifetime: .02 });
    const result = await simulation(allowed.doc, allowed.shape).snapshotAt(24);
    expect(result.count).toBeLessThanOrEqual(251); expect(result.count).toBeGreaterThan(100);
  });

  it("cancels superseded evaluations at task yields and keeps the replacement deterministic", async () => {
    vi.useFakeTimers(); let time = 0; vi.spyOn(performance, "now").mockImplementation(() => time += 5);
    const { doc, shape } = fixture(), subject = simulation(doc, shape);
    const pending = subject.snapshotAt(120), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const replacement = subject.snapshotAt(1);
    await vi.runAllTimersAsync(); await rejected;
    const fresh = simulation(doc, shape).snapshotAt(1); await vi.runAllTimersAsync();
    expect(await replacement).toEqual(await fresh);
  });

  it("does not publish partially prepared surface weights when a request is superseded", async () => {
    vi.useFakeTimers(); let time = 0; vi.spyOn(performance, "now").mockImplementation(() => time += 5);
    const { doc, shape } = surfaceFixture();
    const poses = fakePoses(frame => new Matrix4().makeScale(1, 1, 1 + frame));
    const subject = simulation(doc, shape, poses), old = subject.snapshotAt(24);
    const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    const replacement = subject.snapshotAt(.4); await vi.runAllTimersAsync(); await rejected;
    const fresh = simulation(doc, shape, poses).snapshotAt(.4); await vi.runAllTimersAsync();
    expect(await replacement).toEqual(await fresh);
  });

  it("cancels pending work on disposal and abandons failed engines for a clean retry", async () => {
    vi.useFakeTimers(); let time = 0; vi.spyOn(performance, "now").mockImplementation(() => time += 5);
    const { doc, shape } = fixture(), subject = simulation(doc, shape);
    const pending = subject.snapshotAt(120), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    subject.dispose(); await vi.runAllTimersAsync(); await rejected;
    vi.useRealTimers(); vi.restoreAllMocks();
    let fail = true;
    const poses = fakePoses(frame => { if (fail && frame >= .4) throw Error("Historical constraint is unsupported"); return new Matrix4().makeTranslation(frame, 0, 0); });
    const retry = simulation(doc, shape, poses);
    await expect(retry.snapshotAt(1)).rejects.toThrow(/Historical constraint/);
    fail = false;
    expect(await retry.snapshotAt(1)).toEqual(await simulation(doc, shape, fakePoses(frame => new Matrix4().makeTranslation(frame, 0, 0))).snapshotAt(1));
  });
});
