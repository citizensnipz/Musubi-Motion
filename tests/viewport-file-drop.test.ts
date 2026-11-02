import { expect, it, vi } from "vitest";
import { mountViewportFileDrop } from "../src/viewport-file-drop.ts";

it("accepts files over viewport children, clears nested drag feedback, and prevents navigation outside", () => {
  const windowTarget = new EventTarget(); vi.stubGlobal("window", windowTarget);
  const classes = new Set<string>(), viewport = Object.assign(new EventTarget(), { classList: { add: (s: string) => classes.add(s), remove: (s: string) => classes.delete(s) } });
  const received: File[][] = []; mountViewportFileDrop(viewport as unknown as HTMLElement, files => received.push(files));
  const file = new File(["fbx"], "Dude.FBX");
  const drag = (type: string, files: File[] = [], types = ["Files"]) => {
    const event = new Event(type, { cancelable: true }); Object.assign(event, { dataTransfer: { files, types, dropEffect: "none" } }); return event;
  };
  viewport.dispatchEvent(drag("dragenter")); viewport.dispatchEvent(drag("dragenter")); viewport.dispatchEvent(drag("dragleave"));
  expect(classes.has("file-drop-active")).toBe(true);
  const over = drag("dragover"); viewport.dispatchEvent(over); expect(over.defaultPrevented).toBe(true);
  const drop = drag("drop", [file]); viewport.dispatchEvent(drop);
  expect(drop.defaultPrevented).toBe(true); expect(classes.size).toBe(0); expect(received).toEqual([[file]]);
  const outside = drag("drop", [file]); windowTarget.dispatchEvent(outside); expect(outside.defaultPrevented).toBe(true); expect(received).toHaveLength(1);
  const text = drag("dragover", [], ["text/plain"]); viewport.dispatchEvent(text); expect(text.defaultPrevented).toBe(false);
  vi.unstubAllGlobals();
});
