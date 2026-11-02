import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/details/details.js";
import "@awesome.me/webawesome/dist/components/slider/slider.js";
import "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import {
  createElement,
  type IconNode,
  MousePointer2,
  Move,
  Rotate3d,
  Scaling,
  Undo2,
  Redo2,
  Pause,
  SkipBack,
  Sun,
  Moon,
  Upload,
  Plus,
  FilePlus,
  FolderOpen,
  Save,
  Copy,
  Box,
  Scan,
  ChevronDown,
  GripHorizontal,
  LockKeyhole,
  LockKeyholeOpen,
  PanelLeft,
  Link,
  Unlink,
  Paintbrush,
  Weight,
  Target,
  GitBranch,
  FlipHorizontal2,
  Pin,
  SlidersHorizontal,
  KeyRound,
  RotateCcw,
  Grid2x2,
  House,
} from "lucide";

// The two limbs meet at a 75° angle, with a larger circle marking the pivot.
const Joint: IconNode = [
  ["path", { d: "M8 13V6.25M10.898 15.224l6.52-1.747" }],
  ["circle", { cx: "8", cy: "16", r: "3" }],
  ["circle", { cx: "8", cy: "5", r: "1.25" }],
  ["circle", { cx: "18.625", cy: "13.153", r: "1.25" }],
];

const PlayTriangle: IconNode = [
  ["path", { d: "M6 4L20 12L6 20Z", fill: "currentColor", stroke: "none" }],
];
const PreviousKey: IconNode = [
  ...SkipBack,
  ["rect", { x: "1", y: "8", width: "4", height: "8", fill: "currentColor", stroke: "none" }],
];
const TimelineStart: IconNode = [
  ["path", { d: "M3 4v16M13 5l-8 7 8 7ZM22 5l-8 7 8 7Z" }],
];

const icons = {
  select: MousePointer2,
  translate: Move,
  rotate: Rotate3d,
  scale: Scaling,
  undo: Undo2,
  redo: Redo2,
  play: PlayTriangle,
  pause: Pause,
  rewind: SkipBack,
  previousKey: PreviousKey,
  timelineStart: TimelineStart,
  sun: Sun,
  moon: Moon,
  import: Upload,
  add: Plus,
  new: FilePlus,
  open: FolderOpen,
  save: Save,
  saveAs: Copy,
  object: Box,
  fit: Scan,
  chevron: ChevronDown,
  grip: GripHorizontal,
  lock: LockKeyhole,
  unlock: LockKeyholeOpen,
  sidebar: PanelLeft,
  joint: Joint,
  bind: Link,
  unbind: Unlink,
  paint: Paintbrush,
  weight: Weight,
  target: Target,
  chain: GitBranch,
  mirror: FlipHorizontal2,
  pin: Pin,
  limits: SlidersHorizontal,
  key: KeyRound,
  rest: RotateCcw,
  grid: Grid2x2,
  home: House,
};
export type IconName = keyof typeof icons;
export function icon(name: IconName) {
  const svg = createElement(icons[name], {
    width: 16,
    height: 16,
    "stroke-width": 1.6,
    "aria-hidden": "true",
    focusable: "false",
  });
  return svg;
}
export function buttonContent(
  button: HTMLElement,
  name: IconName,
  text?: string,
) {
  button.replaceChildren(icon(name));
  if (text) {
    const span = document.createElement("span");
    span.textContent = text;
    button.append(span);
  }
}
export function hydrateIcons() {
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((host) => {
    host.replaceChildren(icon(host.dataset.icon as IconName));
  });
}
export function isEditing(event: KeyboardEvent) {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof HTMLElement &&
        (target.matches("input,textarea,select,wa-input,wa-slider") ||
          target.isContentEditable),
    );
}
export function blurEditor() {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.matches("input,wa-input"))
    focused.blur();
}
export function dialogOpen() {
  return Array.from(document.querySelectorAll("wa-dialog")).some(
    (dialog) => dialog.open,
  );
}
export function askDiscard(): Promise<boolean> {
  const dialog = document.querySelector<WaDialog>("wa-dialog#discard-dialog")!;
  return new Promise((resolve) => {
    let discard = false;
    const accept = () => {
      discard = true;
      dialog.open = false;
    };
    const cancel = () => {
      dialog.open = false;
    };
    const done = () => {
      dialog
        .querySelector("#discard-confirm")!
        .removeEventListener("click", accept);
      dialog
        .querySelector("#discard-cancel")!
        .removeEventListener("click", cancel);
      resolve(discard);
    };
    dialog.querySelector("#discard-confirm")!.addEventListener("click", accept);
    dialog.querySelector("#discard-cancel")!.addEventListener("click", cancel);
    dialog.addEventListener("wa-after-hide", done, { once: true });
    dialog.open = true;
  });
}
export function askFilename(name: string): Promise<string | null> {
  const dialog = document.querySelector<WaDialog>("wa-dialog#filename-dialog")!;
  const input = dialog.querySelector("wa-input")!;
  input.value = name;
  return new Promise((resolve) => {
    let result: string | null = null;
    const accept = () => {
      if (!input.value?.trim()) {
        input.focus();
        return;
      }
      result = input.value;
      dialog.open = false;
    };
    const cancel = () => {
      dialog.open = false;
    };
    const enter = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        accept();
      }
    };
    const done = () => {
      dialog
        .querySelector("#filename-save")!
        .removeEventListener("click", accept);
      dialog
        .querySelector("#filename-cancel")!
        .removeEventListener("click", cancel);
      input.removeEventListener("keydown", enter);
      resolve(result);
    };
    dialog.querySelector("#filename-save")!.addEventListener("click", accept);
    dialog.querySelector("#filename-cancel")!.addEventListener("click", cancel);
    input.addEventListener("keydown", enter);
    dialog.addEventListener("wa-after-hide", done, { once: true });
    dialog.addEventListener(
      "wa-after-show",
      () => {
        input.focus();
        input.select();
      },
      { once: true },
    );
    dialog.open = true;
  });
}
