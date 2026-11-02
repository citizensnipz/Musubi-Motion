import { buttonContent, icon, type IconName } from "./ui.ts";
import { mountToolPalette } from "./tool-palette.ts";

const groups: { title: string; tools: [string, IconName][] }[] = [
  { title: "Deformation", tools: [["Elasticity", "scale"]] },
  { title: "Skeleton", tools: [["Create joints", "joint"], ["Parent joints", "chain"], ["Mirror joints", "mirror"]] },
  { title: "Binding & weights", tools: [["Bind splats", "bind"], ["Unbind splats", "unbind"], ["Automatic weights", "weight"], ["Paint weights", "paint"]] },
  { title: "FK / IK", tools: [["FK rotate", "rotate"], ["Create IK chain", "chain"], ["Move IK target", "target"], ["Pole target", "pin"], ["Joint limits", "limits"], ["IK / FK blend", "scale"]] },
  { title: "Pose", tools: [["Set rest pose", "joint"], ["Reset pose", "rest"], ["Keyframe pose", "key"]] },
];

export function createRiggingPanel() {
  const panel = document.createElement("section");
  panel.id = "rigging-panel";
  panel.setAttribute("aria-label", "Rigging tools");
  panel.innerHTML = `
    <button id="rigging-drag" class="palette-grip" aria-label="Move rigging panel" aria-disabled="true" title="Unlock to move rigging panel"></button>
    <div class="rigging-heading"><strong>Rigging</strong>
      <wa-button id="rigging-mode" size="s" appearance="plain" variant="neutral"></wa-button>
    </div>
    <p class="rigging-status">Rigging tools are not implemented yet.</p>
    <div class="rigging-tools"></div>
    <wa-button id="rigging-lock" size="s" appearance="plain" variant="neutral" aria-label="Unlock rigging panel" aria-pressed="true" title="Lock / unlock panel position"></wa-button>`;
  panel.querySelector("#rigging-drag")!.append(icon("grip"));
  buttonContent(panel.querySelector("#rigging-lock")!, "lock");
  const menu = document.getElementById("rigging-menu")!;
  for (const group of groups) {
    const heading = document.createElement("div");
    heading.className = "rigging-menu-heading";
    heading.textContent = group.title;
    menu.append(heading);
    const section = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = group.title;
    section.append(legend);
    for (const [label, name] of group.tools) {
      const item = document.createElement("wa-dropdown-item");
      item.disabled = true;
      item.dataset.rigAction = label;
      item.title = `${label} — not implemented yet`;
      const glyph = document.createElement("span");
      glyph.slot = "icon";
      glyph.append(icon(name));
      item.append(glyph, label);
      menu.append(item);
      const button = document.createElement("wa-button");
      button.size = "s";
      button.appearance = "plain";
      button.variant = "neutral";
      button.disabled = true;
      button.dataset.rigAction = label;
      button.setAttribute("aria-label", label);
      button.title = `${label} — not implemented yet`;
      buttonContent(button, name, label);
      section.append(button);
    }
    panel.querySelector(".rigging-tools")!.append(section);
  }
  return panel;
}

export function mountRiggingPanel(panel: HTMLElement, workspace: { showRigging(): void; hideRigging(): void }) {
  const viewport = document.getElementById("viewport")!;
  const mode = panel.querySelector<HTMLElement>("#rigging-mode")!;
  let floating = false;
  let mounted = false;
  function updateMode() {
    const label = floating ? "Dock rigging panel" : "Switch to mini rigging panel";
    buttonContent(mode, "sidebar");
    mode.setAttribute("aria-label", label);
    mode.title = label;
  }
  function show() {
    if (floating) {
      mode.focus();
      panel.animate([{ outline: "1px solid var(--text)" }, { outline: "1px solid transparent" }], { duration: 600 });
    } else workspace.showRigging();
  }
  document.getElementById("rigging-open")!.addEventListener("click", show);
  mode.addEventListener("click", () => {
    floating = !floating;
    panel.classList.toggle("rigging-mini", floating);
    if (floating) {
      workspace.hideRigging();
      viewport.append(panel);
      if (!mounted) {
        mountToolPalette({ panel: panel.id, handle: "rigging-drag", lock: "rigging-lock" }, "rigging panel");
        mounted = true;
      }
    } else workspace.showRigging();
    updateMode();
    mode.focus();
  });
  updateMode();
}
