import { buttonContent, type IconName } from "./ui";
import { mountToolPalette } from "./tool-palette";
import { Matrix4, type Quaternion } from "three";
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
  const cube=document.createElement("div");cube.className="camera-cube";cube.setAttribute("aria-label","Camera view cube");
  const solid=document.createElement("div");solid.className="cube-solid";cube.append(solid);
  for(const [name,label] of [["front","Front"],["back","Back"],["left","Left"],["right","Right"],["top","Top"],["bottom","Bottom"]] as const) {
    const b=document.createElement("button");b.type="button";b.textContent=label;b.className=`cube-${name}`;
    b.title=`${label} orthographic view`;b.setAttribute("aria-label",b.title);b.onclick=()=>view(name);
    solid.append(b);views.set(name,b);
  }
  const home=document.createElement("button");home.type="button";home.className="cube-home";home.title="Home view";home.setAttribute("aria-label","Home view");buttonContent(home,"home");home.onclick=reset;cube.append(home);
  host.append(cube);
  const lock=button("viewport-tools-lock","Unlock viewport controls","lock",()=>{});lock.setAttribute("aria-pressed","true");lock.classList.add("viewport-divider");
  host.append(panel);
  panel.style.left=`${Math.max(12,(host.clientWidth-panel.offsetWidth)/2)}px`;
  mountToolPalette({panel:panel.id,handle:handle.id,lock:lock.id},"viewport controls");
  const orientation=new Matrix4();
  return {updateOrientation(q:Quaternion){
    orientation.makeRotationFromQuaternion(q.clone().invert());
    const values=orientation.elements.map((v,i)=>((i%4===1)!==(Math.floor(i/4)===1))?-v:v);
    solid.style.transform=`matrix3d(${values.join(",")})`;
  },setView(name:ViewName){for(const [key,b]of views)b.setAttribute("aria-pressed",String(key===name));}};
}
