import { editSkinWeight, resetSkinWeights, MAX_WEIGHT_EDIT_COMPONENTS, type SkinInfluence } from "./skin-weights.ts";
import type { SplatShapeNode } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

type Components = { count: number; getWeights: (index: number) => SkinInfluence[] };
type Preview = { shapeId: string; indices: number[]; jointId: string };
type Options = {
  available: () => boolean;
  getSelection: () => string[];
  getComponents: (shapeId: string) => Components | undefined;
  onPreview: (preview: Preview | undefined) => void;
};
const EDIT_LIMIT = MAX_WEIGHT_EDIT_COMPONENTS, PREVIEW_LIMIT = 5000;

/** Component-index skin editing; preview is runtime-only and never enters history. */
export function createSkinWeightsPanel(store: SceneStore, options: Options) {
  const element=document.createElement("section");element.className="skin-weights-panel";element.setAttribute("aria-label","Skin Weights");
  const style=document.createElement("style");
  style.textContent=`.skin-weights-panel{height:100%;overflow:auto;padding:12px;font-size:12px;background:var(--panel);color:var(--text)}
    .skin-weights-panel p{color:var(--muted);line-height:1.5}.skin-weights-panel fieldset{border:1px solid var(--line);padding:10px;margin:0 0 12px;min-width:0}.skin-weights-panel legend{padding:0 5px}
    .skin-weights-panel label{display:grid;gap:5px;margin:8px 0}.skin-weights-panel input,.skin-weights-panel select,.skin-weights-panel button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0}
    .skin-weights-panel input:not([type=checkbox]),.skin-weights-panel select{width:100%}.skin-weights-panel :disabled{opacity:.45;cursor:default}.skin-weights-panel button{cursor:pointer}.skin-weights-panel button:hover:not(:disabled){background:var(--hover)}
    .skin-weights-panel input:focus-visible,.skin-weights-panel select:focus-visible,.skin-weights-panel button:focus-visible{outline:1px solid var(--strong)}.skin-weights-panel .weight-range{display:grid;grid-template-columns:1fr 1fr;gap:8px}.skin-weights-panel .weight-range label{min-width:0}
    .skin-weights-panel .weight-actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.skin-weights-panel .weight-check{display:flex;align-items:center;gap:7px}.skin-weights-panel .weight-status{min-height:20px;overflow-wrap:anywhere}.skin-weights-panel .weight-status[data-error=true]{color:#ce756a}
    .skin-weights-panel table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}.skin-weights-panel th,.skin-weights-panel td{padding:5px;text-align:left;border-bottom:1px solid var(--line)}.skin-weights-panel th{color:var(--muted);font-size:10px}.skin-weights-panel td:last-child{text-align:right}.skin-weights-panel h3{font-size:12px;margin:12px 0 7px}`;
  element.append(style);
  function label(text:string,control:HTMLElement){const node=document.createElement("label");node.append(document.createTextNode(text),control);return node;}
  function button(text:string,action:()=>void){const node=document.createElement("button");node.type="button";node.textContent=text;node.onclick=action;return node;}
  function number(name:string,value:string){const node=document.createElement("input");node.type="number";node.value=value;node.setAttribute("aria-label",name);return node;}
  function group(title:string){const node=document.createElement("fieldset"),legend=document.createElement("legend");legend.textContent=title;node.append(legend);return node;}
  const intro=document.createElement("p");intro.textContent="Edit normalized joint weights by splat component index. Each component supports up to four active influences. Edits preserve the proportions of its other influences.";element.append(intro);
  const objects=document.createElement("select");objects.setAttribute("aria-label","Bound splat object");element.append(label("Bound splat object",objects));
  const empty=document.createElement("p");empty.textContent="Bind a splat object to joints, then select it here or in the Outliner.";element.append(empty);
  const details=group("Component weights");
  const summary=document.createElement("p");details.append(summary);
  const range=document.createElement("div");range.className="weight-range";
  const first=number("First component index","0"),last=number("Last component index","0");
  for(const input of [first,last]){input.step="1";input.min="0";}
  range.append(label("First index · inclusive",first),label("Last index · inclusive",last));details.append(range);
  const rangeSummary=document.createElement("p");details.append(rangeSummary);
  const previous=button("Previous component",()=>run(()=>{
    const context=requiredContext();setRange(Math.max(0,rangeStart-1),Math.max(0,rangeStart-1),context.count);
  }));
  const next=button("Next component",()=>run(()=>{
    const context=requiredContext(),index=Math.min(context.count-1,rangeStart+1);setRange(index,index,context.count);
  }));
  previous.title=next.title="Inspect and select one adjacent component; this replaces the current range.";
  const navigation=document.createElement("div");navigation.className="weight-actions";navigation.append(previous,next);details.append(navigation);
  const influence=document.createElement("select");influence.setAttribute("aria-label","Skin joint influence");details.append(label("Joint influence",influence));
  const value=number("Influence weight","1");value.step="0.01";value.min="0";value.max="1";details.append(label("Weight · 0 to 1",value));
  const apply=button("Apply influence weight",()=>run(()=>{
    const shape=current(),context=requiredContext(),indices=editIndices(context.count);
    editSkinWeight(store,shape.id,indices,influence.value,requestedWeight,context);
  },"Influence weight applied to every component in the range. Undo restores the previous weights."));
  const resetSelected=button("Reset selected to automatic",()=>run(()=>{
    const shape=current(),context=requiredContext(),indices=editIndices(context.count);
    clearPreview(true);resetSkinWeights(store,shape.id,indices);
  },"Selected components now use their automatic distance weights."));
  const resetAll=button("Reset all overrides",()=>run(()=>{
    const shape=current();clearPreview(true);resetSkinWeights(store,shape.id,null);
  },"All authored weight overrides removed. The binding now uses automatic weights."));
  const actions=document.createElement("div");actions.className="weight-actions";actions.append(apply,resetSelected,resetAll);details.append(actions);
  const show=document.createElement("input");show.type="checkbox";
  const showLabel=label("Show weights in viewport",show);showLabel.className="weight-check";details.append(showLabel);
  const previewNote=document.createElement("p");details.append(previewNote);
  const inspectHeading=document.createElement("h3");details.append(inspectHeading);
  const table=document.createElement("table");table.setAttribute("aria-label","Inspected component influences");
  const head=document.createElement("thead"),headRow=document.createElement("tr");
  for(const text of ["Joint","Normalized weight"]){const cell=document.createElement("th");cell.scope="col";cell.textContent=text;headRow.append(cell);}head.append(headRow);table.append(head);
  const weightsBody=document.createElement("tbody");table.append(weightsBody);details.append(table);
  const total=document.createElement("p");details.append(total);
  const limits=document.createElement("p");limits.textContent="Edits affect the full inclusive range, up to 20,000 components per operation. Viewport display samples at most 5,000 indices evenly across that range. The paused preview uses X-ray points visible through surfaces; it hides during playback, manipulation, or when Gizmos are hidden. Preview never changes the scene or history. Weight 1 makes the selected joint the sole influence; unsupported fifth influences and invalid normalization are rejected.";
  const status=document.createElement("p");status.className="weight-status";status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  element.append(details,status,limits);
  let shapeId="",rangeStart=0,rangeEnd=0,requestedWeight=1;
  let selectionSignature="",objectSignature="",influenceSignature="",inspectionSignature="",previewSignature="";
  let previousBinding:SplatShapeNode["binding"],previewBinding:SplatShapeNode["binding"];
  let overrideBinding:SplatShapeNode["binding"],overrideCount=0;

  function current():SplatShapeNode{
    const shape=store.getState().document.nodes[shapeId];
    if(shape?.type!=="splatShape"||!shape.binding)throw Error("Select a bound splat object first.");
    return shape;
  }
  function requiredContext():Components{
    current();const context=options.getComponents(shapeId);
    if(!context||!Number.isSafeInteger(context.count)||context.count<=0)throw Error("The selected binding has no available components. Wait for the splat asset to load.");
    return context;
  }
  function validateRange(start:number,end:number,count:number){
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>=count)
      throw Error(`Use whole component indices from 0 to ${Math.max(0,count-1)}, with the first index no greater than the last.`);
  }
  function setRange(start:number,end:number,count:number){validateRange(start,end,count);rangeStart=start;rangeEnd=end;}
  function editIndices(count:number){
    validateRange(rangeStart,rangeEnd,count);const size=rangeEnd-rangeStart+1;
    if(size>EDIT_LIMIT)throw Error("Choose at most 20,000 components for one edit. The viewport sample does not limit which components are edited.");
    return Array.from({length:size},(_,index)=>rangeStart+index);
  }
  function clearPreview(uncheck=false){
    if(uncheck)show.checked=false;
    if(previewSignature){options.onPreview(undefined);previewSignature="";previewBinding=undefined;}
  }
  function run(action:()=>void,message=""){
    if(!options.available()){status.textContent="Pause playback and finish the current operation before editing skin weights.";status.dataset.error="true";return;}
    try{action();status.textContent=message;status.dataset.error="false";refresh();}
    catch(error){status.textContent=error instanceof Error?error.message:String(error);status.dataset.error="true";refresh();}
  }
  function onCommit(input:HTMLInputElement,action:()=>void){
    let cancel=false;
    input.addEventListener("blur",()=>{if(!cancel)run(action);cancel=false;refresh();});
    input.addEventListener("keydown",event=>{
      if(event.key==="Enter"){event.preventDefault();input.blur();}
      else if(event.key==="Escape"){event.preventDefault();cancel=true;input.blur();refresh();}
    });
  }
  function readNumber(input:HTMLInputElement){if(!input.value.trim()||!Number.isFinite(input.valueAsNumber))throw Error(`${input.getAttribute("aria-label")} must be a finite number.`);return input.valueAsNumber;}
  onCommit(first,()=>{const context=requiredContext(),start=readNumber(first);setRange(start,Math.max(start,rangeEnd),context.count);});
  onCommit(last,()=>{const context=requiredContext(),end=readNumber(last);setRange(Math.min(rangeStart,end),end,context.count);});
  onCommit(value,()=>{const number=readNumber(value);if(number<0||number>1)throw Error("Influence weight must be between 0 and 1.");requestedWeight=number;});
  objects.onchange=()=>{clearPreview(true);shapeId=objects.value;rangeStart=rangeEnd=0;inspectionSignature="";status.textContent="";refresh();};
  influence.onchange=()=>{inspectionSignature="";status.textContent="";refresh();};
  show.onchange=()=>{if(!show.checked)clearPreview();refresh();};

  function refresh(){
    const doc=store.getState().document,selection=options.getSelection(),selectionKey=selection.join("|"),available=options.available();
    const shapes=Object.values(doc.nodes).filter((node):node is SplatShapeNode=>node.type==="splatShape"&&!!node.binding);
    if(selectionKey!==selectionSignature){
      selectionSignature=selectionKey;clearPreview(true);status.textContent="";
      const selected=selection.length===1?shapes.find(shape=>shape.parentId===selection[0]||shape.id===selection[0]):undefined;
      shapeId=selected?.id??"";rangeStart=rangeEnd=0;inspectionSignature="";
    }
    const nextObjectSignature=JSON.stringify(shapes.map(shape=>[shape.id,doc.nodes[shape.parentId]?.name??shape.name]));
    if(nextObjectSignature!==objectSignature){
      objectSignature=nextObjectSignature;objects.replaceChildren(new Option("Choose a bound splat object",""),...shapes.map(shape=>new Option(doc.nodes[shape.parentId]?.name??shape.name,shape.id)));
    }
    const shape=shapes.find(shape=>shape.id===shapeId);
    if(!shape){shapeId="";clearPreview(true);}
    objects.value=shapeId;details.hidden=!shape;empty.hidden=!!shape;
    for(const control of Array.from(element.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>("input,select,button")))control.disabled=!available;
    objects.disabled=!available||!shapes.length;
    if(!shape){previousBinding=undefined;return;}
    if(previousBinding&&previousBinding!==shape.binding&&!shape.binding!.weights&&previousBinding.weights)clearPreview(true);
    previousBinding=shape.binding;
    const nextInfluenceSignature=JSON.stringify([shape.id,shape.binding!.jointIds.map(id=>[id,doc.joints?.find(joint=>joint.id===id)?.name??id])]);
    if(nextInfluenceSignature!==influenceSignature){
      influenceSignature=nextInfluenceSignature;const before=influence.value;
      influence.replaceChildren(...shape.binding!.jointIds.map(id=>new Option(doc.joints?.find(joint=>joint.id===id)?.name??id,id)));
      if(shape.binding!.jointIds.includes(before))influence.value=before;
      inspectionSignature="";
    }
    const context=options.getComponents(shape.id),count=context?.count??0;
    const validContext=!!context&&Number.isSafeInteger(count)&&count>0;
    if(validContext){rangeStart=Math.min(Math.max(0,rangeStart),count-1);rangeEnd=Math.min(Math.max(rangeStart,rangeEnd),count-1);}
    else{rangeStart=rangeEnd=0;clearPreview(true);}
    if(document.activeElement!==first)first.value=String(rangeStart);
    if(document.activeElement!==last)last.value=String(rangeEnd);
    first.max=last.max=String(Math.max(0,count-1));
    if(overrideBinding!==shape.binding){overrideBinding=shape.binding;overrideCount=Object.keys(shape.binding!.weights?.overrides??{}).length;}
    summary.textContent=validContext?`${count.toLocaleString()} components · ${overrideCount.toLocaleString()} authored overrides` : "Waiting for the binding's component data. Empty assets have no editable components.";
    const selectedCount=validContext?rangeEnd-rangeStart+1:0;
    rangeSummary.textContent=`${selectedCount.toLocaleString()} components selected${selectedCount>EDIT_LIMIT?" · exceeds the 20,000-component edit limit":""}. Edits apply to every index, including indices omitted from the preview.`;
    for(const control of [first,last,value,influence,show])control.disabled=!available||!validContext||!influence.value;
    apply.disabled=!available||!validContext||!influence.value||selectedCount>EDIT_LIMIT;
    resetSelected.disabled=!available||!validContext||!overrideCount||selectedCount>EDIT_LIMIT;
    resetAll.disabled=!available||!overrideCount;
    previous.disabled=!available||!validContext||rangeStart===0;
    next.disabled=!available||!validContext||rangeStart>=count-1;
    if(validContext){
      try{
        const weights=context!.getWeights(rangeStart).filter(entry=>entry.weight>0);
        const inspectionKey=JSON.stringify([shape.id,rangeStart,influence.value,weights,doc.joints?.map(joint=>[joint.id,joint.name]),!!shape.binding!.weights?.overrides[String(rangeStart)]]);
        if(inspectionKey!==inspectionSignature){
          inspectionSignature=inspectionKey;weightsBody.replaceChildren();
          for(const entry of weights){const row=document.createElement("tr"),joint=document.createElement("td"),amount=document.createElement("td");joint.textContent=doc.joints?.find(item=>item.id===entry.jointId)?.name??entry.jointId;amount.textContent=entry.weight.toFixed(6);row.append(joint,amount);weightsBody.append(row);}
          if(document.activeElement!==value)requestedWeight=weights.find(entry=>entry.jointId===influence.value)?.weight??0;
          total.textContent=`Normalized total: ${weights.reduce((sum,entry)=>sum+entry.weight,0).toFixed(6)} · ${weights.length} active influences`;
        }
        inspectHeading.textContent=`Component ${rangeStart} · ${shape.binding!.weights?.overrides[String(rangeStart)]?"authored override":"automatic weights"}`;
      }catch(error){inspectHeading.textContent="Component weights unavailable";weightsBody.replaceChildren();total.textContent=error instanceof Error?error.message:String(error);clearPreview(true);apply.disabled=show.disabled=true;}
    }else{weightsBody.replaceChildren();inspectHeading.textContent="Component weights unavailable";total.textContent="";}
    if(document.activeElement!==value)value.value=String(Number(requestedWeight.toFixed(6)));
    const samples=Math.min(PREVIEW_LIMIT,selectedCount);
    previewNote.textContent=`Paused X-ray preview: blue = 0, orange = 1 influence weight. ${samples.toLocaleString()}${samples<selectedCount?` evenly sampled indices of ${selectedCount.toLocaleString()}`:" component indices"}; the full edit range remains unchanged.`;
    if(show.checked&&available&&validContext&&influence.value){
      const signature=`${shape.id}/${rangeStart}/${rangeEnd}/${influence.value}`;
      if(signature!==previewSignature||previewBinding!==shape.binding){
        const indices=Array.from({length:samples},(_,index)=>samples===1?rangeStart:Math.round(rangeStart+(rangeEnd-rangeStart)*(index/(samples-1))));
        options.onPreview({shapeId:shape.id,indices,jointId:influence.value});previewSignature=signature;previewBinding=shape.binding;
      }
    }else clearPreview();
  }
  store.subscribe((state,previous)=>{if(state.document!==previous.document&&state.editLabel==="Reset skin weights")clearPreview(true);refresh();});
  refresh();
  return {element,refresh};
}
