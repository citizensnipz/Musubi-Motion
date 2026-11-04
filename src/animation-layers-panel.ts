import { addAnimationLayer, setActiveAnimationLayer, updateAnimationLayer, reorderAnimationLayer, removeAnimationLayer, setLayerWeightKey, deleteLayerWeightKey, clearLayerWeightCurve, replaceLayerWeightTrack } from "./animation-layers.ts";
import { evaluateLayerWeight, type CurveKey, type LayerWeightTrack } from "./animation.ts";
import { propertyInteraction } from "./property-interaction.ts";
import type { SceneStore } from "./scene-store.ts";

export function createAnimationLayersPanel(store: SceneStore, options: { available(): boolean; getFrame?(): number; onActiveChange(): void; onStatus?(message: string): void }) {
  const element = document.createElement("section"); element.className = "animation-layers-panel"; element.setAttribute("aria-label", "Animation layers");
  const style = document.createElement("style"); style.textContent = `.animation-layers-panel{height:100%;overflow:auto;box-sizing:border-box;padding:12px;color:var(--text);background:var(--panel);font-size:12px}.animation-layers-panel label{display:grid;gap:5px;margin:10px 0}.animation-layers-panel p{line-height:1.5;color:var(--muted)}.animation-layers-panel input,.animation-layers-panel select,.animation-layers-panel button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0;box-sizing:border-box}.animation-layers-panel select,.animation-layers-panel input:not([type=checkbox]){width:100%}.animation-layers-panel button{cursor:pointer;margin:0 5px 6px 0}.animation-layers-panel .layer-check{display:flex;align-items:center;gap:7px}.animation-layers-panel :disabled{opacity:.45}.animation-layers-panel input[type=number]{text-align:right}.animation-layers-panel .weight-actions{display:flex;flex-wrap:wrap;gap:4px}.animation-layers-panel .weight-actions button{margin:0}.animation-layers-panel details{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}.animation-layers-panel summary{cursor:pointer}.animation-layers-panel .weight-key-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.animation-layers-panel .weight-key-fields label{min-width:0}.animation-layers-panel [data-error=true]{color:#ce756a}`;
  function input(label: string, type = "text") { const node = document.createElement("input"); node.type = type; node.setAttribute("aria-label", label); return node; }
  function select(label: string, values: [string,string][]) { const node = document.createElement("select"); node.setAttribute("aria-label", label); values.forEach(([text,value]) => node.add(new Option(text,value))); return node; }
  function label(text: string, control: HTMLElement) { const node = document.createElement("label"); node.append(text,control); return node; }
  function button(text: string, action: () => void) { const node = document.createElement("button"); node.type="button"; node.textContent=text; node.onclick=()=>run(action); return node; }
  const intro = document.createElement("p"); intro.textContent = "Choose the layer edited by keying, the Graph Editor and Dope Sheet. Base evaluates first; layers below are applied in list order. Selection does not change playback.";
  const active = select("Active animation layer", []), name = input("Animation layer name"), mode = select("Animation layer mode", [["Additive","additive"],["Override","override"]]);
  const weight = input("Animation layer weight", "number"); weight.min="0"; weight.max="1"; weight.step="0.01";
  const sampled=document.createElement("p");sampled.setAttribute("aria-live","off");
  const keyValue=input("Layer weight key value","number");keyValue.min="0";keyValue.max="1";keyValue.step="0.01";
  const frame=()=>options.getFrame?.()??0;
  const actions=document.createElement("div");actions.className="weight-actions";
  const setWeightKey=button("Set weight key",()=>setLayerWeightKey(store,active.value,Math.round(frame()),keyValue.valueAsNumber));
  const deleteWeightKey=button("Delete weight key",()=>deleteLayerWeightKey(store,active.value,Math.round(frame())));
  const clearWeight=button("Clear weight curve",()=>clearLayerWeightCurve(store,active.value));
  actions.append(setWeightKey,deleteWeightKey,clearWeight);
  const keyDetails=document.createElement("details"),keyHeading=document.createElement("summary");
  keyHeading.textContent="Weight curve keys";
  // Keep native disclosure activation from also toggling viewport playback.
  keyHeading.addEventListener("keydown",event=>{if(event.key===" "||event.key==="Enter")event.stopPropagation();});
  const keyList=select("Layer weight keys",[]);keyList.size=4;
  const selectedFrame=input("Selected weight key frame","number");selectedFrame.min="-1000000";selectedFrame.max="1000000";selectedFrame.step="0.01";
  const selectedValue=input("Selected weight key value","number");selectedValue.min="0";selectedValue.max="1";selectedValue.step="0.01";
  const selectedInterpolation=select("Selected weight key interpolation",[["Step","step"],["Linear","linear"],["Bezier","bezier"]]);
  const keyFields=document.createElement("div");keyFields.className="weight-key-fields";keyFields.append(label("Frame",selectedFrame),label("Value",selectedValue));
  let selectedKeyId="",keyOwnerId="";
  let observedTrack:LayerWeightTrack|undefined,listedTrack:LayerWeightTrack|undefined,listedOwner="";
  let keyById=new Map<string,CurveKey>();
  const selectedKey=()=>store.getState().document.animation?.layers?.find(layer=>layer.id===active.value)?.weightTrack?.keys.find(key=>key.id===selectedKeyId);
  function editSelectedKey(patch:Partial<Pick<CurveKey,"time"|"value"|"interpolation">>){
    const layer=store.getState().document.animation?.layers?.find(layer=>layer.id===active.value),track=layer?.weightTrack;
    if(!track||!selectedKey())return;
    replaceLayerWeightTrack(store,active.value,{...track,keys:track.keys.map(key=>key.id===selectedKeyId?{...key,...patch}:key).sort((a,b)=>a.time-b.time)});
  }
  const removeSelected=button("Remove selected weight key",()=>{const key=selectedKey();if(key)deleteLayerWeightKey(store,active.value,key.time);});
  keyDetails.ontoggle=()=>refresh();
  keyList.onchange=()=>{selectedKeyId=keyList.value;refresh();};
  selectedFrame.onchange=()=>{if(!cancelField&&!selectedFrame.readOnly)run(()=>editSelectedKey({time:selectedFrame.valueAsNumber}));};
  selectedValue.onchange=()=>{if(!cancelField&&!selectedValue.readOnly)run(()=>editSelectedKey({value:selectedValue.valueAsNumber}));};
  selectedInterpolation.onchange=()=>run(()=>editSelectedKey({interpolation:selectedInterpolation.value as CurveKey["interpolation"]}));
  const keyHelp=document.createElement("p");keyHelp.textContent="Select a weight key to edit its exact frame, value and outgoing interpolation. Middle-drag previews the numeric field; release commits once. Escape cancels. Right-click a numeric field to Lock or Unlock it.";
  keyDetails.append(keyHeading,label("Keys",keyList),keyFields,label("Interpolation",selectedInterpolation),removeSelected,keyHelp);
  const checks = (["Mute", "Solo", "Locked"] as const).map(text => {const node=input(`Animation layer ${text.toLowerCase()}`,"checkbox");const row=label(text,node);row.className="layer-check";return {text,node,row};});
  const status=document.createElement("p");status.setAttribute("role","status");
  const summary=document.createElement("p");
  const help=document.createElement("p"); help.textContent="Additive layers add position/rotation offsets and multiply scale factors. Override layers blend toward their values. Visibility uses override blending. Missing channels pass through. Keying solves the active layer value needed for the requested composite pose; locked, muted, zero-weight or fully masked layers cannot receive pose keys. Weight curves remain keyable at zero influence.";
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
  [name,weight,keyValue,selectedFrame,selectedValue].forEach(node=>node.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();node.blur();}else if(event.key==="Escape"){event.preventDefault();cancelField=true;node.blur();cancelField=false;sampleSignature="";refresh();}}));
  element.append(style,intro,label("Active layer",active),summary,add,up,down,remove,label("Name",name),label("Blend mode",mode),label("Fallback weight",weight),sampled,label("Weight key value",keyValue),actions,keyDetails,...checks.map(check=>check.row),help,status);
  const refreshWeightLock=propertyInteraction(weight,()=>`layer:${active.value}:weight`);
  const refreshKeyLock=propertyInteraction(keyValue,()=>`layer:${active.value}:key-value`);
  [selectedFrame,selectedValue].forEach(node=>node.addEventListener("pointerdown",event=>{if(event.button===1&&!node.disabled&&!node.readOnly)node.focus();}));
  const refreshSelectedFrameLock=propertyInteraction(selectedFrame,()=>`layer:${active.value}:weight-key:${selectedKeyId}:frame`);
  const refreshSelectedValueLock=propertyInteraction(selectedValue,()=>`layer:${active.value}:weight-key:${selectedKeyId}:value`);
  let signature="",sampleSignature="";
  function refresh(){
    const animation=store.getState().document.animation,layers=animation?.layers??[],id=animation?.activeLayerId??"",layer=layers.find(layer=>layer.id===id),next=JSON.stringify(layers.map(layer=>[layer.id,layer.name]));
    if(next!==signature){active.replaceChildren(new Option("Base animation",""),...layers.map((layer,index)=>new Option(`${index+1}. ${layer.name}`,layer.id)));signature=next;}
    active.value=id;
    if(document.activeElement!==name)name.value=layer?.name??"Base animation";
    mode.value=layer?.mode??"override";if(document.activeElement!==weight)weight.value=String(layer?.weight??1);
    const current=frame(),value=layer?evaluateLayerWeight(layer,current):1;
    sampled.textContent=`Sampled weight: ${Number(value.toFixed(6))} at frame ${Number(current.toFixed(3))} · ${layer?.weightTrack?.keys.length??0} weight keys`;
    const sampleNext=`${id}:${current}:${value}`;
    if(document.activeElement!==keyValue&&sampleNext!==sampleSignature)keyValue.value=String(value);
    sampleSignature=sampleNext;refreshWeightLock();refreshKeyLock();
    checks.forEach(({text,node})=>node.checked=layer?.[text.toLowerCase() as "mute"|"solo"|"locked"]??false);
    const available=options.available();active.disabled=add.disabled=!available;
    [name,mode,weight,...checks.map(check=>check.node)].forEach(node=>node.disabled=!available||!layer);
    weight.disabled=keyValue.disabled=setWeightKey.disabled=!available||!layer||layer.locked===true;
    deleteWeightKey.disabled=!available||!layer||layer.locked||!layer.weightTrack?.keys.some(key=>key.time===Math.round(current));
    clearWeight.disabled=!available||!layer||layer.locked||!layer.weightTrack?.keys.length;
    const track=layer?.weightTrack,keys=track?.keys??[];
    if(keyOwnerId!==id||observedTrack!==track){
      if(keyOwnerId!==id)selectedKeyId="";
      keyOwnerId=id;observedTrack=track;
      keyById=new Map(keys.map(key=>[key.id,key]));
      if(!keyById.has(selectedKeyId))selectedKeyId=keys[0]?.id??"";
    }
    // Build the native list only when disclosed and its immutable source changes.
    if(keyDetails.open&&(listedTrack!==track||listedOwner!==id)){
      const choices=document.createDocumentFragment();
      keys.forEach(key=>choices.append(new Option(`Frame ${key.time} · ${key.value} · ${key.interpolation}`,key.id)));
      keyList.replaceChildren(choices);listedTrack=track;listedOwner=id;
    }
    keyList.value=selectedKeyId;
    const key=keyById.get(selectedKeyId);
    if(document.activeElement!==selectedFrame)selectedFrame.value=key?String(key.time):"";
    if(document.activeElement!==selectedValue)selectedValue.value=key?String(key.value):"";
    selectedInterpolation.value=key?.interpolation??"linear";
    keyList.disabled=!available||!keys.length;
    selectedFrame.disabled=selectedValue.disabled=selectedInterpolation.disabled=removeSelected.disabled=!available||!key||layer?.locked===true;
    refreshSelectedFrameLock();refreshSelectedValueLock();
    const index=layers.findIndex(layer=>layer.id===id);up.disabled=!available||index<=0;down.disabled=!available||index<0||index===layers.length-1;remove.disabled=!available||!layer||layer.locked;
    const tracks=(animation?.tracks??[]).filter(track=>track.layerId===(id||undefined));summary.textContent=`${tracks.length} curves · ${tracks.reduce((count,track)=>count+track.keys.length,0)} keys on active layer`;
  }
  const unsubscribe=store.subscribe(refresh);refresh();return {element,refresh,dispose:unsubscribe};
}
