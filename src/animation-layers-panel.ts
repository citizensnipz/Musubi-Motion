import { addAnimationLayer, setActiveAnimationLayer, updateAnimationLayer, reorderAnimationLayer, removeAnimationLayer } from "./animation-layers.ts";
import type { SceneStore } from "./scene-store.ts";

export function createAnimationLayersPanel(store: SceneStore, options: { available(): boolean; onActiveChange(): void; onStatus?(message: string): void }) {
  const element = document.createElement("section"); element.className = "animation-layers-panel"; element.setAttribute("aria-label", "Animation layers");
  const style = document.createElement("style"); style.textContent = `.animation-layers-panel{height:100%;overflow:auto;box-sizing:border-box;padding:12px;color:var(--text);background:var(--panel);font-size:12px}.animation-layers-panel label{display:grid;gap:5px;margin:10px 0}.animation-layers-panel p{line-height:1.5;color:var(--muted)}.animation-layers-panel input,.animation-layers-panel select,.animation-layers-panel button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0;box-sizing:border-box}.animation-layers-panel select,.animation-layers-panel input:not([type=checkbox]){width:100%}.animation-layers-panel button{cursor:pointer;margin:0 5px 6px 0}.animation-layers-panel .layer-check{display:flex;align-items:center;gap:7px}.animation-layers-panel :disabled{opacity:.45}.animation-layers-panel [data-error=true]{color:#ce756a}`;
  function input(label: string, type = "text") { const node = document.createElement("input"); node.type = type; node.setAttribute("aria-label", label); return node; }
  function select(label: string, values: [string,string][]) { const node = document.createElement("select"); node.setAttribute("aria-label", label); values.forEach(([text,value]) => node.add(new Option(text,value))); return node; }
  function label(text: string, control: HTMLElement) { const node = document.createElement("label"); node.append(text,control); return node; }
  function button(text: string, action: () => void) { const node = document.createElement("button"); node.type="button"; node.textContent=text; node.onclick=()=>run(action); return node; }
  const intro = document.createElement("p"); intro.textContent = "Choose the layer edited by keying, the Graph Editor and Dope Sheet. Base evaluates first; layers below are applied in list order. Selection does not change playback.";
  const active = select("Active animation layer", []), name = input("Animation layer name"), mode = select("Animation layer mode", [["Additive","additive"],["Override","override"]]);
  const weight = input("Animation layer weight", "number"); weight.min="0"; weight.max="1"; weight.step="any";
  const checks = (["Mute", "Solo", "Locked"] as const).map(text => {const node=input(`Animation layer ${text.toLowerCase()}`,"checkbox");const row=label(text,node);row.className="layer-check";return {text,node,row};});
  const status=document.createElement("p");status.setAttribute("role","status");
  const summary=document.createElement("p");
  const help=document.createElement("p"); help.textContent="Additive layers add position/rotation offsets and multiply scale factors. Override layers blend toward their values. Visibility uses override blending. Missing channels pass through. Keying solves the active layer value needed for the requested composite pose; locked, muted, zero-weight or fully masked layers cannot receive keys.";
  function report(message:string,error=false){status.textContent=message;status.dataset.error=String(error);options.onStatus?.(message);}
  function run(action:()=>void){if(!options.available())return;try{action();report("");}catch(error){report(error instanceof Error?error.message:String(error),true);}refresh();}
  const add=button("Add layer",()=>{addAnimationLayer(store,"Animation layer", "additive");options.onActiveChange();});
  const remove=button("Remove layer",()=>{removeAnimationLayer(store,active.value);options.onActiveChange();});
  const up=button("Earlier",()=>{const layers=store.getState().document.animation?.layers??[];reorderAnimationLayer(store,active.value,layers.findIndex(layer=>layer.id===active.value)-1);});
  const down=button("Later",()=>{const layers=store.getState().document.animation?.layers??[];reorderAnimationLayer(store,active.value,layers.findIndex(layer=>layer.id===active.value)+1);});
  active.onchange=()=>run(()=>{setActiveAnimationLayer(store,active.value||undefined);options.onActiveChange();});
  let cancelField=false;
  name.onchange=()=>{if(!cancelField)run(()=>updateAnimationLayer(store,active.value,{name:name.value}));};
  mode.onchange=()=>run(()=>updateAnimationLayer(store,active.value,{mode:mode.value as "additive"|"override"}));
  weight.onchange=()=>{if(!cancelField)run(()=>updateAnimationLayer(store,active.value,{weight:weight.valueAsNumber}));};
  checks.forEach(({text,node})=>node.onchange=()=>run(()=>updateAnimationLayer(store,active.value,{[text.toLowerCase()]:node.checked})));
  [name,weight].forEach(node=>node.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();node.blur();}else if(event.key==="Escape"){event.preventDefault();cancelField=true;node.blur();cancelField=false;refresh();}}));
  element.append(style,intro,label("Active layer",active),summary,add,up,down,remove,label("Name",name),label("Blend mode",mode),label("Weight",weight),...checks.map(check=>check.row),help,status);
  let signature="";
  function refresh(){
    const animation=store.getState().document.animation,layers=animation?.layers??[],id=animation?.activeLayerId??"",layer=layers.find(layer=>layer.id===id),next=JSON.stringify(layers.map(layer=>[layer.id,layer.name]));
    if(next!==signature){active.replaceChildren(new Option("Base animation",""),...layers.map((layer,index)=>new Option(`${index+1}. ${layer.name}`,layer.id)));signature=next;}
    active.value=id;
    if(document.activeElement!==name)name.value=layer?.name??"Base animation";
    mode.value=layer?.mode??"override";if(document.activeElement!==weight)weight.value=String(layer?.weight??1);
    checks.forEach(({text,node})=>node.checked=layer?.[text.toLowerCase() as "mute"|"solo"|"locked"]??false);
    const available=options.available();active.disabled=add.disabled=!available;
    [name,mode,weight,...checks.map(check=>check.node)].forEach(node=>node.disabled=!available||!layer);
    const index=layers.findIndex(layer=>layer.id===id);up.disabled=!available||index<=0;down.disabled=!available||index<0||index===layers.length-1;remove.disabled=!available||!layer||layer.locked;
    const tracks=(animation?.tracks??[]).filter(track=>track.layerId===(id||undefined));summary.textContent=`${tracks.length} curves · ${tracks.reduce((count,track)=>count+track.keys.length,0)} keys on active layer`;
  }
  const unsubscribe=store.subscribe(refresh);refresh();return {element,refresh,dispose:unsubscribe};
}
