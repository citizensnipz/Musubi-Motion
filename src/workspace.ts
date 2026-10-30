import { createDockview } from "dockview";
import "dockview/dist/styles/dockview.css";

// Keep each existing content element alive, including the WebGL canvas, through layout changes.
export function mountWorkspace() {
  const host = document.getElementById("workspace")!;
  const contents = new Map(
    ["viewport", "outliner-panel", "properties", "timeline-panel"].map((id) => [
      id,
      document.getElementById(id)!,
    ]),
  );
  const api = createDockview(host, {
    theme: { name: "musubi", className: "dockview-theme-musubi", gap: 4 },
    disableFloatingGroups: true,
    disableDnd: false,
    createComponent(options) {
      const element = contents.get(options.name);
      if (!element) throw Error(`Unknown panel: ${options.name}`);
      return { element, init() {} };
    },
    createTabComponent() {
      const element = document.createElement("span");
      element.className = "panel-tab";
      element.title = "Drag to dock beside another panel or combine as tabs";
      return {
        element,
        init(parameters) {
          element.textContent = parameters.title;
        },
      };
    },
  });
  let compact = host.clientWidth < 760;
  let customized = false;
  function arrange() {
    api.clear();
    api.addPanel({
      id: "viewport",
      component: "viewport",
      title: "Viewport",
      tabComponent: "label",
      renderer: "always",
      minimumWidth: 220,
      minimumHeight: 180,
    });
    api.addPanel({
      id: "timeline",
      component: "timeline-panel",
      title: "Timeline",
      tabComponent: "label",
      renderer: "always",
      position: { direction: "below" },
      initialHeight: 112,
      minimumHeight: 98,
      minimumWidth: 220,
    });
    api.addPanel({
      id: "outliner",
      component: "outliner-panel",
      title: "Outliner",
      tabComponent: "label",
      renderer: "always",
      position: {
        referencePanel: "viewport",
        direction: compact ? "below" : "right",
      },
      initialWidth: 290,
      initialHeight: compact ? 260 : 200,
      minimumWidth: 240,
      minimumHeight: 100,
    });
    api.addPanel({
      id: "properties",
      component: "properties",
      title: "Properties",
      tabComponent: "label",
      renderer: "always",
      position: {
        referencePanel: "outliner",
        direction: compact ? "within" : "right",
      },
      minimumWidth: 240,
      minimumHeight: 220,
    });
    api.getPanel("timeline")!.api.setSize({ height: 112 });
    api
      .getPanel("outliner")!
      .api.setSize(compact ? { height: 260 } : { width: 240 });
    if (!compact) api.getPanel("properties")!.api.setSize({ width: 290 });
    api.getPanel(compact ? "properties" : "viewport")!.api.setActive();
  }
  arrange();
  api.onDidMovePanel(() => {
    customized = true;
  });
  new ResizeObserver(() => {
    api.layout(host.clientWidth, host.clientHeight);
    const next = host.clientWidth < 760;
    if (next !== compact) {
      compact = next;
      if (!customized) arrange();
    }
  }).observe(host);
  document.getElementById("panel-staging")!.remove();
  return api;
}
