import { setKeys, type AnimationChannel, type AnimationPose } from "./animation.ts";
import type { SceneStore } from "./scene-store.ts";
import "./channel-animation-controls.css";

type ChannelOptions = {
  getFrame: () => number;
  getSelection: () => string[];
  getPose: (id: string) => AnimationPose;
  available: () => boolean;
};
type KeyControl = { button: HTMLButtonElement; channel: AnimationChannel; label: string };

/** Small per-channel commands appended to the existing Channel Box, with stable DOM. */
export function mountChannelKeyControls(host: HTMLElement, store: SceneStore, options: ChannelOptions) {
  const fields = host.querySelector<HTMLElement>("#properties-fields");
  if (!fields) throw Error("Create the Properties panel before mounting channel key controls.");
  const controls: KeyControl[] = [];
  const status = document.createElement("p"); status.className = "channel-key-status";
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const visibilityRow = document.createElement("div"); visibilityRow.className = "channel-visibility-control";
  const visibilityLabel = document.createElement("label"), visibility = document.createElement("input");
  visibility.type = "checkbox"; visibility.checked = true;
  visibilityLabel.append(visibility, "Visible (key at current frame)"); visibilityRow.append(visibilityLabel);
  const legend = document.createElement("p"); legend.className = "channel-key-legend";
  legend.textContent = "◇ No curve · ◆ Animated · gold ◆ Key at this frame";
  const channelFields = fields.querySelector(".channel-fields")!;
  channelFields.after(visibilityRow, legend, status);
  let previousSelection = "", feedback = "", error = false;

  function selection() {
    const ids = Array.from(new Set(options.getSelection()));
    if (ids.length !== 1) return undefined;
    const doc = store.getState().document, id = ids[0];
    return doc.nodes[id]?.type === "transform" || doc.joints?.some(joint => joint.id === id) ? id : undefined;
  }
  function blocked(id: string | undefined, channel: AnimationChannel): string | undefined {
    if (!id) return "Select one object or joint to key a channel.";
    if (!options.available()) return "Finish the current operation before setting a key.";
    const doc = store.getState().document;
    if (doc.drivenKeys?.some(relation => relation.driven.targetId === id && relation.driven.channel === channel))
      return "This channel is controlled by Set Driven Key. Edit its driver or remove the driven relationship before setting time keys.";
    if (channel.startsWith("scale.") && doc.joints?.some(joint => joint.id === id)) return "Joint scale animation is not supported.";
    return undefined;
  }
  function run(channel: AnimationChannel, label: string, visible?: boolean) {
    const id = selection(), reason = blocked(id, channel);
    if (reason) { feedback = reason; error = true; refresh(); return; }
    try {
      const frame = Math.round(options.getFrame()), pose = options.getPose(id!);
      const keyedPose = visible === undefined ? pose : { ...pose, visibility: visible ? 1 : 0 };
      setKeys(store, [id!], frame, new Map([[id!, keyedPose]]), [channel]);
      feedback = `Keyed ${label} at frame ${frame}.`; error = false;
    } catch (failure) { feedback = failure instanceof Error ? failure.message : String(failure); error = true; }
    refresh();
  }
  function addButton(parent: HTMLElement, channel: AnimationChannel, label: string) {
    const button = document.createElement("button"); button.type = "button"; button.className = "channel-key-button";
    button.setAttribute("aria-label", `Key ${label}`); button.textContent = "◇";
    button.onclick = () => run(channel, label);
    parent.append(button); controls.push({ button, channel, label });
  }
  for (const input of Array.from(host.querySelectorAll<HTMLElement>(".property-axis-row wa-input[data-channel][data-axis]"))) {
    const property = input.dataset.channel!, axis = Number(input.dataset.axis);
    if (!["position", "rotation", "scale"].includes(property) || ![0, 1, 2].includes(axis)) continue;
    const row = input.closest<HTMLElement>(".property-axis-row")!; row.classList.add("channel-key-row");
    addButton(row, `${property}.${"xyz"[axis]}` as AnimationChannel, `${property[0].toUpperCase()}${property.slice(1)} ${"XYZ"[axis]}`);
  }
  addButton(visibilityRow, "visibility", "Visibility");
  visibility.onchange = () => run("visibility", "Visibility", visibility.checked);

  function refresh() {
    const id = selection(), signature = options.getSelection().join("|");
    if (previousSelection !== signature) { feedback = ""; error = false; previousSelection = signature; }
    const doc = store.getState().document, frame = Math.round(options.getFrame());
    for (const { button, channel, label } of controls) {
      const reason = blocked(id, channel), track = doc.animation?.tracks.find(item => item.targetId === id && item.channel === channel);
      const keyed = track?.keys.some(key => key.time === frame), animated = !!track?.keys.length;
      const driven = doc.drivenKeys?.some(relation => relation.driven.targetId === id && relation.driven.channel === channel);
      const state = driven ? "driven" : keyed ? "keyed" : animated ? "animated" : "unanimated";
      button.disabled = !!reason; button.dataset.keyState = state;
      button.textContent = animated ? "◆" : "◇";
      button.title = reason ?? `${label}: ${keyed ? `key at frame ${frame}` : animated ? "animated; no key at this frame" : "no animation curve"}. Click to set a key at frame ${frame}.`;
    }
    visibility.disabled = !!blocked(id, "visibility");
    visibility.title = blocked(id, "visibility") ?? `Changing this checkbox creates a visibility key at frame ${frame}. Use its diamond to key the current value.`;
    if (id) {
      try { visibility.checked = options.getPose(id).visibility >= .5; }
      catch { visibility.disabled = true; }
    } else visibility.checked = true;
    const drivenChannels = doc.drivenKeys?.filter(relation => relation.driven.targetId === id).length ?? 0;
    status.textContent = feedback || (drivenChannels ? "Driven channels are disabled here. Edit their relationships in Set Driven Key." : "");
    status.dataset.error = String(error);
  }
  refresh();
  return { refresh };
}
