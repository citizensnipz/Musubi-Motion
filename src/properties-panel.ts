import type { TransformChannels, TransformNode } from "./scene-document.ts";

export function createPropertiesPanel(
  host: HTMLElement,
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
  host.innerHTML = `
    <section class="outliner-section"><div class="panel-heading"><h2>Scene</h2><span id="object-count">0 objects</span></div><div id="outliner" role="group" aria-label="Scene objects"></div></section>
    <section class="properties-section"><div class="panel-heading"><h2>Properties</h2><span>Local</span></div>
    <p id="properties-empty">Select an object to inspect its properties.</p>
    <div id="properties-fields" hidden><label class="name-field">Name<input id="object-name" type="text" maxlength="80" autocomplete="off" spellcheck="false" /></label>
    <div class="channel-fields"></div><p class="property-note">Rotation in degrees · XYZ order</p><details class="node-details"><summary>Object details</summary><dl><dt>Type</dt><dd>Transform / Gaussian splat shape</dd><dt>ID</dt><dd id="object-id"></dd><dt>Shape</dt><dd id="object-shape"></dd></dl></details></div></section>`;
  const outliner = host.querySelector<HTMLDivElement>("#outliner")!;
  const empty = host.querySelector<HTMLParagraphElement>("#properties-empty")!;
  const fields = host.querySelector<HTMLDivElement>("#properties-fields")!;
  const name = host.querySelector<HTMLInputElement>("#object-name")!;
  const inputs: Array<{
    input: HTMLInputElement;
    channel: keyof TransformChannels;
    axis: number;
  }> = [];
  let activeId: string | undefined;
  const channelHost = host.querySelector<HTMLDivElement>(".channel-fields")!;
  for (const channel of ["position", "rotation", "scale"] as const) {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = channel[0].toUpperCase() + channel.slice(1);
    group.append(legend);
    for (const [axis, letter] of ["X", "Y", "Z"].entries()) {
      const label = document.createElement("label");
      label.textContent = letter;
      const input = document.createElement("input");
      input.type = "number";
      input.step = channel === "rotation" ? "1" : "0.1";
      if (channel === "scale") input.min = "0.001";
      input.setAttribute("aria-label", `${legend.textContent} ${letter}`);
      input.dataset.channel = channel;
      input.dataset.axis = String(axis);
      input.addEventListener("change", () => {
        if (!activeId) return;
        if (input.value !== "" && Number.isFinite(input.valueAsNumber)) {
          handlers.channel(activeId, channel, axis, input.valueAsNumber);
        }
        input.blur();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") input.blur();
      });
      label.append(input);
      group.append(label);
      inputs.push({ input, channel, axis });
    }
    channelHost.append(group);
  }
  name.addEventListener("change", () => {
    if (activeId) handlers.rename(activeId, name.value);
    name.blur();
  });
  name.addEventListener("keydown", (event) => {
    if (event.key === "Enter") name.blur();
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
        selected.size === 1
          ? nodes.find((node) => selected.has(node.id))
          : undefined;
      activeId = single?.id;
      const listKey = JSON.stringify(
        nodes.map((node) => [node.id, node.name, selected.has(node.id)]),
      );
      if (listKey !== lastList) {
        lastList = listKey;
        outliner.replaceChildren();
        for (const node of nodes) {
          const button = document.createElement("button");
          button.className = "object-row";
          button.textContent = node.name;
          button.dataset.objectId = node.id;
          button.setAttribute("aria-pressed", String(selected.has(node.id)));
          button.title = `${node.name} — splat transform`;
          button.addEventListener("click", (event) =>
            handlers.select(
              node.id,
              event.shiftKey || event.ctrlKey || event.metaKey,
            ),
          );
          outliner.append(button);
        }
      }
      host.querySelector("#object-count")!.textContent =
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
      for (const { input, channel, axis } of inputs) {
        if (document.activeElement !== input)
          input.value = String(Number(channels[channel][axis].toFixed(5)));
      }
      host.querySelector("#object-id")!.textContent = single.id;
      host.querySelector("#object-shape")!.textContent = shapeName ?? "—";
    },
  };
}
