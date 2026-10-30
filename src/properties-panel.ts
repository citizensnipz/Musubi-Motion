import type { TransformChannels, TransformNode } from "./scene-document.ts";
import type WaInput from "@awesome.me/webawesome/dist/components/input/input.js";
import { icon } from "./ui.ts";

export function createPropertiesPanel(
  host: HTMLElement,
  outlinerHost: HTMLElement,
  handlers: {
    select: (id: string, additive: boolean) => void;
    rename: (id: string, name: string) => void;
    channel: (
      id: string,
      channel: keyof TransformChannels,
      axis: number,
      value: number,
    ) => void;
  },
) {
  outlinerHost.innerHTML =
    '<div class="panel-heading"><span>Scene objects</span><span id="object-count">0 objects</span></div><div id="outliner" role="group" aria-label="Scene objects"></div>';
  host.innerHTML = `<div class="panel-heading"><span>Transform</span><span>Local</span></div><p id="properties-empty">Select an object to inspect its properties.</p>
  <div id="properties-fields" hidden><wa-input id="object-name" label="Name" size="s" maxlength="80" autocomplete="off" spellcheck="false"></wa-input><div class="channel-fields"></div>
  <p class="property-note">Rotation in degrees · XYZ order</p><wa-details class="node-details" summary="Object details"><dl><dt>Type</dt><dd>Transform / Gaussian splat shape</dd><dt>ID</dt><dd id="object-id"></dd><dt>Shape</dt><dd id="object-shape"></dd></dl></wa-details></div>`;
  const outliner = outlinerHost.querySelector<HTMLDivElement>("#outliner")!,
    empty = host.querySelector<HTMLElement>("#properties-empty")!,
    fields = host.querySelector<HTMLElement>("#properties-fields")!,
    name = host.querySelector<WaInput>("#object-name")!;
  let activeId: string | undefined;
  const inputs: Array<{
    input: WaInput;
    channel: keyof TransformChannels;
    axis: number;
  }> = [];
  for (const channel of ["position", "rotation", "scale"] as const) {
    const group = document.createElement("fieldset"),
      legend = document.createElement("legend");
    legend.textContent = channel[0].toUpperCase() + channel.slice(1);
    group.append(legend);
    for (const [axis, letter] of ["X", "Y", "Z"].entries()) {
      const input = document.createElement("wa-input");
      input.type = "number";
      input.size = "s";
      input.withoutSpinButtons = true;
      input.step = channel === "rotation" ? 1 : 0.1;
      if (channel === "scale") input.min = 0.001;
      input.label = `${legend.textContent} ${letter}`;
      // A short visible axis label and a full accessible label share the same label slot.
      const label = document.createElement("span");
      label.slot = "label";
      label.innerHTML = `<span aria-hidden="true">${letter}</span><span class="sr-only">${legend.textContent} ${letter}</span>`;
      input.append(label);
      input.dataset.channel = channel;
      input.dataset.axis = String(axis);
      input.addEventListener("change", () => {
        if (
          activeId &&
          input.value !== null &&
          input.value.trim() !== "" &&
          Number.isFinite(Number(input.value))
        )
          handlers.channel(activeId, channel, axis, Number(input.value));
        input.blur();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        }
      });
      inputs.push({ input, channel, axis });
      group.append(input);
    }
    host.querySelector(".channel-fields")!.append(group);
  }
  name.addEventListener("change", () => {
    if (activeId) handlers.rename(activeId, name.value ?? "");
    name.blur();
  });
  name.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      name.blur();
    }
  });
  let lastList = "";
  return {
    update(
      nodes: TransformNode[],
      selected: Set<string>,
      shapeName: string | undefined,
      preview?: TransformChannels,
    ) {
      const single =
        selected.size === 1 ? nodes.find((n) => selected.has(n.id)) : undefined;
      activeId = single?.id;
      const listKey = JSON.stringify(
        nodes.map((n) => [n.id, n.name, selected.has(n.id)]),
      );
      if (lastList !== listKey) {
        lastList = listKey;
        outliner.replaceChildren();
        for (const node of nodes) {
          const button = document.createElement("wa-button");
          button.size = "s";
          button.appearance = "plain";
          button.variant = "neutral";
          button.className = "object-row";
          button.dataset.objectId = node.id;
          button.setAttribute("aria-pressed", String(selected.has(node.id)));
          const symbol = document.createElement("span");
          symbol.slot = "start";
          symbol.append(icon("object"));
          const label = document.createElement("span");
          label.className = "object-name";
          label.textContent = node.name;
          button.append(symbol, label);
          button.addEventListener("click", (event) =>
            handlers.select(
              node.id,
              event.shiftKey || event.ctrlKey || event.metaKey,
            ),
          );
          outliner.append(button);
        }
      }
      outlinerHost.querySelector("#object-count")!.textContent =
        `${nodes.length} object${nodes.length === 1 ? "" : "s"}`;
      fields.hidden = !single;
      empty.hidden = !!single;
      empty.textContent =
        selected.size > 1
          ? `${selected.size} objects selected. Select one to edit its local properties.`
          : "Select an object to inspect its properties.";
      if (!single) return;
      if (document.activeElement !== name) name.value = single.name;
      const channels = preview ?? single;
      for (const { input, channel, axis } of inputs)
        if (document.activeElement !== input)
          input.value = String(Number(channels[channel][axis].toFixed(5)));
      host.querySelector("#object-id")!.textContent = single.id;
      host.querySelector("#object-shape")!.textContent = shapeName ?? "—";
    },
  };
}
