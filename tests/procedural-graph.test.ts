import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { emptyScene } from "../src/scene-document.ts";
import { createSceneStore } from "../src/scene-store.ts";
import { decodeProject, encodeProject, validateScene } from "../src/project-archive.ts";
import {
  animatedNoiseGraph, commitGraphCommand, connectGraphPorts, createGraphNode,
  createProceduralGraph, deleteGraphNode, disconnectGraphPort, editGraphNode,
  GRAPH_LIMITS, graphTextureReferences, validateProceduralGraph, type ProceduralGraph,
} from "../src/procedural-graph.ts";
import { compileGraph, displayPixel, graphSeconds } from "../src/procedural-graph-runtime.ts";
import { relinkTexture, removeTexture, replaceTexture, type TextureAsset } from "../src/texture-assets.ts";

const node = (kind: Parameters<typeof createGraphNode>[0], id = kind) => createGraphNode(kind, id, 0, 0);
const connect = (graph: ProceduralGraph, a: string, out: string, b: string, input: string) =>
  connectGraphPorts(graph, { node: a, port: out }, { node: b, port: input });
const graph = (...nodes: ProceduralGraph["nodes"]): ProceduralGraph => ({ nodes: [...nodes, node("output")], edges: [] });
const camera = { position: [0, 0, 6], target: [0, 0, 0], fov: 42, near: 0.01, far: 1000 } as const;
const editor = { camera: { ...camera, position: [...camera.position], target: [...camera.target] } as
  Parameters<typeof encodeProject>[2]["camera"], time: 0 };
const example = new URL("../examples/textures/animated-noise-ramp.msb", import.meta.url);
const loadExample = async () => decodeProject(new Uint8Array(await readFile(example)));
const sample = { uv: [0.31, 0.62] as [number, number], frame: 19, fps: 24 };

describe("Procedural texture graphs", () => {
  it("rejects mismatched ports, duplicate targets and disconnected cycles atomically", () => {
    const value = graph(node("uv"), node("add"), node("clamp"));
    const store = createSceneStore({ ...emptyScene(), proceduralGraph: value });
    const initial = store.getState().document;
    const commit = (action: (g: ProceduralGraph) => ProceduralGraph) =>
      commitGraphCommand(store, "Connect", old => action(old!));
    expect(() => commit(g => connect(g, "uv", "uv", "output", "color"))).toThrow(/Cannot connect/);
    expect(() => commit(g => connect(g, "uv", "wrong", "output", "color"))).toThrow(/missing port/);
    expect(store.getState().document).toBe(initial);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    commit(g => connect(g, "add", "value", "clamp", "value"));
    const linked = store.getState().document;
    expect(() => commit(g => connect(g, "clamp", "value", "add", "a"))).toThrow(/cycle/);
    expect(store.getState().document).toBe(linked);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    const good = linked.proceduralGraph!;
    expect(() => validateProceduralGraph({ ...good, edges: [...good.edges, good.edges[0]] })).toThrow(/only one/);
  });

  it("commits replace, disconnect and delete exactly once and preserves graph undo/redo", () => {
    const initial = connect(graph(node("time"), node("noise")), "time", "value", "output", "color");
    const store = createSceneStore({ ...emptyScene(), proceduralGraph: initial });
    commitGraphCommand(store, "Same", old => connect(old!, "time", "value", "output", "color"));
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    commitGraphCommand(store, "Replace", old => connect(old!, "noise", "value", "output", "color"));
    const replaced = store.getState().document.proceduralGraph!;
    expect(replaced.edges).toHaveLength(1);
    expect(replaced.edges[0].from.node).toBe("noise");
    commitGraphCommand(store, "Disconnect", old => disconnectGraphPort(old!, { node: "output", port: "color" }));
    const disconnected = store.getState().document.proceduralGraph!;
    expect(disconnected.edges).toHaveLength(0);
    commitGraphCommand(store, "Delete", old => deleteGraphNode(old!, "noise"));
    const deleted = store.getState().document.proceduralGraph!;
    expect(deleted.nodes.map(n => n.id)).toEqual(["time", "output"]);
    expect(() => deleteGraphNode(deleted, "output")).toThrow(/requires/);
    expect(store.temporal.getState().pastStates).toHaveLength(3);
    store.temporal.getState().undo(3);
    expect(store.getState().document.proceduralGraph).toBe(initial);
    store.temporal.getState().redo(3);
    expect(store.getState().document.proceduralGraph).toBe(deleted);
    expect(deleteGraphNode(replaced, "noise").edges).toHaveLength(0);
  });

  it("validates shape, finite parameters, unique nodes, layout and budgets", () => {
    expect(() => validateProceduralGraph(null)).toThrow(/Invalid/);
    const tooMany = Array.from({ length: GRAPH_LIMITS.nodes }, (_, i) => createGraphNode("uv", "uv" + i, 0, 0));
    expect(() => validateProceduralGraph(graph(...tooMany))).toThrow(/48 nodes/);
    expect(() => validateProceduralGraph(graph(node("time"), node("time")))).toThrow(/duplicate/);
    expect(() => validateProceduralGraph({ nodes: [node("uv")], edges: [] })).toThrow(/exactly one/);
    const noise = node("noise");
    expect(() => validateProceduralGraph(graph({ ...noise, x: -1 }))).toThrow(/layout/);
    expect(() => validateProceduralGraph(graph({ ...noise, params: { seed: 1.5, speed: 1, scale: 1 } } as typeof noise))).toThrow(/seed/);
    expect(() => validateProceduralGraph(graph({ ...noise, params: { seed: 1, speed: NaN, scale: 1 } } as typeof noise))).toThrow(/speed/);
    expect(() => validateProceduralGraph(graph({ ...noise, params: { seed: 1, speed: 0, scale: 1, shader: "bad" } } as typeof noise))).toThrow(/parameters/);
    expect(() => validateProceduralGraph({ ...createProceduralGraph(), edges: new Array(GRAPH_LIMITS.edges + 1) })).toThrow(/96 connections/);
  });

  it("validates bounded images, protected deletion and atomic relinking including size failures", async () => {
    const { scene } = await loadExample();
    const asset = Object.values(scene.textureAssets!)[0];
    const replacement = { ...asset, id: "replacement", width: GRAPH_LIMITS.pixels + 1 };
    const oversized = { ...scene, textureAssets: { ...scene.textureAssets, replacement } };
    expect(() => removeTexture(scene, asset.id)).toThrow(/texture graph/);
    expect(() => relinkTexture(oversized, asset.id, replacement.id)).toThrow(/pixels/);
    expect(graphTextureReferences(scene.proceduralGraph, asset.id)).toHaveLength(1);
    expect(() => replaceTexture(scene, asset.id, { ...asset, id: "wrong" })).toThrow(/identity|metadata/);
    const target = { ...asset, id: "validForGraph" };
    const linked = relinkTexture({ ...scene, textureAssets: { ...scene.textureAssets, [target.id]: target } }, asset.id, target.id);
    expect(graphTextureReferences(linked.proceduralGraph, target.id)).toHaveLength(1);
    expect(() => removeTexture(linked, asset.id)).not.toThrow();
    const more: Record<string, TextureAsset> = {};
    const nodes = Array.from({ length: GRAPH_LIMITS.images + 1 }, (_, index) => {
      const id = "image" + index;
      more[id] = { ...asset, id };
      return { ...createGraphNode("texture", id, 0, 0), kind: "texture" as const, params: { assetId: id } };
    });
    expect(() => validateProceduralGraph(graph(...nodes), more)).toThrow(/four graph images/);
    expect(() => validateScene({ ...scene, textureAssets: {} })).toThrow(/missing image/);
  });

  it("evaluates frame/FPS, repeat and backwards samples deterministically with stable shader topology", () => {
    const value = animatedNoiseGraph();
    const program = compileGraph(value);
    expect(program.animated).toBe(true);
    expect(graphSeconds(48, 24)).toBe(2);
    expect(graphSeconds(48, 48)).toBe(1);
    expect(() => graphSeconds(Infinity, 24)).toThrow(/timeline/);
    const a = program.sample(sample), b = program.sample({ ...sample, frame: 30 });
    expect(a).not.toEqual(b);
    expect(program.sample(sample)).toEqual(a);
    expect(program.sample({ ...sample, frame: 38, fps: 48 })).toEqual(a);
    expect(program.sample({ ...sample, fps: 48 })).not.toEqual(a);
    expect(displayPixel(a)).toEqual([72, 59, 55, 255]);
    const newSeed = editGraphNode(value, "noise", n => n.kind === "noise" ? { ...n, params: { ...n.params, seed: 7 } } : n);
    const after = compileGraph(newSeed);
    expect(after.fragment).toBe(program.fragment);
    expect(after.uniforms).not.toEqual(program.uniforms);
    expect(after.sample(sample)).not.toEqual(a);
    const disconnected = disconnectGraphPort(value, { node: "noise", port: "time" });
    expect(compileGraph(disconnected).animated).toBe(false);
  });

  it("evaluates scalar broadcast, vector noise, color math and reversed clamp bounds", () => {
    let value = graph(node("uv"), node("noise"), node("gradient"), node("add"), node("clamp"), node("multiply"));
    value = editGraphNode(value, "clamp", n => n.kind === "clamp" ? { ...n, params: { type: "scalar", value: 0, min: 0.4, max: 0.2 } } : n);
    value = editGraphNode(value, "add", n => n.kind === "add" ? { ...n, params: { ...n.params, b: 0.3 } } : n);
    value = connect(value, "uv", "uv", "noise", "position");
    value = connect(value, "noise", "value", "add", "a");
    value = connect(value, "add", "value", "clamp", "value");
    value = connect(value, "clamp", "value", "multiply", "a");
    value = connect(value, "gradient", "color", "multiply", "b");
    value = connect(value, "multiply", "value", "output", "color");
    const color = compileGraph(value).sample({ ...sample, uv: [0, 0] });
    expect(color[0]).toBeCloseTo(0.025 * 0.4);
    expect(color[1]).toBeCloseTo(0.06 * 0.4);
    expect(color[2]).toBeCloseTo(0.22 * 0.4);
    expect(color[3]).toBe(1);
  });

  it("samples top-left decoded image bytes from lower-left UV with color/data and separate alpha", () => {
    const asset = { id: "image", width: 2, height: 2, role: "color" } as TextureAsset;
    let value = graph({ ...node("texture"), kind: "texture", params: { assetId: "image" } });
    value = connect(value, "texture", "color", "output", "color");
    value = connect(value, "texture", "alpha", "output", "alpha");
    const rgba = new Uint8Array([128, 32, 64, 127, 255, 0, 0, 255, 16, 24, 32, 255, 0, 255, 0, 255]);
    const pixels = new Map([["image", { width: 2, height: 2, rgba }]]);
    const color = compileGraph(value, { image: asset });
    const data = compileGraph(value, { image: { ...asset, role: "data" } });
    const top = { ...sample, uv: [-1, 1] as [number, number] };
    expect(color.sample(top, pixels)[0]).toBeCloseTo(0.21586);
    expect(data.sample(top, pixels)[0]).toBeCloseTo(128 / 255);
    expect(color.sample(top, pixels)[3]).toBe(127 / 255);
    expect(color.sample({ ...sample, uv: [0, 0] }, pixels)[0]).toBeLessThan(0.01);
    expect(() => color.sample(top)).toThrow(/CPU texture pixels/);
  });

  it("round-trips the original example, image identity and graph layout in current MSB", async () => {
    const { scene, files } = await loadExample();
    const again = await decodeProject(await encodeProject(scene, files, editor));
    expect(again.scene).toEqual(scene);
    expect(again.scene.version).toBe(2);
    expect(again.files.size).toBe(0);
    const asset = Object.values(scene.textureAssets!)[0];
    expect(asset.name).toMatch(/checker/);
    expect(graphTextureReferences(scene.proceduralGraph, asset.id)).toHaveLength(1);
    const pixels = new Map([[asset.id, { width: asset.width, height: asset.height, rgba: new Uint8Array(asset.width * asset.height * 4).fill(255) }]]);
    expect(compileGraph(again.scene.proceduralGraph!, again.scene.textureAssets).sample(sample, pixels))
      .toEqual(compileGraph(scene.proceduralGraph!, scene.textureAssets).sample(sample, pixels));
  });
});
