import { createController, findControllerShape, patchedControllerShape, rebuildControllerCurve, updateControllerShape,
  type ControllerPlane, type ControllerPreset, type CurveControlPoint } from "./controller-curves.ts";
import type { CurveShapeNode, TransformChannels } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import { propertyInteraction } from "./property-interaction.ts";

type Options = {
  available: () => boolean;
  getSelection: () => string[];
  getPlacement: () => TransformChannels | undefined;
  onSelect: (transformId: string) => void;
  onUseDriver?: (transformId: string) => void;
  onPreviewShape?: (shape?: CurveShapeNode) => void;
};

export function createControllerPanel(store: SceneStore, options: Options) {
  const element = document.createElement("section"); element.className = "controller-panel";
  element.setAttribute("aria-label", "Curve Controls");
  const style = document.createElement("style");
  style.textContent = `.controller-panel{height:100%;overflow:auto;padding:12px;font-size:12px;color:var(--text);background:var(--panel)}
    .controller-panel p{color:var(--muted);line-height:1.5}.controller-panel fieldset{min-width:0;border:1px solid var(--line);padding:10px;margin:0 0 12px}.controller-panel legend{padding:0 5px}
    .controller-panel label{display:grid;gap:5px;margin:8px 0}.controller-panel input,.controller-panel select,.controller-panel textarea,.controller-panel button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0}
    .controller-panel input:not([type=checkbox]):not([type=radio]),.controller-panel select,.controller-panel textarea{width:100%}.controller-panel :disabled{opacity:.45;cursor:default}
    .controller-panel button{cursor:pointer}.controller-panel button:hover:not(:disabled){background:var(--hover)}.controller-panel input:focus-visible,.controller-panel select:focus-visible,.controller-panel button:focus-visible,.controller-panel textarea:focus-visible{outline:1px solid var(--strong)}
    .controller-panel .controller-check{display:flex;align-items:center;gap:7px}.controller-panel .controller-actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.controller-panel .controller-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .controller-panel .controller-grid label{min-width:0}.controller-panel .controller-status{min-height:18px;overflow-wrap:anywhere}.controller-panel .controller-status[data-error=true]{color:#ce756a}
    .controller-panel .controller-cvs{overflow:auto;max-height:340px;border:1px solid var(--line)}.controller-panel table{border-collapse:collapse;width:100%;min-width:340px}.controller-panel th,.controller-panel td{padding:4px;text-align:left;border-bottom:1px solid var(--line)}
    .controller-panel th{position:sticky;top:0;background:var(--header);font-size:10px;color:var(--muted)}.controller-panel td input[type=number]{min-width:58px;padding:4px;font-size:11px}.controller-panel tr[data-selected=true]{background:var(--hover)}
    .controller-panel input[type=number]{text-align:right}.controller-panel td label{display:flex;gap:3px;align-items:center;margin:0;font-size:10px}.controller-panel td input[type=radio]{margin:0}.controller-panel details{margin:12px 0}.controller-panel summary{cursor:pointer;color:var(--muted)}.controller-panel textarea{font-family:monospace;font-size:11px;resize:vertical}`;
  element.append(style);
  const intro = document.createElement("p"); intro.textContent = "Create editable NURBS curve controls. Animate their transforms or use them as drivers for constraints and Set Driven Key."; element.append(intro);
  function label(text: string, control: HTMLElement) { const node=document.createElement("label");node.append(document.createTextNode(text),control);return node; }
  function button(text:string,action:()=>void){const node=document.createElement("button");node.type="button";node.textContent=text;node.onclick=action;return node;}
  function select(name:string){const node=document.createElement("select");node.setAttribute("aria-label",name);return node;}
  function number(name:string,value:string){const node=document.createElement("input");node.type="number";node.step="any";node.value=value;node.setAttribute("aria-label",name);return node;}
  function group(title:string){const fieldset=document.createElement("fieldset"),legend=document.createElement("legend");legend.textContent=title;fieldset.append(legend);return fieldset;}
  const status=document.createElement("p");status.className="controller-status";status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  function run(action:()=>void,message=""){
    if(!options.available()){status.textContent="Pause playback and finish the current operation before editing curve controls.";status.dataset.error="true";return;}
    try{action();status.textContent=message;status.dataset.error="false";refresh();}
    catch(error){status.textContent=error instanceof Error?error.message:String(error);status.dataset.error="true";refresh();}
  }
  function finite(input:HTMLInputElement){
    if(!input.value.trim()||!Number.isFinite(input.valueAsNumber))throw Error(`${input.getAttribute("aria-label")} must be a finite number.`);
    return input.valueAsNumber;
  }
  function onCommit(input:HTMLInputElement,action:()=>void){
    let cancel=false;
    input.addEventListener("blur",()=>{if(!cancel)run(action);cancel=false;refresh();});
    input.addEventListener("keydown",event=>{
      if(event.key==="Enter"){event.preventDefault();input.blur();}
      else if(event.key==="Escape"){event.preventDefault();cancel=true;input.blur();refresh();}
      // Save/Open and native text-editing shortcuts keep their host behavior.
    });
  }
  const creation=group("Create curve control");
  const newName=document.createElement("input");newName.type="text";newName.maxLength=80;newName.value="curveControl";newName.setAttribute("aria-label","New controller name");
  const preset=select("Controller preset"),plane=select("Controller plane");
  for(const value of ["circle","square","arrow"])preset.add(new Option(value[0].toUpperCase()+value.slice(1),value));
  for(const value of ["XY","XZ","YZ"])plane.add(new Option(value,value));plane.value="XZ";
  const size=number("Controller size","1");size.min="0.000001";size.max="1000000";
  const placement=document.createElement("input");placement.type="checkbox";
  const placementLabel=label("Match selected world pose",placement);placementLabel.className="controller-check";
  const placementNote=document.createElement("p");placementNote.textContent="Unchecked: create at the origin. Select one object or joint to match its world transform and create an independent root control.";
  const creationGrid=document.createElement("div");creationGrid.className="controller-grid";
  creationGrid.append(label("Preset",preset),label("Plane",plane),label("Radius / half-size",size));
  const create=button("Create curve control",()=>run(()=>{
    let channels:TransformChannels|undefined;
    if(placement.checked){channels=options.getPlacement();if(!channels)throw Error("Select an object or joint with a valid world transform to match its pose.");}
    const id=createController(store,preset.value as ControllerPreset,{name:newName.value,plane:plane.value as ControllerPlane,size:finite(size),...channels});
    activeId=id;selectedCV=0;options.onSelect(id);
  },"Curve control created. Use its transform to animate or drive a constraint."));
  creation.append(label("Name",newName),creationGrid,placementLabel,placementNote,create);element.append(creation);
  const controllers=select("Selected curve control");element.append(label("Curve controls",controllers));
  const empty=document.createElement("p");empty.textContent="Select a curve control in the viewport, Outliner or list above to edit its shape.";element.append(empty);
  const shapeFields=group("Curve shape");
  const summary=document.createElement("p");shapeFields.append(summary);
  shapeFields.append(button("Use as Set Driven Key driver",()=>run(()=>{
    const shape=current();options.onSelect(shape.parentId);options.onUseDriver?.(shape.parentId);
  })));
  const color=document.createElement("input");color.type="color";color.setAttribute("aria-label","Controller curve color");
  const closed=document.createElement("input");closed.type="checkbox";
  const closedLabel=label("Close endpoint seam",closed);closedLabel.className="controller-check";
  const shapeGrid=document.createElement("div");shapeGrid.className="controller-grid";shapeGrid.append(label("Curve color",color),closedLabel);shapeFields.append(shapeGrid);
  const closureNote=document.createElement("p");closureNote.textContent="Closing joins the displayed endpoints; it does not make a periodic NURBS curve. Control vertices are in the controller's local space.";shapeFields.append(closureNote);
  const degree=select("Rebuild curve degree");for(const value of [1,2,3])degree.add(new Option(`${value}${value===1?" · linear":value===2?" · quadratic":" · cubic"}`,String(value)));
  const rebuild=button("Rebuild uniform knots",()=>run(()=>{const shape=current();rebuildControllerCurve(store,shape.id,Number(degree.value) as 1|2|3);},"Curve rebuilt with clamped uniform knots. Undo restores the previous shape."));
  const rebuildNote=document.createElement("p");rebuildNote.textContent="Rebuild changes the shape by replacing custom knots. CV positions and weights remain; a rational circle can lose its exact circular shape.";
  shapeFields.append(label("Degree for rebuild",degree),rebuild,rebuildNote);
  const tableWrap=document.createElement("div");tableWrap.className="controller-cvs";
  const table=document.createElement("table");table.setAttribute("aria-label","Controller control vertices");
  const head=document.createElement("thead"),headRow=document.createElement("tr");
  for(const title of ["CV","Local X","Local Y","Local Z","Weight"]){const cell=document.createElement("th");cell.scope="col";cell.textContent=title;headRow.append(cell);}head.append(headRow);table.append(head);
  const rows=document.createElement("tbody");table.append(rows);tableWrap.append(table);shapeFields.append(tableWrap);
  const add=button("Insert CV · rebuild knots",()=>run(()=>{
    const shape=current(),index=Math.max(0,Math.min(selectedCV,shape.points.length-1));
    const point=shape.points[index],next=shape.points[index+1]??point;
    const inserted=point.map((value,axis)=>(value+next[axis])/2) as CurveControlPoint;
    const points=shape.points.map(point=>[...point] as CurveControlPoint);points.splice(index+1,0,inserted);
    rebuildControllerCurve(store,shape.id,shape.degree,points);selectedCV=index+1;
  },"Control vertex inserted and knots rebuilt. Edit its local coordinates below."));
  add.title="Insert after the selected CV, then rebuild clamped uniform knots. This changes the shape.";
  const remove=button("Remove CV · rebuild knots",()=>run(()=>{
    const shape=current(),points=shape.points.filter((_,index)=>index!==selectedCV);
    rebuildControllerCurve(store,shape.id,shape.degree,points);selectedCV=Math.min(selectedCV,points.length-1);
  },"Control vertex removed and knots rebuilt. Undo restores the previous shape."));
  remove.title="Remove the selected CV and rebuild clamped uniform knots. At least degree + 1 vertices must remain.";
  const cvActions=document.createElement("div");cvActions.className="controller-actions";cvActions.append(add,remove);shapeFields.append(cvActions);
  const cvNote=document.createElement("p");cvNote.textContent="Select a CV with its radio button. Coordinates and weights preview as you type or middle-drag; Enter, leaving the field or releasing commits one undo step. Escape cancels. Right-click a number to Lock/Unlock. Inserting or removing a CV rebuilds knots and changes the shape.";shapeFields.append(cvNote);
  const advanced=document.createElement("details"),advancedLabel=document.createElement("summary");advancedLabel.textContent="Advanced knot vector";
  const knots=document.createElement("textarea");knots.rows=3;knots.setAttribute("aria-label","Controller knot vector");
  const applyKnots=button("Apply knot vector",()=>run(()=>{
    const shape=current(),values=knots.value.trim().split(/[\s,]+/).map(Number);
    if(!knots.value.trim()||!values.every(Number.isFinite))throw Error("Enter finite knot values separated by spaces or commas.");
    updateControllerShape(store,shape.id,{knots:values});
  },"Knot vector updated. Undo restores the previous curve."));
  const knotNote=document.createElement("p");knotNote.textContent="Use CV count + degree + 1 ordered knots. Changing knots can alter the shape; invalid vectors are rejected without changing the scene.";
  advanced.append(advancedLabel,label("Knot values",knots),applyKnots,knotNote);shapeFields.append(advanced);
  element.append(shapeFields,status);
  let activeId="",selectedCV=0,selectionSignature="",controllerSignature="",tableSignature="",lastShape:CurveShapeNode|undefined;
  const cvInputs:Array<{input:HTMLInputElement;index:number;axis:number}>=[];
  const cvSelections:Array<{radio:HTMLInputElement;row:HTMLTableRowElement;index:number}>=[];
  const radioName=`controller-cv-${crypto.randomUUID()}`;
  function current():CurveShapeNode{const shape=findControllerShape(store.getState().document,activeId);if(!shape)throw Error("Select a curve control first.");return shape;}
  color.onchange=()=>run(()=>{const shape=current();updateControllerShape(store,shape.id,{color:color.value});});
  closed.onchange=()=>run(()=>{const shape=current();updateControllerShape(store,shape.id,{closed:closed.checked});});
  controllers.onchange=()=>{activeId=controllers.value;selectedCV=0;status.textContent="";if(activeId)options.onSelect(activeId);refresh();};
  placement.onchange=()=>refresh();
  function renderCVs(shape:CurveShapeNode){
    rows.replaceChildren();cvInputs.length=0;cvSelections.length=0;
    for(let index=0;index<shape.points.length;index++){
      const row=document.createElement("tr"),indexCell=document.createElement("td"),selectLabel=document.createElement("label"),radio=document.createElement("input");
      radio.type="radio";radio.name=radioName;radio.setAttribute("aria-label",`Select CV ${index}`);
      radio.onchange=()=>{selectedCV=index;refresh();};selectLabel.append(radio,String(index));indexCell.append(selectLabel);row.append(indexCell);cvSelections.push({radio,row,index});
      for(let axis=0;axis<4;axis++){
        const cell=document.createElement("td"),input=number(`CV ${index} ${axis===3?"weight":"XYZ"[axis]}`,String(shape.points[index][axis]));
        if(axis===3){input.min="0.000001";input.max="1000000";}else{input.min="-1000000";input.max="1000000";}
        input.step=axis===3?"0.01":"0.1";
        const shapeId=shape.id;
        const patch=()=>{
          const latest=store.getState().document.nodes[shapeId];if(latest?.type!=="curveShape"||!latest.points[index])return;
          const points=latest.points.map(point=>[...point] as CurveControlPoint);points[index][axis]=finite(input);
          return {latest,points};
        };
        const preview=()=>{try{const value=patch();if(value)options.onPreviewShape?.(patchedControllerShape(value.latest,{points:value.points}));status.textContent="";}catch(error){options.onPreviewShape?.();status.textContent=error instanceof Error?error.message:String(error);}};
        const commit=()=>{options.onPreviewShape?.();const value=patch();if(value)updateControllerShape(store,shapeId,{points:value.points});};
        onCommit(input,commit);
        input.addEventListener("input",preview);
        input.addEventListener("blur",()=>options.onPreviewShape?.());
        input.addEventListener("keydown",event=>{if(event.key==="Escape")options.onPreviewShape?.();});
        // Native typing commits on blur above; the scrub helper emits its own
        // change on release. A native change during Escape's blur must not commit.
        input.addEventListener("change",event=>{if(!event.isTrusted)run(commit);});
        input.addEventListener("pointerdown",event=>{if(event.button===1)input.focus();});
        propertyInteraction(input,()=>`${shapeId}/cv/${index}/${axis}`,undefined,()=>({update:preview,end:()=>options.onPreviewShape?.()}));
        cvInputs.push({input,index,axis});cell.append(input);row.append(cell);
      }
      rows.append(row);
    }
  }
  function refresh(){
    const doc=store.getState().document,available=options.available(),selection=options.getSelection(),selectionKey=selection.join("|");
    if(selectionSignature!==selectionKey){options.onPreviewShape?.();selectionSignature=selectionKey;const selected=findControllerShape(doc,selection.at(-1)??"");activeId=selected?.parentId??"";selectedCV=0;}
    const shapes=Object.values(doc.nodes).filter((node):node is CurveShapeNode=>node.type==="curveShape");
    const signature=JSON.stringify(shapes.map(shape=>[shape.parentId,doc.nodes[shape.parentId]?.name]));
    if(signature!==controllerSignature){
      controllerSignature=signature;controllers.replaceChildren(new Option("Choose a curve control",""),...shapes.map(shape=>new Option(doc.nodes[shape.parentId]?.name??shape.name,shape.parentId)));
    }
    const shape=findControllerShape(doc,activeId);if(!shape)activeId="";
    controllers.value=activeId;shapeFields.hidden=!shape;empty.hidden=!!shape;
    for(const control of Array.from(element.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement|HTMLTextAreaElement>("input,select,button,textarea")))control.disabled=!available;
    create.disabled=!available||(placement.checked&&!selection.length);
    controllers.disabled=!available||!shapes.length;
    if(!shape){lastShape=undefined;return;}
    const switched=lastShape?.id!==shape.id;
    selectedCV=Math.max(0,Math.min(selectedCV,shape.points.length-1));
    summary.textContent=`${doc.nodes[shape.parentId]?.name??shape.name} · Degree ${shape.degree} · ${shape.points.length} CVs · ${shape.knots.length} knots`;
    if(switched||document.activeElement!==color)color.value=shape.color;
    closed.checked=shape.closed;
    if(switched||lastShape?.degree!==shape.degree)degree.value=String(shape.degree);
    for(const option of Array.from(degree.options))option.disabled=Number(option.value)>=shape.points.length;
    if(Number(degree.value)>=shape.points.length)degree.value=String(shape.degree);
    const nextTable=`${shape.id}/${shape.points.length}`;
    if(nextTable!==tableSignature){tableSignature=nextTable;renderCVs(shape);}
    for(const {input,index,axis}of cvInputs){input.disabled=!available;if(document.activeElement!==input)input.value=String(shape.points[index][axis]);}
    for(const {radio,row,index}of cvSelections){radio.disabled=!available;radio.checked=index===selectedCV;row.dataset.selected=String(index===selectedCV);}
    add.disabled=!available||shape.points.length>=128;
    remove.disabled=!available||shape.points.length<=shape.degree+1;
    if(switched||(lastShape!==shape&&document.activeElement!==knots))knots.value=shape.knots.join(", ");
    lastShape=shape;
  }
  store.subscribe(refresh);refresh();
  return {element,refresh,createPreset(value:ControllerPreset){preset.value=value;placement.checked=options.getSelection().length===1;create.click();}};
}
