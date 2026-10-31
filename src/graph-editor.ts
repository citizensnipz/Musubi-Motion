import type { SceneStore } from "./scene-store.ts";
import {
  defaultAnimation, evaluateCurve, tangentSlope, upsertTrack, deleteKeys, moveKeys,
  patchKeys, replaceTracks, copyKeys, pasteKeys,
  validateCurveKeys, scaleKeys, withTangent, insertKey,
} from "./animation.ts";
import type { AnimationTrack, CurveKey, KeyClipboard } from "./animation.ts";
import "./graph-editor.css";

type EditorOptions = {
  getFrame: () => number;
  setFrame: (frame: number) => void;
  getSelection: () => string[];
  available: () => boolean;
};
type View = { minTime: number; maxTime: number; minValue: number; maxValue: number };
type Point = { x: number; y: number };
type Drag = {
  kind: "key" | "tangent" | "pan" | "box" | "scrub";
  start: Point; current: Point; view: View; tracks: AnimationTrack[];
  keyId?: string; side?: "in" | "out"; additive: boolean; sheet: boolean;
};
const SVG_NS = "http://www.w3.org/2000/svg";
const colors = ["#e58a81", "#92c997", "#83aee3", "#d7a0df", "#d9c67e", "#89c8c9"];
function svgElement<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}
function textSvg(x: number, y: number, text: string, className = "animation-axis-label") {
  const node = svgElement("text", { x, y, class: className }); node.textContent = text; return node;
}
function niceStep(span: number, count: number) {
  const raw = Math.max(1e-9, span / count), power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].find(value => value * power >= raw)! * power;
}
function labelValue(value: number) {
  return Math.abs(value) > 1e6 || (value !== 0 && Math.abs(value) < .001) ? value.toExponential(1) : String(Number(value.toFixed(3)));
}
function button(parent: HTMLElement, label: string, action: () => void, title = label) {
  const element = document.createElement("button"); element.type = "button"; element.textContent = label;
  element.title = title; element.onclick = action; parent.append(element); return element;
}
function field(parent: HTMLElement, label: string, value: string, change: (value: number) => void) {
  const wrapper = document.createElement("label"); wrapper.textContent = label;
  const input = document.createElement("input"); input.type = "number"; input.step = "any"; input.value = value;
  input.setAttribute("aria-label", label); input.onchange = () => { if (Number.isFinite(input.valueAsNumber)) change(input.valueAsNumber); };
  wrapper.append(input); parent.append(wrapper); return input;
}

/** Editors share scene commands and key selection. Pointer drags preview locally and commit once. */
export function mountAnimationEditors(store: SceneStore, options: EditorOptions) {
  const graph = document.createElement("section"); graph.className = "animation-editor";
  graph.setAttribute("aria-label", "Animation Graph Editor");
  const dopeSheet = document.createElement("section"); dopeSheet.className = "animation-editor";
  dopeSheet.setAttribute("aria-label", "Animation Dope Sheet");
  const toolbar = document.createElement("div"); toolbar.className = "animation-toolbar"; graph.append(toolbar);
  const keyFields = document.createElement("div"); keyFields.className = "animation-key-fields"; graph.append(keyFields);
  const body = document.createElement("div"); body.className = "animation-graph-body"; graph.append(body);
  const channelList = document.createElement("div"); channelList.className = "animation-channel-list";
  channelList.setAttribute("aria-label", "Animation channels"); body.append(channelList);
  const surface = document.createElement("div"); surface.className = "animation-graph-surface"; body.append(surface);
  const svg = svgElement("svg", { tabindex: 0, role: "application", "aria-label": "Animation curves. Drag keys or tangent handles; drag empty space to box select; wheel to zoom; Alt-drag to pan." }); surface.append(svg);
  const status = document.createElement("div"); status.className = "animation-status"; status.setAttribute("role", "status"); graph.append(status);
  const dopeToolbar = document.createElement("div"); dopeToolbar.className = "animation-toolbar"; dopeSheet.append(dopeToolbar);
  const dopeScroll = document.createElement("div"); dopeScroll.className = "animation-dope-scroll"; dopeSheet.append(dopeScroll);
  const dopeSvg = svgElement("svg", { tabindex: 0, role: "application", "aria-label": "Dope Sheet keys. Shift-click or box select keys across channels; drag to retime." }); dopeScroll.append(dopeSvg);
  const dopeStatus = document.createElement("div"); dopeStatus.className = "animation-status"; dopeStatus.textContent = "Drag keys to retime · Shift-click to add · drag blank rows to box select"; dopeSheet.append(dopeStatus);

  let selected = new Set<string>(), activeTrack = "", selectedObjectsOnly = false;
  let clipboard: KeyClipboard | undefined, previewTracks: AnimationTrack[] | undefined, drag: Drag | undefined;
  let view: View = { minTime: 0, maxTime: 288, minValue: -1, maxValue: 1 };
  let graphWidth = 600, graphHeight = 200, dopeWidth = 800;
  let lastDocument = store.getState().document, lastSelection = "", lastEditorState = "";
  let renderedDocument: typeof lastDocument | undefined;
  const animation = () => store.getState().document.animation ?? defaultAnimation();
  const tracks = () => previewTracks ?? animation().tracks;
  const visibleTracks = () => {
    const objectIds = new Set(options.getSelection());
    return tracks().filter(track => !selectedObjectsOnly || objectIds.has(track.targetId));
  };
  const objectName = (id: string) => {
    const doc = store.getState().document; return doc.nodes[id]?.name ?? doc.joints?.find(j => j.id === id)?.name ?? id;
  };
  const keyEntries = () => tracks().flatMap(track => track.keys.filter(key => selected.has(key.id)).map(key => ({ track, key })));
  const colorFor = (track: AnimationTrack) => colors[Math.max(0, animation().tracks.findIndex(t => t.id === track.id)) % colors.length];
  const plot = (sheet = false) => ({ left: sheet ? 190 : 54, right: (sheet ? dopeWidth : graphWidth) - 16, top: 24, bottom: graphHeight - 30 });
  const x = (time: number, sheet = false) => { const p = plot(sheet); return p.left + (time - view.minTime) / (view.maxTime - view.minTime) * (p.right - p.left); };
  const y = (value: number) => { const p = plot(); return p.bottom - (value - view.minValue) / (view.maxValue - view.minValue) * (p.bottom - p.top); };
  const atTime = (pixel: number, sheet = false) => { const p = plot(sheet); return view.minTime + (pixel - p.left) / (p.right - p.left) * (view.maxTime - view.minTime); };
  const atValue = (pixel: number) => { const p = plot(); return view.minValue + (p.bottom - pixel) / (p.bottom - p.top) * (view.maxValue - view.minValue); };
  const point = (event: PointerEvent | WheelEvent, sheet: boolean): Point => {
    const rect = (sheet ? dopeSvg : svg).getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  function announce(message: string, error = false) {
    status.textContent = message; status.classList.toggle("error", error);
    dopeStatus.textContent = message; dopeStatus.classList.toggle("error", error);
  }
  function edit(action: () => void) {
    if (!options.available()) { announce("Finish the current operation before editing animation.", true); return; }
    try { action(); announce(`${selected.size} key${selected.size === 1 ? "" : "s"} selected · drag keys / handles · wheel zoom · Alt-drag pan`); }
    catch (error) { announce(error instanceof Error ? error.message : String(error), true); }
    refresh();
  }
  function fit(selectionOnly = false) {
    const keys = visibleTracks().flatMap(t => t.keys).filter(key => !selectionOnly || selected.has(key.id));
    const a = animation();
    let minTime = keys.length ? Math.min(...keys.map(k => k.time)) : a.start;
    let maxTime = keys.length ? Math.max(...keys.map(k => k.time)) : a.end;
    let minValue = keys.length ? Math.min(...keys.map(k => k.value)) : -1;
    let maxValue = keys.length ? Math.max(...keys.map(k => k.value)) : 1;
    // Include curve overshoot so Frame All does not clip spline extrema.
    if (!selectionOnly) for (const track of visibleTracks()) for (let i = 0; i < 80; i++) {
      const value = evaluateCurve(track.keys, minTime + (maxTime - minTime) * i / 79);
      if (value !== undefined) { minValue = Math.min(minValue, value); maxValue = Math.max(maxValue, value); }
    }
    const dt = Math.max(5, maxTime - minTime), dv = Math.max(.2, maxValue - minValue);
    view = { minTime: minTime - dt * .08, maxTime: maxTime + dt * .08, minValue: minValue - dv * .15, maxValue: maxValue + dv * .15 };
    refresh();
  }
  function copy() { clipboard = copyKeys(store.getState().document, selected); announce(`Copied ${selected.size} keys. Paste starts at the current frame.`); }
  function paste() { if (clipboard) edit(() => { selected = new Set(pasteKeys(store, clipboard!, Math.round(options.getFrame()))); }); }
  function remove() { edit(() => { deleteKeys(store, selected); selected.clear(); }); }
  function insert(time = Math.round(options.getFrame()), value?: number) {
    const track = animation().tracks.find(t => t.id === activeTrack);
    if (!track) { announce("Set a key in the Timeline first, then select its channel.", true); return; }
    if(value===undefined){
      edit(()=>{selected=new Set([insertKey(store,track.id,time)]);});
      return;
    }
    const existing = track.keys.find(key => key.time === time);
    const key: CurveKey = { id: existing?.id ?? crypto.randomUUID(), time, value, interpolation: existing?.interpolation ?? "bezier", tangentMode: existing?.tangentMode ?? "auto" };
    edit(() => { upsertTrack(store, { ...track, keys: [...track.keys.filter(k => k.time !== time), key].sort((a,b) => a.time-b.time) }); selected = new Set([key.id]); });
  }
  button(toolbar, "Insert key", () => insert(), "Insert a key at the current frame while preserving the curve shape. Double-click the graph to author a different time/value.");
  button(toolbar, "Delete", remove, "Delete selected keys");
  button(toolbar, "Copy", copy); button(toolbar, "Paste", paste);
  button(toolbar, "Frame all", () => fit()); button(toolbar, "Frame selected", () => fit(true));
  const selectionLabel = document.createElement("label"), selectionCheckbox = document.createElement("input");
  selectionCheckbox.type = "checkbox"; selectionLabel.append(selectionCheckbox, "Selected objects"); toolbar.append(selectionLabel);
  selectionCheckbox.onchange = () => { selectedObjectsOnly = selectionCheckbox.checked; refresh(); };
  const interpolation = document.createElement("select"); interpolation.setAttribute("aria-label", "Key interpolation");
  for (const [value, label] of [["bezier", "Bezier"], ["linear", "Linear"], ["step", "Stepped"]]) interpolation.add(new Option(label, value));
  interpolation.onchange = () => edit(() => patchKeys(store, selected, { interpolation: interpolation.value as CurveKey["interpolation"] })); keyFields.append(interpolation);
  const tangents = document.createElement("select"); tangents.setAttribute("aria-label", "Tangent preset");
  for (const value of ["auto", "clamped", "spline", "flat", "fixed"]) tangents.add(new Option(`${value[0].toUpperCase()}${value.slice(1)} tangents`, value));
  tangents.onchange = () => edit(() => {
    if(tangents.value!=="fixed")patchKeys(store, selected, { tangentMode: tangents.value as CurveKey["tangentMode"], interpolation: "bezier" });
    else replaceTracks(store, animation().tracks.map(track=>({...track,keys:track.keys.map((key,index)=>selected.has(key.id)?{...key,tangentMode:"fixed" as const,interpolation:"bezier" as const,inSlope:tangentSlope(track.keys,index,"in"),outSlope:tangentSlope(track.keys,index,"out")}:key)})),"Fix tangent slopes");
  }); keyFields.append(tangents);
  const keyTime = field(keyFields, "Frame", "0", value => edit(() => patchKeys(store, selected, { time: Math.round(value) })));
  const keyValue = field(keyFields, "Value", "0", value => edit(() => patchKeys(store, selected, { value })));
  function setSlope(side:"in"|"out",value:number){
    edit(()=>replaceTracks(store,animation().tracks.map(track=>({...track,keys:track.keys.map((key,index)=>selected.has(key.id)?withTangent(track.keys,index,side,value):key)})),"Edit tangent slope"));
  }
  const inSlope = field(keyFields, "In slope", "0", value => setSlope("in",value));
  const outSlope = field(keyFields, "Out slope", "0", value => setSlope("out",value));
  const brokenLabel = document.createElement("label"), broken = document.createElement("input"); broken.type = "checkbox"; brokenLabel.append(broken, "Break tangents"); keyFields.append(brokenLabel);
  broken.onchange = () => edit(() => {
    const entries = keyEntries();
    replaceTracks(store, animation().tracks.map(track => ({ ...track, keys: track.keys.map((key,index) => selected.has(key.id) ? { ...key, broken: broken.checked, ...(!broken.checked ? { tangentMode: "fixed" as const, inSlope: tangentSlope(track.keys,index,"out"), outSlope: tangentSlope(track.keys,index,"out") } : {}) } : key) })), "Link or break tangents");
    if (!entries.length) announce("Select keys to edit tangents.");
  });
  const inWeight = field(keyFields, "In weight", "0.333", value => edit(() => patchKeys(store, selected, { inWeight: value, interpolation:"bezier" })));
  const outWeight = field(keyFields, "Out weight", "0.333", value => edit(() => patchKeys(store, selected, { outWeight: value, interpolation:"bezier" })));
  for (const weight of [inWeight, outWeight]) { weight.min = "0"; weight.max = "1"; weight.step = ".01"; weight.title = "Handle length as a fraction of the adjacent key interval; 1/3 is unweighted"; }
  button(keyFields, "Unweight", () => edit(() => patchKeys(store, selected, { inWeight: 1/3, outWeight: 1/3 })), "Reset tangent handle lengths to one third of their key intervals");

  button(dopeToolbar, "Delete keys", remove); button(dopeToolbar, "Copy keys", copy); button(dopeToolbar, "Paste keys", paste);
  button(dopeToolbar, "Frame all", () => fit()); button(dopeToolbar, "Frame selected", () => fit(true));
  let shiftAmount = 1, scaleAmount = 1;
  field(dopeToolbar, "Shift frames", "1", value => { shiftAmount = Math.round(value); });
  button(dopeToolbar, "Shift", () => edit(() => moveKeys(store, selected, shiftAmount, 0)));
  const scaleField = field(dopeToolbar, "Time scale", "1", value => { scaleAmount = value; }); scaleField.min = ".001"; scaleField.step = ".1";
  button(dopeToolbar, "Scale time", () => edit(() => {
    scaleKeys(store, selected, scaleAmount);
  }), "Scale selected key times around the earliest selected frame; snap to whole frames");

  function renderChannels() {
    const list = visibleTracks();
    if (!list.some(track => track.id === activeTrack)) activeTrack = list[0]?.id ?? "";
    const focusedTrack=channelList.contains(document.activeElement)?(document.activeElement as HTMLElement).dataset.trackId:undefined;
    channelList.replaceChildren();
    if (!list.length) { const note = document.createElement("div"); note.className = "animation-empty"; note.textContent = "Set keys in the Timeline to create animation curves. Object and joint channels appear here."; channelList.append(note); }
    for (const track of list) {
      const entry = button(channelList, "", () => { activeTrack = track.id; renderChannels(); draw(); }, `${objectName(track.targetId)} · ${track.channel}`);
      entry.dataset.trackId=track.id;
      entry.setAttribute("aria-pressed", String(activeTrack === track.id));
      const name = document.createElement("span"); name.className = "channel-object"; name.textContent = objectName(track.targetId);
      const dot = document.createElement("span"); dot.className = "channel-color"; dot.style.background = colorFor(track);
      entry.append(name, dot, track.channel);
    }
    if(focusedTrack)Array.from(channelList.querySelectorAll<HTMLButtonElement>("button")).find(entry=>entry.dataset.trackId===focusedTrack)?.focus();
  }
  function updateFields() {
    const entries = keyEntries(), entry = entries[0], key = entry?.key;
    const hasVisibility=entries.some(item=>item.track.channel==="visibility");
    interpolation.disabled = tangents.disabled = !key||hasVisibility;
    for (const input of [keyTime, keyValue, inSlope, outSlope, inWeight, outWeight, broken]) input.disabled = entries.length !== 1;
    if(hasVisibility)for(const input of [inSlope,outSlope,inWeight,outWeight,broken])input.disabled=true;
    if (!entry) return;
    const index = entry.track.keys.findIndex(k => k.id === key.id);
    if (document.activeElement !== interpolation) interpolation.value = hasVisibility ? "step" : key.interpolation;
    if (document.activeElement !== tangents) tangents.value = key.tangentMode;
    for (const [input,value] of [[keyTime,key.time],[keyValue,key.value],[inSlope,tangentSlope(entry.track.keys,index,"in")],[outSlope,tangentSlope(entry.track.keys,index,"out")],[inWeight,key.inWeight ?? 1/3],[outWeight,key.outWeight ?? 1/3]] as const)
      if (document.activeElement !== input) input.value = labelValue(value);
    broken.checked = key.broken ?? false;
  }
  function timeGrid(target: SVGSVGElement, sheet = false, height = graphHeight) {
    const p = plot(sheet), step = niceStep(view.maxTime-view.minTime, Math.max(2,(p.right-p.left)/80));
    for (let time = Math.ceil(view.minTime/step)*step, n=0; time <= view.maxTime && n++<100; time+=step) {
      target.append(svgElement("line", { x1:x(time,sheet), y1:24, x2:x(time,sheet), y2:height- (sheet ? 0 : 30), class:"animation-grid" }));
      target.append(textSvg(x(time,sheet)+3, 15, labelValue(time)));
    }
    target.append(textSvg(sheet ? 8 : 5, 15, "Frame"));
  }
  function keyMark(target: SVGElement, key: CurveKey, px: number, py: number, color: string) {
    const keyNode = svgElement("rect", { x:px-4, y:py-4, width:8, height:8, rx:1, fill:color, transform:`rotate(45 ${px} ${py})`, class:`animation-key${selected.has(key.id) ? " selected" : ""}`, "data-key":key.id });
    const title = svgElement("title"); title.textContent = `Frame ${key.time}: ${labelValue(key.value)}`; keyNode.append(title); target.append(keyNode);
  }
  function tangentPoint(track: AnimationTrack, index: number, side: "in" | "out") {
    const key = track.keys[index], other = track.keys[index + (side === "in" ? -1 : 1)];
    const duration = other ? Math.abs(key.time-other.time) : (view.maxTime-view.minTime)/8;
    const weight = (side === "in" ? key.inWeight : key.outWeight) ?? 1/3;
    const dt = duration*weight*(side === "in" ? -1 : 1), slope = tangentSlope(track.keys,index,side);
    return { time:key.time+dt, value:key.value+dt*slope, duration };
  }
  function draw() {
    graphWidth = Math.max(180, surface.clientWidth || 600); graphHeight = Math.max(130, surface.clientHeight || 220);
    svg.setAttribute("viewBox", `0 0 ${graphWidth} ${graphHeight}`); svg.replaceChildren();
    const p = plot(); timeGrid(svg);
    const valueStep = niceStep(view.maxValue-view.minValue, Math.max(2,(p.bottom-p.top)/40));
    for (let value=Math.ceil(view.minValue/valueStep)*valueStep,n=0; value <= view.maxValue && n++<100; value+=valueStep) {
      svg.append(svgElement("line",{ x1:p.left,y1:y(value),x2:p.right,y2:y(value),class:"animation-grid" }));
      svg.append(textSvg(3,y(value)+3,labelValue(value)));
    }
    svg.append(textSvg(p.left,graphHeight-8,"Value / degrees · frame snapping"));
    const defs = svgElement("defs"), clip = svgElement("clipPath",{id:"animation-graph-clip"});
    clip.append(svgElement("rect",{x:p.left,y:p.top,width:p.right-p.left,height:p.bottom-p.top})); defs.append(clip); svg.append(defs);
    const content = svgElement("g",{"clip-path":"url(#animation-graph-clip)"}); svg.append(content);
    const list = visibleTracks();
    for (const track of [...list.filter(t=>t.id!==activeTrack),...list.filter(t=>t.id===activeTrack)]) {
      if (!track.keys.length) continue;
      const color = colorFor(track), opacity = track.id===activeTrack ? 1 : .48;
      const curveKeys=track.channel==="visibility"?track.keys.map(key=>({...key,interpolation:"step" as const})):track.keys;
      let d = "";
      const append = (time:number,value:number) => { d += `${d ? "L" : "M"}${x(time).toFixed(2)},${y(value).toFixed(2)} `; };
      append(view.minTime,evaluateCurve(curveKeys,view.minTime)!);
      for(let i=0;i<track.keys.length-1;i++) {
        const key=track.keys[i],next=track.keys[i+1];
        if(next.time<view.minTime || key.time>view.maxTime)continue;
        const from=Math.max(key.time,view.minTime),to=Math.min(next.time,view.maxTime);
        if(key.interpolation==="step"||track.channel==="visibility") { append(from,key.value);append(to,key.value);if(next.time<=view.maxTime)append(next.time,next.value); }
        else {
          const count=key.interpolation==="linear" ? 1 : Math.min(80,Math.max(8,Math.ceil((x(to)-x(from))/6)));
          for(let sample=0;sample<=count;sample++){const time=from+(to-from)*sample/count;append(time,evaluateCurve(track.keys,time)!);}
        }
      }
      append(view.maxTime,evaluateCurve(curveKeys,view.maxTime)!);
      content.append(svgElement("path",{d,fill:"none",stroke:color,"stroke-width":track.id===activeTrack ? 1.8 : 1.2,opacity}));
      for (let index=0;index<track.keys.length;index++) {
        const key=track.keys[index]; if(key.time<view.minTime || key.time>view.maxTime)continue;
        if(selected.has(key.id) && key.interpolation==="bezier" && track.channel!=="visibility") for(const side of ["in","out"] as const) {
          const handle=tangentPoint(track,index,side);
          content.append(svgElement("line",{x1:x(key.time),y1:y(key.value),x2:x(handle.time),y2:y(handle.value),class:"animation-tangent-line"}));
          const circle=svgElement("circle",{cx:x(handle.time),cy:y(handle.value),r:4,class:"animation-tangent-handle","data-tangent":key.id,"data-side":side});
          const title=svgElement("title");title.textContent=`${side} tangent; drag to edit slope and weight`;circle.append(title);content.append(circle);
        }
        keyMark(content,key,x(key.time),y(key.value),color);
      }
    }
    content.append(svgElement("line",{x1:x(options.getFrame()),x2:x(options.getFrame()),y1:p.top,y2:p.bottom,class:"animation-playhead"}));
    if(drag?.kind==="box"&&!drag.sheet) drawBox(svg,drag);
    drawDope();
  }
  function drawBox(target: SVGSVGElement, box: Drag) {
    target.append(svgElement("rect",{x:Math.min(box.start.x,box.current.x),y:Math.min(box.start.y,box.current.y),width:Math.abs(box.current.x-box.start.x),height:Math.abs(box.current.y-box.start.y),class:"animation-box"}));
  }
  function drawDope() {
    dopeWidth=Math.max(350,dopeScroll.clientWidth || 800);const list=visibleTracks(),height=Math.max(100,32+list.length*26);
    dopeSvg.setAttribute("viewBox",`0 0 ${dopeWidth} ${height}`);dopeSvg.style.height=`${height}px`;dopeSvg.replaceChildren();
    list.forEach((track,row)=>dopeSvg.append(svgElement("rect",{x:0,y:24+row*26,width:dopeWidth,height:26,class:"dope-row"})));
    timeGrid(dopeSvg,true,height);
    list.forEach((track,row)=>{
      const cy=37+row*26;
      const name=textSvg(8,cy+3,`${objectName(track.targetId)} · ${track.channel}`,"dope-name");
      const title=svgElement("title");title.textContent=`${objectName(track.targetId)} · ${track.channel}`;name.append(title);
      // Clip long labels to preserve the time grid.
      const labelSvg=svgElement("svg",{x:0,y:24+row*26,width:184,height:26});name.setAttribute("y","16");labelSvg.append(name);dopeSvg.append(labelSvg);
      for(const key of track.keys)if(x(key.time,true)>=190&&x(key.time,true)<=dopeWidth-16)keyMark(dopeSvg,key,x(key.time,true),cy,colorFor(track));
    });
    if(!list.length)dopeSvg.append(textSvg(12,55,"No animation tracks. Select an object or joint and set a key in the Timeline."));
    const px=x(options.getFrame(),true);dopeSvg.append(svgElement("line",{x1:px,x2:px,y1:24,y2:height,class:"animation-playhead",visibility:px>=190&&px<=dopeWidth-16?"visible":"hidden"}));
    if(drag?.kind==="box"&&drag.sheet)drawBox(dopeSvg,drag);
  }

  function bindPointer(target: SVGSVGElement, sheet: boolean) {
    target.addEventListener("contextmenu",event=>event.preventDefault());
    target.addEventListener("pointerdown",event=>{
      if(event.button!==0&&event.button!==1)return;
      event.preventDefault();event.stopPropagation();target.focus();
      const start=point(event,sheet),node=event.target as Element,keyId=node.getAttribute("data-key") ?? node.getAttribute("data-tangent") ?? undefined;
      const isPan=event.altKey||event.button===1;
      if(keyId&&!isPan){
        const track=tracks().find(t=>t.keys.some(k=>k.id===keyId));if(track)activeTrack=track.id;
        if(event.shiftKey&&selected.has(keyId)&&!node.hasAttribute("data-tangent")){selected.delete(keyId);refresh();return;}
        if(!selected.has(keyId)){if(!event.shiftKey)selected.clear();selected.add(keyId);}
      }
      const kind=isPan?"pan":node.hasAttribute("data-tangent")?"tangent":keyId?"key":start.y<24?"scrub":"box";
      if((kind==="key"||kind==="tangent")&&!options.available()){announce("Finish the current operation before editing animation.",true);refresh();return;}
      drag={kind,start,current:start,view:{...view},tracks:animation().tracks,keyId,side:(node.getAttribute("data-side")??"out") as "in"|"out",additive:event.shiftKey,sheet};
      target.setPointerCapture(event.pointerId);
      if(kind==="scrub")options.setFrame(Math.round(atTime(start.x,sheet)));
      refresh();
    });
    target.addEventListener("pointermove",event=>{
      if(!drag||drag.sheet!==sheet)return;
      drag.current=point(event,sheet);
      const dx=drag.current.x-drag.start.x,dy=drag.current.y-drag.start.y;
      if(drag.kind==="pan"){
        const p=plot(sheet),dt=dx/(p.right-p.left)*(drag.view.maxTime-drag.view.minTime),dv=dy/(p.bottom-p.top)*(drag.view.maxValue-drag.view.minValue);
        view={minTime:drag.view.minTime-dt,maxTime:drag.view.maxTime-dt,minValue:drag.view.minValue+(sheet?0:dv),maxValue:drag.view.maxValue+(sheet?0:dv)};
      } else if(drag.kind==="key"){
        const dt=Math.round(atTime(drag.current.x,sheet)-atTime(drag.start.x,sheet)),dv=sheet?0:atValue(drag.current.y)-atValue(drag.start.y);
        const next=drag.tracks.map(track=>({...track,keys:track.keys.map(key=>selected.has(key.id)?{...key,time:key.time+dt,value:key.value+dv}:key).sort((a,b)=>a.time-b.time)}));
        try { for(const track of next)validateCurveKeys(track.keys);previewTracks=next; }
        catch { previewTracks=undefined;announce("This move would overlap key times or exceed the supported range.",true); }
      } else if(drag.kind==="tangent"){
        const track=drag.tracks.find(t=>t.keys.some(k=>k.id===drag!.keyId));
        if(track){
          const index=track.keys.findIndex(k=>k.id===drag!.keyId),key=track.keys[index],side=drag.side!,sign=side==="in"?-1:1,handle=tangentPoint(track,index,side);
          const dt=Math.min(handle.duration,Math.max(handle.duration*.001,(atTime(drag.current.x)-key.time)*sign))*sign;
          const slope=(atValue(drag.current.y)-key.value)/dt;
          try {
            const edited=withTangent(track.keys,index,side,slope,Math.abs(dt)/handle.duration);
            previewTracks=drag.tracks.map(t=>t.id===track.id?{...t,keys:t.keys.map(k=>k.id===key.id?edited:k)}:t);
          } catch { previewTracks=undefined;announce("Tangent exceeds the supported range.",true); }
        }
      } else if(drag.kind==="scrub")options.setFrame(Math.round(atTime(drag.current.x,sheet)));
      draw();updateFields();
    });
    const finish=(event:PointerEvent,cancel=false)=>{
      if(!drag||drag.sheet!==sheet)return;
      const completed=drag,preview=previewTracks;drag=undefined;previewTracks=undefined;
      if(target.hasPointerCapture(event.pointerId))target.releasePointerCapture(event.pointerId);
      if(!cancel&&completed.kind==="box"){
        if(!completed.additive)selected.clear();
        const lowX=Math.min(completed.start.x,completed.current.x),highX=Math.max(completed.start.x,completed.current.x),lowY=Math.min(completed.start.y,completed.current.y),highY=Math.max(completed.start.y,completed.current.y);
        const p=plot(sheet);
        visibleTracks().forEach((track,row)=>track.keys.forEach(key=>{const px=x(key.time,sheet),py=sheet?37+row*26:y(key.value);if(px>=p.left&&px<=p.right&&px>=lowX&&px<=highX&&py>=lowY&&py<=highY)selected.add(key.id);}));
        announce(`${selected.size} keys selected.`);
      } else if(!cancel&&preview&&(completed.kind==="key"||completed.kind==="tangent"))edit(()=>{
        if(completed.kind==="key")moveKeys(store,selected,Math.round(atTime(completed.current.x,sheet)-atTime(completed.start.x,sheet)),sheet?0:atValue(completed.current.y)-atValue(completed.start.y));
        else replaceTracks(store,preview,"Edit tangent handle");
      });
      refresh();
    };
    target.addEventListener("pointerup",event=>finish(event));target.addEventListener("pointercancel",event=>finish(event,true));
    target.addEventListener("dblclick",event=>{
      if(sheet||(event.target as Element).hasAttribute("data-key"))return;
      const rect=target.getBoundingClientRect();insert(Math.round(atTime(event.clientX-rect.left)),atValue(event.clientY-rect.top));
    });
    target.addEventListener("wheel",event=>{
      event.preventDefault();const cursor=point(event,sheet),anchorTime=atTime(cursor.x,sheet),anchorValue=atValue(cursor.y),factor=Math.exp(Math.max(-.5,Math.min(.5,event.deltaY*.0015)));
      if(event.shiftKey){const delta=(view.maxTime-view.minTime)*event.deltaY*.001;view.minTime+=delta;view.maxTime+=delta;}
      else if((view.maxTime-view.minTime)*factor>=.2&&(view.maxTime-view.minTime)*factor<=1e7){
        view={minTime:anchorTime+(view.minTime-anchorTime)*factor,maxTime:anchorTime+(view.maxTime-anchorTime)*factor,minValue:sheet?view.minValue:anchorValue+(view.minValue-anchorValue)*factor,maxValue:sheet?view.maxValue:anchorValue+(view.maxValue-anchorValue)*factor};
      }draw();
    },{passive:false});
  }
  bindPointer(svg,false);bindPointer(dopeSvg,true);
  for(const editor of [graph,dopeSheet])editor.addEventListener("keydown",event=>{
    const target=event.target as HTMLElement;
    if(target.matches("input,select,textarea")){if(event.key==="Enter"){event.preventDefault();target.blur();}return;}
    const mod=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
    if(mod&&key==="c"){event.preventDefault();copy();}
    else if(mod&&key==="v"){event.preventDefault();paste();}
    else if(mod&&key==="a"){event.preventDefault();selected=new Set(visibleTracks().flatMap(t=>t.keys.map(k=>k.id)));refresh();}
    else if(mod&&(key==="z"||key==="y")){event.preventDefault();edit(()=>{const history=store.temporal.getState();if(key==="y"||event.shiftKey)history.redo();else history.undo();});}
    else if(key==="delete"||key==="backspace"){event.preventDefault();remove();}
    else if(key==="s"&&!mod&&!event.altKey){event.preventDefault();insert();}
    else if(key==="f"){event.preventDefault();fit(selected.size>0);}
    else if(key==="escape"){event.preventDefault();drag=undefined;previewTracks=undefined;selected.clear();refresh();}
    else if(key==="arrowleft"||key==="arrowright"){event.preventDefault();edit(()=>moveKeys(store,selected,(key==="arrowleft"?-1:1)*(event.shiftKey?10:1),0));}
  });
  function refresh() {
    const doc=store.getState().document,selection=options.getSelection().join("|");
    if(lastDocument!==doc||lastSelection!==selection){
      const existing=new Set(animation().tracks.flatMap(t=>t.keys.map(k=>k.id)));selected=new Set([...selected].filter(id=>existing.has(id)));
      lastDocument=doc;lastSelection=selection;
    }
    const editorState=`${selection}/${selectedObjectsOnly}/${activeTrack}/${[...selected].join(",")}/${JSON.stringify(view)}/${drag?.kind ?? ""}`;
    if(renderedDocument!==doc||lastEditorState!==editorState){
      renderChannels();updateFields();draw();renderedDocument=doc;
      lastEditorState=`${selection}/${selectedObjectsOnly}/${activeTrack}/${[...selected].join(",")}/${JSON.stringify(view)}/${drag?.kind ?? ""}`;
    } else {
      // Playback moves only the cursors; static curves and channel DOM are retained.
      const graphCursor=svg.querySelector(".animation-playhead"),dopeCursor=dopeSvg.querySelector(".animation-playhead");
      const gx=x(options.getFrame()),dx=x(options.getFrame(),true);
      graphCursor?.setAttribute("x1",String(gx));graphCursor?.setAttribute("x2",String(gx));
      dopeCursor?.setAttribute("x1",String(dx));dopeCursor?.setAttribute("x2",String(dx));
      dopeCursor?.setAttribute("visibility",dx>=190&&dx<=dopeWidth-16?"visible":"hidden");
    }
  }
  store.subscribe(()=>{ drag=undefined;previewTracks=undefined;refresh(); });
  new ResizeObserver(()=>draw()).observe(surface);new ResizeObserver(()=>drawDope()).observe(dopeScroll);
  announce("Set keys in the Timeline · select a channel · drag keys and tangent handles");
  fit();
  return { graph, dopeSheet, refresh };
}
