import * as THREE from "three";
import { ikChain, jointWorldMatrices, type IKHandle } from "./ik.ts";
import type { AnimationPose } from "./animation.ts";
import type { SceneDocument } from "./scene-document.ts";

type TargetView = {
  id: string;
  kind: IKControlKind;
  object: THREE.Group;
  marker: THREE.LineSegments;
  picker: THREE.Mesh;
  link: THREE.Line;
  positions: THREE.BufferAttribute;
  glyphMaterial: THREE.LineBasicMaterial;
  linkMaterial: THREE.LineBasicMaterial;
  enabled: boolean;
  blend: number;
};
export type IKControlKind = "target" | "pole";

/** Viewport-only IK markers. Scene handles remain the authoritative saved data. */
export function createIKTargets(world: THREE.Scene) {
  const layer = new THREE.Group(); layer.name = "IK target overlays"; world.add(layer);
  const targets = new Map<string, TargetView>();
  let selected: string | undefined, disposed = false;
  const key = (id: string, kind: IKControlKind) => `${id}:${kind}`;
  const tip = .13, radius = .085;
  // Original six-point wire glyph: an octahedron with three extended cross axes.
  const vertices: number[] = [];
  const points = [[radius,0,0],[-radius,0,0],[0,radius,0],[0,-radius,0],[0,0,radius],[0,0,-radius]];
  for (let a=0;a<points.length;a++) for(let b=a+1;b<points.length;b++) {
    if(Math.floor(a/2)!==Math.floor(b/2))vertices.push(...points[a],...points[b]);
  }
  vertices.push(-tip,0,0,tip,0,0, 0,-tip,0,0,tip,0, 0,0,-tip,0,0,tip);
  const glyphGeometry = new THREE.BufferGeometry();
  glyphGeometry.setAttribute("position",new THREE.Float32BufferAttribute(vertices,3));
  const pickGeometry = new THREE.SphereGeometry(.14,8,6);
  // Picking is explicit; this mesh never contributes a draw call or depth write.
  const pickMaterial = new THREE.MeshBasicMaterial({visible:false});
  const endPosition = new THREE.Vector3();

  function appearance(id: string, target: TargetView) {
    const active = id === selected;
    target.glyphMaterial.color.setHex(active ? 0xffbe64 : target.enabled ? target.kind === "pole" ? 0xc19bd4 : 0x8db6d0 : 0x919191);
    target.glyphMaterial.opacity = target.enabled ? active ? 1 : .45 + .45*target.blend : .24;
    target.linkMaterial.color.copy(target.glyphMaterial.color);
    target.linkMaterial.opacity = target.enabled ? active ? .65 : .2 + .15*target.blend : .12;
    target.object.userData.selected = active;
  }

  function create(handle: IKHandle, kind: IKControlKind): TargetView {
    const object = new THREE.Group(); object.userData.ikHandleId = handle.id; object.userData.ikControlKind = kind; layer.add(object);
    const glyphMaterial = new THREE.LineBasicMaterial({color:0x8db6d0,transparent:true,depthTest:false,depthWrite:false});
    const marker = new THREE.LineSegments(glyphGeometry,glyphMaterial); marker.renderOrder = 100003; object.add(marker);
    const picker = new THREE.Mesh(pickGeometry,pickMaterial); picker.userData.ikHandleId = handle.id; picker.userData.ikControlKind = kind; object.add(picker);
    const linkGeometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(6),3); positions.setUsage(THREE.DynamicDrawUsage);
    linkGeometry.setAttribute("position",positions);
    const linkMaterial = new THREE.LineBasicMaterial({color:0x8db6d0,transparent:true,depthTest:false,depthWrite:false});
    const link = new THREE.Line(linkGeometry,linkMaterial); link.renderOrder = 100002;
    link.frustumCulled = false; link.userData.ikHandleLink = handle.id; link.userData.ikControlKind = kind; layer.add(link);
    const target = {id:handle.id,kind,object,marker,picker,link,positions,glyphMaterial,linkMaterial,enabled:handle.enabled,blend:handle.blend};
    targets.set(key(handle.id,kind),target); return target;
  }

  function remove(target: TargetView) {
    target.object.removeFromParent(); target.link.removeFromParent();
    target.link.geometry.dispose(); target.glyphMaterial.dispose(); target.linkMaterial.dispose();
  }

  function sync(doc: SceneDocument, poses: ReadonlyMap<string, AnimationPose>) {
    if(disposed)return;
    const handles = doc.ikHandles ?? [], retained = new Set(handles.flatMap(handle=>[key(handle.id,"target"),
      ...(handle.solver === "two-bone" && handle.poleTarget ? [key(handle.id,"pole")] : [])]));
    for(const [id,target]of targets)if(!retained.has(id)){remove(target);targets.delete(id);}
    if(selected&&!retained.has(selected))selected=undefined;
    // The IK helper reuses its bone hierarchy; only fresh endpoint matrices are needed.
    const matrices = handles.length ? jointWorldMatrices(doc,poses) : undefined;
    for(const handle of handles){
      const kinds: IKControlKind[] = handle.solver === "two-bone" && handle.poleTarget ? ["target","pole"] : ["target"];
      for(const kind of kinds){
      const controlKey = key(handle.id,kind), point = kind === "pole" ? handle.poleTarget! : handle.target;
      const target = targets.get(controlKey) ?? create(handle,kind);
      target.object.position.fromArray(point);
      target.object.name = `${handle.name} · ${kind} · ${handle.enabled ? `IK ${Math.round(handle.blend*100)}%` : "disabled"}`;
      target.object.userData.enabled = handle.enabled; target.object.userData.blend = handle.blend;
      target.enabled = handle.enabled; target.blend = handle.blend; appearance(controlKey,target);
      const endpoint = matrices?.get(kind === "pole" ? ikChain(doc,handle.rootId,handle.endId)[1] : handle.endId);
      target.link.visible = !!endpoint;
      if(!endpoint)continue;
      endPosition.setFromMatrixPosition(endpoint);
      const values = target.positions.array as Float32Array;
      const next = [point[0],point[1],point[2],endPosition.x,endPosition.y,endPosition.z];
      let changed = false;
      for(let i=0;i<6;i++)if(values[i]!==Math.fround(next[i])){values[i]=next[i];changed=true;}
      if(changed)target.positions.needsUpdate=true;
      }
    }
    layer.updateMatrixWorld(true);
  }

  return {
    sync,
    getObject(id: string, kind: IKControlKind = "target"): THREE.Object3D | undefined { return targets.get(key(id,kind))?.object; },
    pick(raycaster: THREE.Raycaster): string | undefined { return this.pickControl(raycaster)?.id; },
    pickControl(raycaster: THREE.Raycaster): {id:string;kind:IKControlKind} | undefined {
      if(disposed)return;
      for(let ancestor:THREE.Object3D|null=layer;ancestor;ancestor=ancestor.parent)if(!ancestor.visible)return;
      layer.updateWorldMatrix(true,true);
      const pickers = [...targets.values()].filter(target=>target.enabled&&target.object.visible).map(target=>target.picker);
      const hit = raycaster.intersectObjects(pickers,false)[0]?.object.userData;
      return hit ? {id:hit.ikHandleId as string,kind:hit.ikControlKind as IKControlKind} : undefined;
    },
    setSelected(id?: string, kind: IKControlKind = "target") { selected=id ? key(id,kind) : undefined;for(const [key,target]of targets)appearance(key,target); },
    setVisible(visible: boolean) { layer.visible=visible; },
    dispose() {
      if(disposed)return;disposed=true;
      for(const target of targets.values())remove(target);targets.clear();
      glyphGeometry.dispose();pickGeometry.dispose();pickMaterial.dispose();layer.removeFromParent();
    },
  };
}
