import type { SplatSelectionDepth, SplatSelectionOperation } from "./splat-component-selection.ts";
import { SPLAT_EDIT_LABELS, type SplatEditAction } from "./splat-component-edits.ts";
import { propertyInteraction } from "./property-interaction.ts";
import { MAX_SPLAT_BRUSH_RADIUS, type SplatBrushSettings, type SplatSelectionTool } from "./splat-selection-gestures.ts";

export function createSplatComponentPanel(actions: { enter: () => void; exit: () => void; select: (action: "all" | "none" | "invert") => void; depth: (value: SplatSelectionDepth) => void; cancel: () => void;
  tool: (tool: SplatSelectionTool) => void; brush: (change: Partial<SplatBrushSettings>) => void; edit: (action: SplatEditAction) => void }) {
  const element = document.createElement("section"); element.className = "panel-content splat-component-panel";

  element.setAttribute("aria-label", "Splat Components");
  element.innerHTML = `<strong>Splat Components</strong><div role="status" aria-live="polite" data-status></div><div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" data-enter>Component mode · F8</button><button type="button" data-exit>Object mode</button></div><label>Selection depth <select aria-label="Splat selection depth"><option value="through">Through</option><option value="front-centers">Front centers (approximate)</option></select></label><div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" data-select="all">All</button><button type="button" data-select="none">None</button><button type="button" data-select="invert">Invert</button><button type="button" data-cancel>Cancel scan</button></div><p>Click or drag a box. Shift toggles · Ctrl subtracts · Ctrl+Shift adds. Esc cancels a gesture or scan; F8 returns to Object mode.</p><details><summary>Selection behavior and limits</summary><p>Centers above the opacity threshold are selectable. Front centers keeps the nearest center in each 4 px cell of this object; it does not test Gaussian alpha, other objects or elastic fill. Highlights show selected centers through surfaces. Maximum 1,000,000 selected IDs. At most 20,000 evenly sampled center markers; the selected count and operations always include every selected ID. Excess selections leave the previous selection unchanged.</p></details>`;
  const style = document.createElement("style");
  const edits = document.createElement("fieldset"); edits.className = "splat-edit-actions";
  edits.innerHTML = `<legend>Component Edits</legend><div data-edit-status role="status" aria-live="polite"></div><div class="splat-edit-buttons">
    <button type="button" data-edit="hide" title="Hide selected splats (H)">${SPLAT_EDIT_LABELS.hide}</button>
    <button type="button" data-edit="show" title="Show all hidden splats in this object (Shift+H)">${SPLAT_EDIT_LABELS.show}</button>
    <button type="button" data-edit="delete" title="Delete selected splats (Delete)">${SPLAT_EDIT_LABELS.delete}</button>
    <button type="button" data-edit="restore" title="Restore all deleted splats in this object">${SPLAT_EDIT_LABELS.restore}</button>
  </div>`;
  element.insertBefore(edits, element.querySelector("details"));
  style.textContent = `.splat-component-panel{height:100%;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;font-size:12px;color:var(--text);background:var(--panel)}
  .splat-component-panel p{color:var(--muted);line-height:1.5;margin:0}.splat-component-panel button,.splat-component-panel select{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0}
  .splat-component-panel label{display:grid;gap:5px}.splat-component-panel select{width:100%}.splat-component-panel button{cursor:pointer}.splat-component-panel button:hover:not(:disabled){background:var(--hover)}
  .splat-component-panel :disabled{opacity:.45;cursor:default}.splat-component-panel :focus-visible{outline:1px solid var(--strong)}.splat-component-panel summary{cursor:pointer;color:var(--muted)}.splat-component-panel details p{margin-top:8px}
  .splat-edit-actions{border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0;margin:0}.splat-edit-actions legend{color:var(--muted)}
  .splat-edit-buttons{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  .splat-brush-settings{min-width:0;margin:0;padding:8px;border:1px solid var(--line);border-radius:3px}
  .splat-brush-settings:not([hidden]){display:grid;gap:8px}.splat-brush-settings label{grid-template-columns:minmax(0,1fr) 5em;align-items:center}
  .splat-brush-settings label:first-of-type{grid-template-columns:minmax(0,1fr) minmax(6em,1fr)}
  .splat-brush-settings input[type=number]{width:100%;min-width:0;text-align:right;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px}`;
  element.prepend(style);
  element.querySelector("[data-enter]")!.addEventListener("click", actions.enter);
  element.querySelector("[data-exit]")!.addEventListener("click", actions.exit);
  element.querySelector("[data-cancel]")!.addEventListener("click", actions.cancel);
  for (const button of Array.from(element.querySelectorAll<HTMLButtonElement>("[data-select]"))) button.addEventListener("click", () => actions.select(button.dataset.select as "all" | "none" | "invert"));
  const editButtons = Array.from(edits.querySelectorAll<HTMLButtonElement>("[data-edit]"));
  for (const button of editButtons) button.addEventListener("click", () => actions.edit(button.dataset.edit as SplatEditAction));
  const depth = element.querySelector<HTMLSelectElement>('[aria-label="Splat selection depth"]')!;
  depth.addEventListener("change", () => actions.depth(depth.value as SplatSelectionDepth));
  const gestureSettings = document.createElement("div");
  gestureSettings.style.display = "grid";
  gestureSettings.style.gap = "8px";
  gestureSettings.innerHTML = `<label>Selection tool <select aria-label="Splat selection tool"><option value="box">Click / Box (Q)</option><option value="lasso">Lasso</option><option value="paint">Paint Selection</option></select></label>
    <fieldset class="splat-brush-settings" hidden><legend>Brush settings</legend>
      <label>Operation <select aria-label="Splat brush operation"><option value="add">Add</option><option value="replace">Replace</option><option value="subtract">Subtract</option><option value="toggle">Toggle</option></select></label>
      <label>Radius (px) <input aria-label="Splat brush radius in pixels" type="number" min="1" max="${MAX_SPLAT_BRUSH_RADIUS}" step="1"></label>
      <label>Spacing (px) <input aria-label="Splat brush spacing in pixels" type="number" min="1" step="1"></label>
      <p>Hold B and drag horizontally in the viewport to resize the brush.</p>
    </fieldset>`;
  depth.closest("label")!.before(gestureSettings);
  const tool = gestureSettings.querySelector<HTMLSelectElement>('[aria-label="Splat selection tool"]')!;
  const operation = gestureSettings.querySelector<HTMLSelectElement>('[aria-label="Splat brush operation"]')!;
  const settings = gestureSettings.querySelector("fieldset")!;
  const radius = settings.querySelector<HTMLInputElement>('[aria-label="Splat brush radius in pixels"]')!;
  const spacing = settings.querySelector<HTMLInputElement>('[aria-label="Splat brush spacing in pixels"]')!;
  const guide = element.querySelector(":scope > p")!;
  const guides: Record<SplatSelectionTool, string> = {
    box: "Click a center or drag a box.",
    lasso: "Draw a closed freehand region. The outline connects the last point to the first.",
    paint: "Paint over splat centers. The current brush operation applies once per stroke.",
  };
  const modifierGuide = "Shift toggles · Ctrl/Command subtracts · Ctrl/Command+Shift adds. Esc cancels · F8 exits.";
  tool.addEventListener("change", () => actions.tool(tool.value as SplatSelectionTool));
  operation.addEventListener("change", () => actions.brush({ operation: operation.value as SplatSelectionOperation }));
  let lastBrush: SplatBrushSettings;
  for (const [key, input] of [["radius", radius], ["spacing", spacing]] as const) {
    input.addEventListener("pointerdown", event => { if (event.button === 1 && !input.disabled && !input.readOnly) input.focus(); });
    propertyInteraction(input, () => `splat-selection-${key}`);
    input.addEventListener("change", () => {
      if (input.value && input.checkValidity() && !input.readOnly) actions.brush({ [key]: input.valueAsNumber });
      input.value = String(lastBrush[key]);
    });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") input.value = String(lastBrush[key]);
      input.blur();
    });
  }
  let lastStatus = "", lastEditStatus = "";
  return { element, radiusLocked: () => radius.readOnly, update(name: string | undefined, count: number, total: number, activity: string | undefined, available: boolean,
    activeTool: SplatSelectionTool, brush: SplatBrushSettings, removed: { hidden: number; deleted: number }) {
    const busy = activity !== undefined;
    const status = name ? `${name} · ${count.toLocaleString()} / ${total.toLocaleString()} original splats selected${count > 20_000 ? " · 20,000 sampled highlights" : ""}${activity ? ` · ${activity}` : ""}` : "Object mode. Select one splat object, then enter Component mode.";
    if (status !== lastStatus) { element.querySelector("[data-status]")!.textContent = status; lastStatus = status; }
    const editStatus = name ? `${total.toLocaleString()} active · ${removed.hidden.toLocaleString()} hidden · ${removed.deleted.toLocaleString()} deleted` : "Enter component mode to edit splats.";
    if (editStatus !== lastEditStatus) { edits.querySelector("[data-edit-status]")!.textContent = editStatus; lastEditStatus = editStatus; }
    for (const button of editButtons) button.disabled = !name || busy || !available ||
      !(button.dataset.edit === "show" ? removed.hidden : button.dataset.edit === "restore" ? removed.deleted : count);
    element.querySelector<HTMLButtonElement>("[data-enter]")!.disabled = !!name || !available;
    element.querySelector<HTMLButtonElement>("[data-exit]")!.disabled = !name;
    const cancel = element.querySelector<HTMLButtonElement>("[data-cancel]")!;
    cancel.disabled = !busy;
    const cancelLabel = busy && activity !== "Scanning…" ? "Cancel gesture" : "Cancel scan";
    if (cancel.textContent !== cancelLabel) cancel.textContent = cancelLabel;
    for (const button of Array.from(element.querySelectorAll<HTMLButtonElement>("[data-select]"))) button.disabled = !name || busy || !available;
    lastBrush = brush;
    tool.disabled = !name || !available;
    tool.value = activeTool;
    settings.hidden = activeTool !== "paint";
    for (const input of [operation, radius, spacing]) input.disabled = !name || !available || busy;
    operation.value = brush.operation;
    spacing.max = String(brush.radius);
    if (document.activeElement !== radius) radius.value = String(brush.radius);
    if (document.activeElement !== spacing) spacing.value = String(brush.spacing);
    const help = `${guides[activeTool]} ${modifierGuide}`;
    if (guide.textContent !== help) guide.textContent = help;
  } };
}
