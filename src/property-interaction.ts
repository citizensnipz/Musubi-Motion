// Shared inspector behavior. Locks are per object/field for this editor session.
const locks=new Set<string>();
let menu:HTMLElement|undefined;
export function propertyInteraction(input:any,key:()=>string,handle?:HTMLElement) {
  const refresh=()=>{input.readOnly=locks.has(key());input.readonly=input.readOnly;input.toggleAttribute("data-locked",input.readOnly);};
  input.addEventListener("contextmenu",(event:MouseEvent)=>{
    event.preventDefault();menu?.remove();refresh();
    const popup=document.createElement("div");popup.className="property-context";popup.setAttribute("role","menu");
    const button=document.createElement("button");button.textContent=input.readOnly?"Unlock":"Lock";button.setAttribute("role","menuitem");
    button.onclick=()=>{const id=key();if(locks.has(id))locks.delete(id);else locks.add(id);refresh();popup.remove();};
    popup.append(button);document.body.append(popup);popup.style.left=`${Math.min(event.clientX,innerWidth-110)}px`;popup.style.top=`${Math.min(event.clientY,innerHeight-45)}px`;menu=popup;button.focus();
    const close=(e:Event)=>{if(!popup.contains(e.target as Node)){popup.remove();document.removeEventListener("pointerdown",close,true);}};
    document.addEventListener("pointerdown",close,true);popup.onkeydown=e=>{if(e.key==="Escape"){popup.remove();input.focus();}};
  });
  if(handle){
    handle.title="Middle-drag left/right to adjust";
    handle.addEventListener("pointerdown",e=>{
      if(e.button!==1||locks.has(key())||input.disabled)return;
      e.preventDefault();const start=e.clientX,value=Number(input.value),id=key();
      handle.setPointerCapture(e.pointerId);
      const move=(m:PointerEvent)=>{if(key()!==id)return;const step=Number(input.step)||.1;const min=input.min==null?-Infinity:Number(input.min);input.value=String(Math.max(min,Number((value+(m.clientX-start)*step*.1).toFixed(5))));};
      const end=()=>{handle.removeEventListener("pointermove",move);handle.removeEventListener("pointerup",end);handle.removeEventListener("pointercancel",end);if(key()===id)input.dispatchEvent(new Event("change",{bubbles:true}));};
      handle.addEventListener("pointermove",move);handle.addEventListener("pointerup",end);handle.addEventListener("pointercancel",end);
    });
    handle.addEventListener("auxclick",e=>e.preventDefault());
  }
  return refresh;
}

