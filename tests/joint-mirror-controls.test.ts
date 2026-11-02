import { expect, it } from "vitest";
import { bindJointMirrorControls } from "../src/joint-mirror-panel.ts";

class RigControl extends EventTarget {
  disabled = true;
  title = "Mirror joints — not implemented yet";
  click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
}

it("enables both menu and detached palette mirror controls without duplicate handlers", () => {
  const menu = new RigControl(), palette = new RigControl();
  let opened = 0;
  bindJointMirrorControls([menu, palette, menu], () => { opened++; });
  expect(menu.disabled).toBe(false);
  expect(palette.disabled).toBe(false);
  expect(menu.title).not.toContain("not implemented");
  menu.click();
  expect(opened).toBe(1);
  palette.click();
  expect(opened).toBe(2);
});
