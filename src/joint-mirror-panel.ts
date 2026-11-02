import { buildJointMirrorPairs, mirrorJointPose, mirrorJointSubtree, type MirrorAxis } from "./joint-mirror.ts";
import type { AnimationPose } from "./animation.ts";
import type { SceneStore } from "./scene-store.ts";

export function bindJointMirrorControls(
  controls: Iterable<EventTarget & { disabled: boolean; title: string }>,
  open: () => void,
) {
  for (const control of new Set(controls)) {
    control.disabled = false;
    control.title = "Mirror a joint subtree or pose";
    control.addEventListener("click", open);
  }
}

export function createJointMirrorPanel(store: SceneStore, options: {
  available(): boolean; getSelection(): string[]; getFKPoses(): ReadonlyMap<string, AnimationPose>;
  getFrame(): number; canKey(): boolean; onSelect?(id: string): void;
  preserveDrafts(consumedIds: string[], action: () => void): void;
}) {
  const element=document.createElement("section");element.className="joint-mirror-panel";element.setAttribute("aria-label","Joint mirroring");
  const style=document.createElement("style");style.textContent=`.joint-mirror-panel{height:100%;overflow:auto;box-sizing:border-box;padding:12px;background:var(--panel);color:var(--text);font-size:12px}.joint-mirror-panel p{line-height:1.5;color:var(--muted)}.joint-mirror-panel label{display:grid;gap:5px;margin:10px 0}.joint-mirror-panel input,.joint-mirror-panel select,.joint-mirror-panel button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0;box-sizing:border-box}.joint-mirror-panel select,.joint-mirror-panel input{width:100%}.joint-mirror-panel button{cursor:pointer;margin:0 5px 7px 0}.joint-mirror-panel :disabled{opacity:.45}.joint-mirror-panel [data-error=true]{color:#ce756a}`;
  function label(text:string,node:HTMLElement){const result=document.createElement("label");result.append(text,node);return result;}
  function button(text:string,action:()=>void){const node=document.createElement("button");node.type="button";node.textContent=text;node.onclick=()=>run(action);return node;}
  const root=document.createElement("select");root.setAttribute("aria-label","Mirror source root");
  const axis=document.createElement("select");axis.setAttribute("aria-label","Mirror plane normal");["X","Y","Z"].forEach(value=>axis.add(new Option(`${value} = 0 plane`,value)));
  const search=document.createElement("input"),replace=document.createElement("input");search.value="L_";replace.value="R_";search.setAttribute("aria-label","Mirror name search");replace.setAttribute("aria-label","Mirror name replacement");
  const intro=document.createElement("p");intro.textContent="Mirror a joint subtree across a world origin plane, or reflect its current prepared FK pose onto existing joints paired by name. Source and destination names must be unambiguous.";
  const details=document.createElement("p");details.textContent="Duplicate creates a separate root hierarchy from authored joints and preserves reflected right-handed frames. It copies orientation and preferred angles; animation, IK handles, controls, constraints and bindings stay on the source. Pose mirroring uses current FK before IK. Static pose writes require unanimated targets; keying writes position and rotation through the active animation layer.";
  const status=document.createElement("p");status.setAttribute("role","status");
  function run(action:()=>void){if(!options.available())return;try{action();status.dataset.error="false";}catch(error){status.textContent=error instanceof Error?error.message:String(error);status.dataset.error="true";}refresh();}
  const selected=button("Use selected root",()=>{const id=options.getSelection().find(id=>store.getState().document.joints?.some(joint=>joint.id===id));if(!id)throw Error("Select a joint first.");root.value=id;});
  const duplicate=button("Mirror joint subtree",()=>{let count=0;options.preserveDrafts([],()=>{count=mirrorJointSubtree(store,root.value,{axis:axis.value as MirrorAxis,search:search.value,replace:replace.value}).size;});status.textContent=`Created ${count} mirrored joints.`;});
  function pose(key:boolean){if(key&&!options.canKey())throw Error("Switch to Animation mode before keying a mirrored pose.");const pairs=buildJointMirrorPairs(store.getState().document,root.value,search.value,replace.value);options.preserveDrafts([...pairs.values()],()=>mirrorJointPose(store,pairs,axis.value as MirrorAxis,options.getFKPoses(),key?{frame:options.getFrame()}:{}));status.textContent=`Mirrored ${pairs.size} joint poses${key?" and keyed them":""}.`;}
  const apply=button("Mirror FK pose",()=>pose(false)),key=button("Mirror FK pose and key",()=>pose(true));
  element.append(style,intro,label("Source subtree",root),selected,label("World mirror plane",axis),label("Find in source names",search),label("Replace with",replace),details,duplicate,apply,key,status);
  let joints:unknown;
  function refresh(){const doc=store.getState().document;if(joints!==doc.joints){const value=root.value;root.replaceChildren(...(doc.joints??[]).map(joint=>new Option(joint.name,joint.id)));if(doc.joints?.some(joint=>joint.id===value))root.value=value;joints=doc.joints;}const available=options.available();[root,axis,search,replace,selected].forEach(node=>node.disabled=!available);duplicate.disabled=apply.disabled=!available||!root.value;key.disabled=apply.disabled||!options.canKey();}
  function useSelection(){refresh();const id=options.getSelection().find(id=>store.getState().document.joints?.some(joint=>joint.id===id));if(id)root.value=id;refresh();}
  const unsubscribe=store.subscribe(refresh);refresh();return {element,refresh,useSelection,dispose:unsubscribe};
}
