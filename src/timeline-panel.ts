import { defaultAnimation, setAnimationSettings, deleteKeys } from "./animation.ts";
import type { SceneStore } from "./scene-store.ts";
import type WaSlider from "@awesome.me/webawesome/dist/components/slider/slider.js";
import "./timeline-panel.css";

export function mountTimeline(store: SceneStore, options: {
  getFrame(): number; setFrame(frame: number): void; setKey(): void;
  getSelection(): string[]; available(): boolean; onModeChange(): void;
}) {
  const host = document.getElementById("timeline-panel")!;
  const row = document.createElement("div"); row.className = "timeline-transport";
  row.append(...Array.from(host.children)); host.append(row);
  host.querySelector(".animation-label")!.remove();
  const tools = document.createElement("div"); tools.className = "timeline-options";
  tools.innerHTML = `<label>Mode <select aria-label="Playback mode"><option value="animation">Animation</option><option value="turntable">Turntable preview</option></select></label>
    <button type="button" data-action="key" title="Key selected transforms and joints (S)">Set key · S</button>
    <button type="button" data-action="delete">Delete keys at frame</button>
    <label><input type="checkbox" data-option="auto" /> Auto key</label>
    <label>Frame <input type="number" data-option="frame" aria-label="Current frame" step="1" /></label>
    <label>Start <input type="number" data-option="start" aria-label="Playback start frame" step="1" /></label>
    <label>End <input type="number" data-option="end" aria-label="Playback end frame" step="1" /></label>
    <label>FPS <input type="number" data-option="fps" aria-label="Frame rate" min="1" max="240" step="1" /></label>
    <label><input type="checkbox" data-option="loop" /> Loop</label>
    <span class="timeline-hint">Auto key updates existing channels. Set the first keys with S.</span>`;
  host.append(tools);
  const get = (name: string) => tools.querySelector<HTMLInputElement>(`[data-option="${name}"]`)!;
  const slider = document.getElementById("timeline") as WaSlider;
  const mode = tools.querySelector("select")!;
  const markers = document.createElement("div"); markers.className = "timeline-keys";
  markers.setAttribute("aria-label", "Keys for selected objects"); host.querySelector(".timeline")!.append(markers);
  const status = document.createElement("span"); status.className = "timeline-error"; status.setAttribute("role", "status"); tools.append(status);
  function run(action: () => void) {
    if (!options.available()) return;
    try { action(); status.textContent = ""; } catch (error) { status.textContent = (error as Error).message; refresh(); }
  }
  mode.onchange = () => run(options.onModeChange);
  tools.querySelector<HTMLButtonElement>('[data-action="key"]')!.onclick = () => run(options.setKey);
  tools.querySelector<HTMLButtonElement>('[data-action="delete"]')!.onclick = () => run(() => {
    const selection = new Set(options.getSelection());
    const ids = store.getState().document.animation?.tracks.filter(t => selection.has(t.targetId))
      .flatMap(t => t.keys.filter(k => k.time === Math.round(options.getFrame())).map(k => k.id)) ?? [];
    deleteKeys(store, ids);
  });
  get("frame").onchange = () => run(() => options.setFrame(get("frame").valueAsNumber));
  for (const input of Array.from(tools.querySelectorAll<HTMLInputElement>('input[type="number"]'))) input.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); input.blur(); }
  });
  for (const key of ["start", "end", "fps"] as const) get(key).onchange = () => run(() => setAnimationSettings(store, { [key]: get(key).valueAsNumber }));
  get("loop").onchange = () => run(() => setAnimationSettings(store, { loop: get("loop").checked }));
  let lastDocument: ReturnType<SceneStore["getState"]>["document"] | undefined;
  let lastMarkers = "";
  function refresh() {
    const settings = store.getState().document.animation ?? defaultAnimation();
    const turntable = mode.value === "turntable";
    slider.min = turntable ? 0 : settings.start;
    slider.max = turntable ? 12 : settings.end;
    slider.step = turntable ? 0.01 : 1;
    slider.label = turntable ? "Turntable time in seconds" : "Animation frame";
    for (const key of ["start", "end", "fps"] as const) if (document.activeElement !== get(key)) get(key).value = String(settings[key]);
    if (document.activeElement !== get("frame")) get("frame").value = String(Math.round(options.getFrame()));
    get("loop").checked = settings.loop;
    for (const input of Array.from(tools.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"))) input.disabled = !options.available() || turntable;
    mode.disabled = !options.available();
    const markerState = `${turntable}/${options.getSelection().join(",")}`;
    const doc = store.getState().document;
    if (lastDocument === doc && markerState === lastMarkers) return;
    lastDocument = doc; lastMarkers = markerState;
    const ticks = host.querySelector(".ticks")!;
    ticks.replaceChildren(...Array.from({ length: 5 }, (_, i) => {
      const tick = document.createElement("span");
      tick.textContent = turntable ? `${i * 3}s` : String(Math.round(settings.start + (settings.end - settings.start) * i / 4)); return tick;
    }));
    markers.replaceChildren();
    if (!turntable) {
      const selected = new Set(options.getSelection());
      const frames = new Set(store.getState().document.animation?.tracks.filter(t => selected.has(t.targetId)).flatMap(t => t.keys.map(k => k.time)));
      for (const frame of [...frames].sort((a, b) => a - b)) if (frame >= settings.start && frame <= settings.end) {
        const button = document.createElement("button"); button.type = "button";
        button.title = `Go to key at frame ${frame}`; button.setAttribute("aria-label", button.title);
        button.style.left = `${100 * (frame - settings.start) / Math.max(1, settings.end - settings.start)}%`;
        button.onclick = () => run(() => options.setFrame(frame)); markers.append(button);
      }
    }
  }
  return { refresh, get autoKey() { return get("auto").checked && mode.value === "animation"; }, get turntable() { return mode.value === "turntable"; } };
}
