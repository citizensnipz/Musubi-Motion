import { createParticleEmitter, findParticleShape, updateParticleEmitter, type ParticleEmission, type ParticleEmitterPatch, type ParticleShapeNode } from "./particle-emitter.ts";
import { findMeshShape } from "./mesh-modeling.ts";
import type { Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

type Options = {
  available: () => boolean;
  getSelection: () => string[];
  onSelectObject: (id: string) => void;
  getRuntimeStatus?: (shapeId: string) => { count: number; pending: boolean; error?: string } | undefined;
};
const emissionNames: Record<ParticleEmission, string> = { omni: "Omni", directional: "Directional", box: "Box volume", sphere: "Sphere volume", surface: "Mesh surface" };

/** Emitter settings are document commands; refresh only reads simulation status. */
export function createParticlePanel(store: SceneStore, options: Options) {
  const element = document.createElement("section"); element.className = "particle-panel"; element.setAttribute("aria-label", "Particle Emitters");
  const style = document.createElement("style");
  style.textContent = `.particle-panel{height:100%;overflow:auto;padding:12px;background:var(--panel);color:var(--text);font-size:12px}
    .particle-panel p{line-height:1.5;color:var(--muted)}.particle-panel fieldset{border:1px solid var(--line);padding:10px;margin:0 0 12px;min-width:0}.particle-panel legend{padding:0 5px}.particle-panel label{display:grid;gap:5px;margin:8px 0}
    .particle-panel input,.particle-panel select,.particle-panel button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0;box-sizing:border-box}.particle-panel input:not([type=checkbox]),.particle-panel select{width:100%}
    .particle-panel button{cursor:pointer}.particle-panel button:hover:not(:disabled){background:var(--hover)}.particle-panel :disabled{opacity:.45;cursor:default}.particle-panel :focus-visible{outline:1px solid var(--strong)}
    .particle-panel .particle-check{display:flex;align-items:center;gap:7px}.particle-panel .particle-xyz{display:grid;grid-template-columns:repeat(3,minmax(35px,1fr));gap:6px}.particle-panel .particle-pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .particle-panel details{margin:12px 0}.particle-panel summary{cursor:pointer}.particle-panel .particle-status{min-height:20px;overflow-wrap:anywhere}.particle-panel [data-error=true]{color:#ce756a}`;
  function label(text: string, control: HTMLElement) { const node = document.createElement("label"); node.append(document.createTextNode(text), control); return node; }
  function group(title: string) { const node = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = title; node.append(legend); return node; }
  function details(title: string) { const node = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = title; node.append(summary); return node; }
  function note(text: string) { const node = document.createElement("p"); node.textContent = text; return node; }
  function select(name: string) { const node = document.createElement("select"); node.setAttribute("aria-label", name); return node; }
  const creation = group("Create emitter"), preset = select("New particle emitter type");
  for (const [value, title] of Object.entries(emissionNames)) preset.add(new Option(title, value));
  const newName = document.createElement("input"); newName.type = "text"; newName.maxLength = 100; newName.value = "emitter"; newName.setAttribute("aria-label", "New particle emitter name");
  const placement = note(""), create = document.createElement("button"); create.type = "button"; create.textContent = "Create particle emitter";
  creation.append(label("Type", preset), label("Name", newName), placement, create);
  const emitters = select("Selected particle emitter"), empty = note("Create an emitter or select one in the Outliner. Use Properties and the object gizmo to animate its transform.");
  const fields = document.createElement("div"), summary = note(""), runtime = note(""); runtime.setAttribute("aria-label", "Particle runtime status");
  const emission = group("Emission"), enabled = document.createElement("input"); enabled.type = "checkbox";
  const enabledLabel = label("Enabled", enabled); enabledLabel.className = "particle-check"; emission.append(enabledLabel);
  const dynamics = group("Dynamics"), appearance = group("Appearance");
  const status = note(""); status.className = "particle-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  let activeId = "", selectionSignature = "", emitterSignature = "", displayedId = "";
  const bindings: { input: HTMLInputElement; read: (shape: ParticleShapeNode) => string }[] = [];

  function current() { const shape = findParticleShape(store.getState().document, activeId); if (!shape) throw Error("Choose a particle emitter first."); return shape; }
  function run(action: () => void) {
    if (!options.available()) { status.textContent = "Pause playback and finish the current operation before editing emitter settings."; status.dataset.error = "true"; return; }
    try { action(); status.textContent = ""; status.dataset.error = "false"; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); status.dataset.error = "true"; }
    refresh();
  }
  function patch(value: ParticleEmitterPatch) { updateParticleEmitter(store, current().id, value); }
  function bindNumber(parent: HTMLElement, title: string, read: (shape: ParticleShapeNode) => number,
    write: (shape: ParticleShapeNode, value: number) => ParticleEmitterPatch, min: number, max: number, step = "any") {
    const input = document.createElement("input"); input.type = "number"; input.min = String(min); input.max = String(max); input.step = step; input.setAttribute("aria-label", title);
    let cancel = false, editingId = "";
    input.onfocus = () => { editingId = activeId; };
    input.addEventListener("blur", () => {
      if (!cancel && editingId === activeId) run(() => {
        const value = input.valueAsNumber;
        if (!input.value.trim() || !Number.isFinite(value) || value < min || value > max || (step === "1" && !Number.isInteger(value)))
          throw Error(`${title} must be ${step === "1" ? "a whole number" : "a finite number"} from ${min} to ${max}.`);
        patch(write(current(), value));
      });
      cancel = false; refresh();
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); input.blur(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel = true; input.blur(); }
    });
    bindings.push({ input, read: shape => String(read(shape)) }); parent.append(label(title, input)); return input;
  }
  function bindVector(parent: HTMLElement, title: string, read: (shape: ParticleShapeNode) => Vec3,
    write: (shape: ParticleShapeNode, value: Vec3) => ParticleEmitterPatch, min: number, max: number) {
    parent.append(note(title)); const row = document.createElement("div"); row.className = "particle-xyz"; parent.append(row);
    for (let axis = 0; axis < 3; axis++) bindNumber(row, `${title} ${"XYZ"[axis]}`, shape => read(shape)[axis], (shape, number) => {
      const value = [...read(shape)] as Vec3; value[axis] = number; return write(shape, value);
    }, min, max);
  }
  bindNumber(emission, "Rate · particles/second", shape => shape.rate, (_, rate) => ({ rate }), 0, 10000);
  bindNumber(emission, "Lifetime · seconds", shape => shape.lifetime, (_, lifetime) => ({ lifetime }), 0.01, 60);
  const timing = details("Timing and random seed");
  bindNumber(timing, "Emission start frame", shape => shape.startFrame, (_, startFrame) => ({ startFrame }), -100000, 100000, "1");
  bindNumber(timing, "Emission end frame", shape => shape.endFrame, (_, endFrame) => ({ endFrame }), -100000, 100000, "1");
  bindNumber(timing, "Random seed", shape => shape.seed, (_, seed) => ({ seed }), 0, 4294967295, "1");
  timing.append(note("End must follow start. The seed makes replay reproducible for unchanged settings and scene animation.")); emission.append(timing);
  const direction = details("Emission direction and spread");
  const directionAxes = document.createElement("div"); direction.append(directionAxes);
  bindVector(directionAxes, "Local direction", shape => shape.direction, (_, value) => ({ direction: value }), -1000000, 1000000);
  bindNumber(direction, "Spread · 0 to 1", shape => shape.spread, (_, spread) => ({ spread }), 0, 1);
  const directionHelp = note(""); direction.append(directionHelp); emission.append(direction);
  const volume = details("Emission volume");
  bindVector(volume, "Full local extent", shape => shape.volume, (_, value) => ({ volume: value }), 0.000001, 10000); emission.append(volume);
  bindNumber(dynamics, "Initial speed", shape => shape.speed, (_, speed) => ({ speed }), 0, 10000);
  bindNumber(dynamics, "Speed variation · units/second", shape => shape.speedRandom, (_, speedRandom) => ({ speedRandom }), 0, 10000);
  dynamics.append(note("Initial speed varies by half this range above or below Speed; negative results clamp to zero."));
  const forces = details("Acceleration and drag");
  bindVector(forces, "World acceleration", shape => shape.acceleration, (_, acceleration) => ({ acceleration }), -100000, 100000);
  bindNumber(forces, "Drag · per second", shape => shape.drag, (_, drag) => ({ drag }), 0, 100); dynamics.append(forces);
  const turbulence = details("Turbulence");
  bindNumber(turbulence, "Turbulence strength", shape => shape.turbulence.strength, (shape, strength) => ({ turbulence: { ...shape.turbulence, strength } }), 0, 10000);
  bindNumber(turbulence, "Turbulence scale", shape => shape.turbulence.scale, (shape, scale) => ({ turbulence: { ...shape.turbulence, scale } }), 0.000001, 10000); dynamics.append(turbulence);
  const attraction = details("Attraction / repulsion");
  bindVector(attraction, "World attraction position", shape => shape.attraction.position, (shape, position) => ({ attraction: { ...shape.attraction, position } }), -1000000, 1000000);
  bindNumber(attraction, "Attraction strength", shape => shape.attraction.strength, (shape, strength) => ({ attraction: { ...shape.attraction, strength } }), -10000, 10000);
  bindNumber(attraction, "Attraction radius", shape => shape.attraction.radius, (shape, radius) => ({ attraction: { ...shape.attraction, radius } }), 0.000001, 10000);
  attraction.append(note("Positive strength attracts; negative strength repels. Zero disables this field.")); dynamics.append(attraction);
  const sizes = document.createElement("div"); sizes.className = "particle-pair";
  for (let side = 0; side < 2; side++) bindNumber(sizes, `${side ? "End" : "Start"} diameter · world units`, shape => shape.sizes[side], (shape, value) => {
    const sizes: [number, number] = [...shape.sizes]; sizes[side] = value; return { sizes };
  }, 0, 10000);
  appearance.append(sizes);
  const colors = document.createElement("div"); colors.className = "particle-pair";
  for (let side = 0; side < 2; side++) {
    const input = document.createElement("input"); input.type = "color"; const title = `${side ? "End" : "Start"} particle color`; input.setAttribute("aria-label", title);
    input.onchange = () => run(() => { const values: [string, string] = [...current().colors]; values[side] = input.value; patch({ colors: values }); });
    bindings.push({ input, read: shape => shape.colors[side] }); colors.append(label(title, input));
  }
  appearance.append(colors);
  const opacity = details("Opacity over lifetime");
  for (let side = 0; side < 2; side++) bindNumber(opacity, `${side ? "End" : "Start"} opacity`, shape => shape.opacities[side], (shape, value) => {
    const opacities: [number, number] = [...shape.opacities]; opacities[side] = value; return { opacities };
  }, 0, 1);
  appearance.append(opacity);
  fields.append(summary, runtime, emission, dynamics, appearance);
  const help = note("Emitter properties are static saved settings. Animate the emitter's transform with Properties and the timeline. Particles already born stay in world space. Changes replay the seeded simulation; pending results appear in the runtime status.");
  element.append(style, creation, label("Emitter", emitters), empty, fields, status, help);

  create.onclick = () => run(() => {
    const selection = options.getSelection(), doc = store.getState().document;
    const source = selection.length === 1 ? findMeshShape(doc, selection[0]) : undefined;
    if (preset.value === "surface" && !source) throw Error("Select exactly one polygon mesh in the Outliner before creating a mesh-surface emitter.");
    const name = newName.value.trim(); if (!name) throw Error("Enter an emitter name.");
    const id = createParticleEmitter(store, preset.value as ParticleEmission, { name, ...(preset.value === "surface" ? { surfaceId: source!.id } : {}) });
    activeId = findParticleShape(store.getState().document, id)?.id ?? ""; options.onSelectObject(id);
  });
  preset.onchange = () => refresh();
  enabled.onchange = () => run(() => patch({ enabled: enabled.checked }));
  emitters.onchange = () => run(() => { activeId = emitters.value; status.textContent = ""; if (activeId) options.onSelectObject(current().parentId); });
  function resetScene() { activeId = ""; displayedId = ""; selectionSignature = JSON.stringify(options.getSelection()); status.textContent = ""; status.dataset.error = "false"; refresh(); }
  function refresh() {
    const doc = store.getState().document, selection = options.getSelection(), available = options.available();
    const selectionKey = JSON.stringify(selection);
    if (selectionKey !== selectionSignature) { selectionSignature = selectionKey; activeId = selection.length === 1 ? findParticleShape(doc, selection[0])?.id ?? "" : ""; }
    const shapes = Object.values(doc.nodes).filter((node): node is ParticleShapeNode => node.type === "particleShape");
    const listKey = JSON.stringify(shapes.map(shape => [shape.id, doc.nodes[shape.parentId]?.name ?? shape.name]));
    if (listKey !== emitterSignature) { emitterSignature = listKey; emitters.replaceChildren(new Option("Choose a particle emitter", ""), ...shapes.map(shape => new Option(doc.nodes[shape.parentId]?.name ?? shape.name, shape.id))); }
    const shape = shapes.find(item => item.id === activeId); if (!shape) activeId = "";
    const switched = displayedId !== activeId; displayedId = activeId;
    emitters.value = activeId; fields.hidden = !shape; empty.hidden = !!shape;
    for (const input of Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button"))) input.disabled = !available;
    emitters.disabled = !available || !shapes.length;
    const source = selection.length === 1 ? findMeshShape(doc, selection[0]) : undefined;
    create.disabled = !available || (preset.value === "surface" && !source);
    placement.textContent = preset.value === "surface" ? source
      ? `Emit from ${doc.nodes[source.parentId]?.name ?? source.name}. The new emitter is parented to this mesh; its source cannot be retargeted.`
      : "Select exactly one polygon mesh in the Outliner to create a mesh-surface emitter."
      : "Create at the origin, then position the emitter with the normal object transform tools.";
    if (!shape) { runtime.textContent = ""; return; }
    enabled.checked = shape.enabled;
    for (const binding of bindings) if (switched || document.activeElement !== binding.input) binding.input.value = binding.read(shape);
    direction.hidden = shape.emission === "omni";
    directionAxes.hidden = shape.emission === "surface";
    directionHelp.textContent = shape.emission === "surface"
      ? "Particles emit around the sampled mesh face normal. Spread 0 follows that normal; 1 covers all directions."
      : "Direction is relative to the emitter transform and must be nonzero. Spread 0 follows this direction; 1 covers all directions.";
    volume.hidden = shape.emission !== "box" && shape.emission !== "sphere";
    summary.textContent = `${doc.nodes[shape.parentId]?.name ?? shape.name} · ${emissionNames[shape.emission]}${shape.surfaceId ? ` · Source: ${doc.nodes[doc.nodes[shape.surfaceId]?.parentId ?? ""]?.name ?? doc.nodes[shape.surfaceId]?.name ?? "Unavailable"}` : ""}`;
    const state = options.getRuntimeStatus?.(shape.id);
    runtime.textContent = state?.error ? state.error : state ? `${state.count.toLocaleString()} particles${state.pending ? " · Replaying simulation…" : ""}` : "";
    runtime.dataset.error = String(!!state?.error);
  }
  store.subscribe(() => refresh()); refresh();
  return { element, refresh, resetScene };
}
