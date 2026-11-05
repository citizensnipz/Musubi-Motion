import type { SplatSelectionDepth } from "./splat-component-selection.ts";

export function createSplatComponentPanel(actions: { enter: () => void; exit: () => void; select: (action: "all" | "none" | "invert") => void; depth: (value: SplatSelectionDepth) => void; cancel: () => void }) {
  const element = document.createElement("section"); element.className = "panel-content splat-component-panel";

  element.setAttribute("aria-label", "Splat Components");
  element.innerHTML = `<strong>Splat Components</strong><div role="status" aria-live="polite" data-status></div><div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" data-enter>Component mode · F8</button><button type="button" data-exit>Object mode</button></div><label>Selection depth <select aria-label="Splat selection depth"><option value="through">Through</option><option value="front-centers">Front centers (approximate)</option></select></label><div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" data-select="all">All</button><button type="button" data-select="none">None</button><button type="button" data-select="invert">Invert</button><button type="button" data-cancel>Cancel scan</button></div><p>Click or drag a box. Shift toggles · Ctrl subtracts · Ctrl+Shift adds. Esc cancels a gesture or scan; F8 returns to Object mode.</p><details><summary>Selection behavior and limits</summary><p>Centers above the opacity threshold are selectable. Front centers keeps the nearest center in each 4 px cell of this object; it does not test Gaussian alpha, other objects or elastic fill. Highlights show selected centers through surfaces. Maximum 1,000,000 selected IDs. At most 20,000 evenly sampled center markers; the selected count and operations always include every selected ID. Excess selections leave the previous selection unchanged.</p></details>`;
  const style = document.createElement("style");
  style.textContent = `.splat-component-panel{height:100%;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;font-size:12px;color:var(--text);background:var(--panel)}
  .splat-component-panel p{color:var(--muted);line-height:1.5;margin:0}.splat-component-panel button,.splat-component-panel select{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0}
  .splat-component-panel label{display:grid;gap:5px}.splat-component-panel select{width:100%}.splat-component-panel button{cursor:pointer}.splat-component-panel button:hover:not(:disabled){background:var(--hover)}
  .splat-component-panel :disabled{opacity:.45;cursor:default}.splat-component-panel :focus-visible{outline:1px solid var(--strong)}.splat-component-panel summary{cursor:pointer;color:var(--muted)}.splat-component-panel details p{margin-top:8px}`;
  element.prepend(style);
  element.querySelector("[data-enter]")!.addEventListener("click", actions.enter);
  element.querySelector("[data-exit]")!.addEventListener("click", actions.exit);
  element.querySelector("[data-cancel]")!.addEventListener("click", actions.cancel);
  for (const button of Array.from(element.querySelectorAll<HTMLButtonElement>("[data-select]"))) button.addEventListener("click", () => actions.select(button.dataset.select as "all" | "none" | "invert"));
  element.querySelector("select")!.addEventListener("change", event => actions.depth((event.target as HTMLSelectElement).value as SplatSelectionDepth));
  let lastStatus = "";
  return { element, update(name: string | undefined, count: number, total: number, busy: boolean, available: boolean) {
    const status = name ? `${name} · ${count.toLocaleString()} / ${total.toLocaleString()} original splats selected${count > 20_000 ? " · 20,000 sampled highlights" : ""}${busy ? " · Scanning…" : ""}` : "Object mode. Select one splat object, then enter Component mode.";
    if (status !== lastStatus) { element.querySelector("[data-status]")!.textContent = status; lastStatus = status; }
    element.querySelector<HTMLButtonElement>("[data-enter]")!.disabled = !!name || !available;
    element.querySelector<HTMLButtonElement>("[data-exit]")!.disabled = !name;
    element.querySelector<HTMLButtonElement>("[data-cancel]")!.disabled = !busy;
    for (const button of Array.from(element.querySelectorAll<HTMLButtonElement>("[data-select]"))) button.disabled = !name || busy || !available;
  } };
}
