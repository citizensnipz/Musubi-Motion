import { buttonContent, type IconName } from "./ui";
import { mountToolPalette } from "./tool-palette";
export type ViewName="perspective"|"front"|"back"|"left"|"right"|"top"|"bottom";
export function mountViewportTools(host:HTMLElement,visibility:(kind:"grid"|"gizmos"|"joints",visible:boolean)=>void,view:(name:ViewName)=>void,reset:()=>void) {
  const panel=document.createElement("div");panel.id="viewport-tools";panel.setAttribute("aria-label","Viewport controls");
  panel.setAttribute("role","toolbar");panel.setAttribute("aria-orientation","horizontal");
  const handle=document.createElement("button");handle.id="viewport-tools-drag";handle.type="button";handle.setAttribute("aria-label","Move viewport controls");handle.setAttribute("aria-disabled","true");buttonContent(handle,"grip");panel.append(handle);
  const button=(id:string,label:string,icon:IconName,click:()=>void,text?:string)=>{
    const b=document.createElement("button");b.id=id;b.type="button";b.title=label;b.setAttribute("aria-label",label);buttonContent(b,icon,text);b.onclick=click;panel.append(b);return b;
  };
  for(const [kind,icon] of [["grid","grid"],["gizmos","translate"],["joints","bone"]] as const) {
    const b=button(`visibility-${kind}`,`Show ${kind}`,icon,()=>{const visible=b.getAttribute("aria-pressed")!=="true";b.setAttribute("aria-pressed",String(visible));visibility(kind,visible);});b.setAttribute("aria-pressed","true");
  }
  const resetButton=button("viewport-reset","Reset camera","rest",reset);
  resetButton.classList.add("viewport-divider");
  const views=new Map<ViewName,HTMLButtonElement>();
  for(const [name,short] of [["perspective","P"],["front","F"],["back","B"],["left","L"],["right","R"],["top","T"],["bottom","Bt"]] as const) {
    const b=button(`view-${name}`,name==="perspective"?"Perspective view":`${name[0].toUpperCase()+name.slice(1)} orthographic view`,"object",()=>view(name),short);
    b.classList.add("camera-view");views.set(name,b);
  }
  const lock=button("viewport-tools-lock","Unlock viewport controls","lock",()=>{});lock.setAttribute("aria-pressed","true");lock.classList.add("viewport-divider");
  host.append(panel);
  panel.style.left=`${Math.max(12,(host.clientWidth-panel.offsetWidth)/2)}px`;
  mountToolPalette({panel:panel.id,handle:handle.id,lock:lock.id},"viewport controls");
  return {setView(name:ViewName){for(const [key,b]of views)b.setAttribute("aria-pressed",String(key===name));}};
}
