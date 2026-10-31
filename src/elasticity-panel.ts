import type { SplatShapeNode } from "./scene-document";
import type { Elasticity } from "./elasticity";
import { propertyInteraction } from "./property-interaction";
export function createElasticityPanel(host: HTMLElement, change:(id:string,value:Elasticity|undefined)=>void) {
 const section=document.createElement("section"); section.className="elasticity-properties"; host.append(section);
 let active:SplatShapeNode|undefined;
 section.innerHTML='<h3>Elasticity</h3><p class="elasticity-scope"></p><div class="elasticity-fields"></div><p class="property-note">Density sets the fill target; Budget caps the total. Distribution: 0 = even, 1 = larger gaps. Spacing is relative to the original neighbor spacing.</p><button type="button">Remove Elasticity</button>';
 const inputs: HTMLInputElement[]=[];
 const refreshLocks:Array<()=>void>=[];
 for(const [key,label,min,max,step,help] of [
  ["stretch","Stretch",0,4,.1,"Existing splat elongation: 0 disables added stretch, 1 follows estimated strain."],
  ["spacing","Spacing",1.05,10,.05,"Neighbor separation ratio that triggers filling; 1.5 means 50% beyond original spacing."],
  ["expansion","Expansion",0,4,.1,"Generated splat elongation relative to estimated strain."],
  ["density","Density",0,8,.1,"Target fill density. Higher values request more splats per gap; 0 disables generation."],
  ["distribution","Distribution",0,1,.1,"0 spreads the budget evenly across gaps; 1 favors larger gaps. Values between blend the two."],
  ["budget","Budget",0,100000,100,"Hard limit on additional splats. Increasing it only fills unmet demand; Density sets the target."],
 ] as const) {
  const labelElement=document.createElement("label"); labelElement.textContent=label; labelElement.title=help;
  const input=document.createElement("input"); input.type="number";input.min=String(min);input.max=String(max);input.step=String(step);input.dataset.key=key;
  refreshLocks.push(propertyInteraction(input,()=>`${active?.id}/elasticity/${key}`));
  input.onchange=()=>{
   if(!active?.elasticity||input.readOnly)return;
   const n=input.valueAsNumber;
   if(!Number.isFinite(n)||n<min||n>max||(key==="budget"&&!Number.isInteger(n))){input.value=String(active.elasticity[key]??(key==="density"?1:0));return;}
   change(active.id,{...active.elasticity,[key]:n});
  }; labelElement.append(input); section.querySelector(".elasticity-fields")!.append(labelElement); inputs.push(input);
 }
 section.querySelector("button")!.onclick=()=>{if(active)change(active.id,undefined);};
 return {update(shape:SplatShapeNode|undefined,names:Map<string,string>){
  active=shape; section.hidden=!shape?.elasticity;
  refreshLocks.forEach(refresh=>refresh());
  if(!shape?.elasticity)return;
  section.querySelector(".elasticity-scope")!.textContent=shape.elasticity.joints===null ? "Scope: all bound joint connections" : `Scope: connections between ${shape.elasticity.joints.map(id=>names.get(id)??"Missing joint").join(", ")}`;
  for(const input of inputs) if(document.activeElement!==input)input.value=String(shape.elasticity[input.dataset.key as "stretch"]??(input.dataset.key==="density"?1:0));
 }};
}
