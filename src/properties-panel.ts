import type { TransformChannels, TransformNode } from "./scene-document.ts";
import type WaInput from "@awesome.me/webawesome/dist/components/input/input.js";
import { icon } from "./ui.ts";
import { propertyInteraction } from "./property-interaction";

export function createPropertiesPanel(
  host: HTMLElement,
  outlinerHost: HTMLElement,
  handlers: {
    reparent: (id: string, parentId: string | null) => void;
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
  const refreshLocks:Array<()=>void>=[];
  refreshLocks.push(propertyInteraction(name,()=>`${activeId}/name`));
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
      label.className = "axis-scrub";
      label.innerHTML = `<span aria-hidden="true">${letter}</span><span class="sr-only">${legend.textContent} ${letter}</span>`;
      const row=document.createElement("div");row.className="property-axis-row";row.append(label,input);
      refreshLocks.push(propertyInteraction(input,()=>`${activeId}/${channel}/${axis}`,label));
      input.dataset.channel = channel;
      input.dataset.axis = String(axis);
      input.addEventListener("change", () => {
        if (
          activeId && !input.readonly &&
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
      group.append(row);
    }
    host.querySelector(".channel-fields")!.append(group);
  }
  name.addEventListener("change", () => {
    if (activeId && !name.readonly) handlers.rename(activeId, name.value ?? "");
    name.blur();
  });
  name.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      name.blur();
    }
  });
  let lastList = "";
  let draggedJoint: string | undefined;
  const drop = (event: DragEvent, parentId: string | null) => {
    if (!draggedJoint) return;
    event.preventDefault(); event.stopPropagation();
    const id = draggedJoint; draggedJoint = undefined;
    handlers.reparent(id, parentId);
  };
  outlinerHost.addEventListener("dragover", event => {
    if (draggedJoint) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }
  });
  outlinerHost.addEventListener("drop", event => drop(event, null));
  const collapsed = new Set<string>();
  return {
    update(
      nodes: (TransformNode & { joint?: boolean; curve?: boolean })[],
      selected: Set<string>,
      shapeName: string | undefined,
      preview?: TransformChannels,
    ) {
      const single =
        selected.size === 1 ? nodes.find((n) => selected.has(n.id)) : undefined;
      activeId = single?.id;
      const listKey = JSON.stringify(
        [nodes.map((n) => [n.id, n.name, n.parentId, n.joint, n.curve]), [...collapsed]],
      );
      if (lastList !== listKey) {
        lastList = listKey;
        outliner.replaceChildren();
        const appendNode = (node: typeof nodes[number], depth: number) => {
          const children = nodes.filter(n => n.parentId === node.id);
          const row = document.createElement("div");
          row.className = "hierarchy-row";
          row.draggable = !!node.joint;
          row.addEventListener("dragstart", event => {
            if (!node.joint) return;
            draggedJoint = node.id;
            event.stopPropagation();
            event.dataTransfer?.setData("text/plain", node.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          });
          row.addEventListener("dragend", () => { draggedJoint = undefined; });
          row.addEventListener("dragover", event => {
            event.stopPropagation();
            if (draggedJoint && node.joint && draggedJoint !== node.id) event.preventDefault();
          });
          row.addEventListener("drop", event => {
            event.stopPropagation();
            if (node.joint) drop(event, node.id);
          });
          row.style.paddingLeft = `${depth * 16}px`;
          const toggle = document.createElement("button");
          toggle.className = "hierarchy-toggle";
          toggle.textContent = children.length ? (collapsed.has(node.id) ? "▸" : "▾") : "";
          toggle.disabled = !children.length;
          toggle.setAttribute("aria-label", `${collapsed.has(node.id) ? "Expand" : "Collapse"} ${node.name}`);
          if (children.length) toggle.setAttribute("aria-expanded", String(!collapsed.has(node.id)));
          toggle.onclick = () => {
            if (collapsed.has(node.id)) collapsed.delete(node.id); else collapsed.add(node.id);
            this.update(nodes, selected, shapeName, preview);
          };
          const button = document.createElement("wa-button");
          button.size = "s";
          button.appearance = "plain";
          button.variant = "neutral";
          button.className = "object-row";
          button.dataset.objectId = node.id;
          button.setAttribute("aria-pressed", String(selected.has(node.id)));
          const symbol = document.createElement("span");
          symbol.slot = "start";
          if(node.curve){
            const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
            svg.setAttribute("viewBox","0 0 16 16");svg.setAttribute("width","16");svg.setAttribute("height","16");svg.setAttribute("aria-hidden","true");
            const path=document.createElementNS("http://www.w3.org/2000/svg","path");
            path.setAttribute("d","M3 11C3 2 13 2 13 11M1.5 9.5h3v3h-3zM11.5 9.5h3v3h-3z");
            path.setAttribute("fill","none");path.setAttribute("stroke","currentColor");path.setAttribute("stroke-width","1.3");svg.append(path);symbol.append(svg);
          }else symbol.append(icon(node.joint ? "bone" : "object"));
          const label = document.createElement("span");
          label.className = "object-name";
          label.textContent = node.name;
          button.append(symbol, label);
          const rename = () => {
            if (row.querySelector("input")) return;
            const input = document.createElement("input");
            input.className = "outliner-rename";
            input.setAttribute("aria-label", `Rename ${node.name}`);
            input.value = node.name; input.maxLength = 80;
            button.hidden = true; row.draggable = false; row.append(input);
            let done = false;
            const finish = (save: boolean) => {
              if (done) return; done = true;
              const value = input.value.trim(); input.remove(); button.hidden = false; row.draggable = !!node.joint;
              if (save && value && value !== node.name) handlers.rename(node.id, value);
            };
            input.addEventListener("keydown", event => {
              event.stopPropagation();
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault(); finish(event.key === "Enter"); button.focus();
              }
            });
            input.addEventListener("blur", () => finish(true));
            input.focus(); input.select();
          };
          button.addEventListener("dblclick", event => { event.preventDefault(); rename(); });
          button.addEventListener("keydown", event => {
            if (event.key === "F2") { event.preventDefault(); event.stopPropagation(); rename(); }
          });
          button.addEventListener("click", (event) =>
            handlers.select(
              node.id,
              event.shiftKey || event.ctrlKey || event.metaKey,
            ),
          );
          row.append(toggle, button); outliner.append(row);
          if (!collapsed.has(node.id)) for (const child of children) appendNode(child, depth + 1);
        };
        for (const node of nodes.filter(n => !n.parentId)) appendNode(node, 0);
      }
      outliner.querySelectorAll<HTMLElement>("[data-object-id]").forEach(button => {
        button.setAttribute("aria-pressed", String(selected.has(button.dataset.objectId!)));
      });
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
      refreshLocks.forEach(refresh=>refresh());
      for (const { input, channel, axis } of inputs)
      {
        input.disabled = !!single.joint && channel === "scale";
        if (document.activeElement !== input)
          input.value = String(Number(channels[channel][axis].toFixed(5)));
      }
      host.querySelector("#object-id")!.textContent = single.id;
      host.querySelector("#object-shape")!.textContent = shapeName ?? "—";
      host.querySelector(".node-details dd")!.textContent = single.joint ? "Joint" : single.curve ? "Transform / NURBS curve shape" : "Transform / Gaussian splat shape";
    },
  };
}
