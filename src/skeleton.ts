import * as THREE from "three";
import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type { SceneStore } from "./scene-store.ts";
import { jointLocalMatrix, jointLocalQuaternion, jointRotationFromQuaternion, validateJointAngle } from "./joint-transform.ts";
export type Joint = { id: string; name: string; parentId: string | null; position: [number, number, number]; rotation?: [number, number, number]; orientation?: [number, number, number]; showLocalAxes?: boolean; preferredAngle?: [number, number, number] };
export function validateJoints(joints: Joint[]) {
  if (!Array.isArray(joints) || joints.length > 1000) throw Error("Invalid joints");
  const ids = new Set(joints.map(j => j.id));
  if (ids.size !== joints.length) throw Error("Duplicate joint IDs");
  for (const j of joints) {
    if (j.orientation !== undefined) validateJointAngle(j.orientation);
    if (j.showLocalAxes !== undefined && typeof j.showLocalAxes !== "boolean") throw Error("Invalid joint local-axis visibility");
    if (j.rotation !== undefined && (!Array.isArray(j.rotation) || j.rotation.length !== 3 || ![0, 1, 2].every(index => Number.isFinite(j.rotation![index])))) throw Error("Invalid joint rotation");
    if (j.preferredAngle !== undefined && (!Array.isArray(j.preferredAngle) || j.preferredAngle.length !== 3 || ![0, 1, 2].every(index => Number.isFinite(j.preferredAngle![index])))) throw Error("Invalid joint preferred angle");
    if (typeof j.id !== "string" || typeof j.name !== "string" || !j.name.trim() || !Array.isArray(j.position) || j.position.length !== 3 || !j.position.every(Number.isFinite)) throw Error("Invalid joint");
    const seen = new Set([j.id]);
    let parent = j.parentId;
    while (parent !== null) {
      if (!ids.has(parent) || seen.has(parent)) throw Error("Invalid joint hierarchy");
      seen.add(parent); parent = joints.find(n => n.id === parent)!.parentId;
    }
  }
}
export function reparentJoint(joints: Joint[], id: string, parentId: string | null): Joint[] {
  validateJoints(joints);
  validateJoints(joints.map(j => j.id === id ? {...j, parentId} : j));
  const world = (key: string): THREE.Matrix4 => {
    const j = joints.find(n => n.id === key)!;
    const local = jointLocalMatrix(j, j.position, j.rotation ?? [0,0,0]);
    return j.parentId ? world(j.parentId).multiply(local) : local;
  };
  const local = (parentId ? world(parentId).invert() : new THREE.Matrix4()).multiply(world(id));
  const p = new THREE.Vector3(), q = new THREE.Quaternion(); local.decompose(p, q, new THREE.Vector3());
  const position = p.toArray() as Joint["position"];
  const joint = joints.find(j => j.id === id)!;
  const rotation = jointRotationFromQuaternion(joint, q, joint.rotation);
  const next = joints.map(j => j.id === id ? { ...j, parentId, position, rotation } : j);
  validateJoints(next); return next;
}
export function activeJoint(joints:Joint[], selection:ReadonlySet<string>):string {
  const parents=new Map(joints.map(j=>[j.id,j.parentId]));
  for(const id of selection) {
    if(!parents.has(id))continue;
    let parent=parents.get(id),selectedAncestor=false;
    const visited=new Set<string>();
    while(parent&&!visited.has(parent)) {
      visited.add(parent);
      if(selection.has(parent)){selectedAncestor=true;break;}
      parent=parents.get(parent);
    }
    if(!selectedAncestor)return id;
  }
  return "";
}
export function mountSkeleton(store: SceneStore, world: THREE.Scene, host: HTMLElement, available: () => boolean,
  prepareEdit?: (next: Joint[], label: string) => import("./scene-document.ts").SceneDocument) {
  let selected = "";
  let selection = new Set<string>();
  const bones = new Map<string, THREE.Bone>();
  const axes = new Map<string, THREE.AxesHelper>();
  const rotationStart=new Map<string,THREE.Quaternion>();
  const markers: THREE.Mesh[] = [];
  const markerFor = new Map<string, THREE.Mesh>();
  function boneVisible(id: string) {
    let bone: THREE.Object3D | null | undefined = bones.get(id);
    while (bone && bone !== layer) { if (!bone.visible) return false; bone = bone.parent; }
    return true;
  }
  const links: { line: THREE.Line; shape: THREE.Mesh; child: string; parent: string }[] = [];
  const boneGeometry=new THREE.ConeGeometry(1,1,4);
  boneGeometry.translate(0,.5,0);
  const boneMaterial=new THREE.MeshBasicMaterial({color:0xb9c4cf,transparent:true,opacity:.3,depthTest:false,depthWrite:false});
  const boneOutlineGeometry=new THREE.EdgesGeometry(boneGeometry);
  const boneOutlineMaterial=new THREE.LineBasicMaterial({color:0xc9d1d9,transparent:true,opacity:.85,depthTest:false,depthWrite:false});
  function placeBone(shape:THREE.Mesh,parent:THREE.Vector3,child:THREE.Vector3) {
    const direction=child.clone().sub(parent),length=direction.length();
    shape.visible=length>1e-6;
    if(!shape.visible)return;
    shape.position.copy(parent);
    shape.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.divideScalar(length));
    const width=Math.min(length*.12,.22);
    shape.scale.set(width,length,width);
  }
  const layer = new THREE.Group(); world.add(layer);
  const geometry = new THREE.SphereGeometry(.065, 12, 8);
  const material = new THREE.MeshBasicMaterial({ color: 0xdedede, depthTest: false, depthWrite: false, transparent: true });
  const activeMaterial = new THREE.MeshBasicMaterial({ color: 0xffb84d, depthTest: false, depthWrite: false, transparent: true });
  const lineMaterial = new THREE.LineBasicMaterial({ color: 0xcccccc, depthTest: false, depthWrite: false, transparent: true });
  const editor = document.createElement("div"); editor.className = "joint-editor";
  host.append(editor);
  const status = host.querySelector(".rigging-status")!;
  const joints = () => store.getState().document.joints ?? [];
  const commit = (next: Joint[], editLabel: string) => {
    if (!available()) return;
    try {
      validateJoints(next);
      store.setState({ document: prepareEdit ? prepareEdit(next, editLabel) : { ...store.getState().document, joints: next }, editLabel });
    } catch (error) {
      render();
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = message;
      host.dispatchEvent(new CustomEvent("rigging-error", { detail: message }));
    }
  };
  function render() {
    selection = new Set([...selection].filter(id => joints().some(j => j.id === id)));
    selected = activeJoint(joints(),selection);
    for (const helper of axes.values()) helper.dispose();
    axes.clear();
    for (const child of [...layer.children]) {
      if (child instanceof THREE.Line) child.geometry.dispose();
      layer.remove(child);
    }
    bones.clear(); markers.length = 0; markerFor.clear(); links.length = 0;
    for (const j of joints()) {
      const bone = new THREE.Bone(); bone.name = j.name; bone.position.fromArray(j.position);
      bone.quaternion.copy(jointLocalQuaternion(j, j.rotation ?? [0,0,0]));
      if (j.showLocalAxes) {
        const helper = new THREE.AxesHelper(.35);
        helper.material.depthTest = false; helper.material.depthWrite = false;
        helper.renderOrder = 100001; bone.add(helper); axes.set(j.id, helper);
      }
      bones.set(j.id, bone);
      const marker = new THREE.Mesh(geometry, selection.has(j.id) ? activeMaterial : material);
      marker.userData.jointId = j.id;
      markers.push(marker);
      markerFor.set(j.id, marker);
      marker.renderOrder = 100000; bone.add(marker);
    }
    for (const j of joints()) (j.parentId ? bones.get(j.parentId)! : layer).add(bones.get(j.id)!);
    layer.updateMatrixWorld(true);
    for (const j of joints()) if (j.parentId) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        bones.get(j.id)!.getWorldPosition(new THREE.Vector3()), bones.get(j.parentId)!.getWorldPosition(new THREE.Vector3())
      ]), lineMaterial); line.renderOrder = 100000; layer.add(line);
      const shape=new THREE.Mesh(boneGeometry,boneMaterial);
      const outline=new THREE.LineSegments(boneOutlineGeometry,boneOutlineMaterial);
      shape.renderOrder=99998;outline.renderOrder=99999;shape.add(outline);layer.add(shape);
      placeBone(shape,bones.get(j.parentId)!.getWorldPosition(new THREE.Vector3()),bones.get(j.id)!.getWorldPosition(new THREE.Vector3()));
      links.push({ line, shape, child: j.id, parent: j.parentId });
    }
    editor.replaceChildren();
    status.textContent = "Select a splat and Shift-select the joints to bind, then use Bind splats. Only selected joints receive automatic distance weights.";
    const list = document.createElement("select"); list.setAttribute("aria-label", "Selected joint");
    list.add(new Option("New root / no joint selected", ""));
    for (const j of joints()) list.add(new Option(j.name, j.id));
    if (!bones.has(selected)) selected = "";
    list.value = selected; list.onchange = () => { selection = new Set(list.value ? [list.value] : []); render(); }; editor.append(list);
    const joint = joints().find(j => j.id === selected);
    host.dispatchEvent(new Event("joint-selection-change"));
    if (!joint) return;
    const name = document.createElement("input"); name.value = joint.name; name.setAttribute("aria-label", "Joint name");
    name.onchange = () => { if (name.value.trim()) commit(joints().map(j => j.id === selected ? {...j, name: name.value.trim()} : j), "Rename joint"); }; editor.append(name);
    for (let axis = 0; axis < 3; axis++) {
      const label = document.createElement("label"); label.textContent = `Position ${"XYZ"[axis]}`;
      const input = document.createElement("input"); input.type = "number"; input.step = "0.1"; input.value = String(joint.position[axis]);
      input.onchange = () => { if (Number.isFinite(input.valueAsNumber)) commit(joints().map(j => { if (j.id !== selected) return j; const position = [...j.position] as Joint["position"]; position[axis] = input.valueAsNumber; return {...j, position}; }), "Move joint"); };
      label.append(input); editor.append(label);
    }
    const parent = document.createElement("select"); parent.id = "joint-parent"; parent.setAttribute("aria-label", "Parent joint"); parent.add(new Option("Skeleton root", ""));
    for (const j of joints()) {
      try { reparentJoint(joints(), selected, j.id); parent.add(new Option(j.name, j.id)); } catch { /* Exclude self and descendants. */ }
    }
    parent.value = joint.parentId ?? ""; editor.append(parent);
    const apply = document.createElement("button"); apply.textContent = "Parent joint";
    apply.onclick = () => commit(reparentJoint(joints(), selected, parent.value || null), "Parent joint"); editor.append(apply);
  }
  const controls = new Set([
    ...Array.from(document.querySelectorAll<WaButton | WaDropdownItem>("[data-rig-action]")),
    ...Array.from(host.querySelectorAll<WaButton | WaDropdownItem>("[data-rig-action]")),
  ]);
  for (const control of controls) {
    const label = control.dataset.rigAction;
    if (label !== "Create joints" && label !== "Parent joints" && label !== "FK rotate") continue;
    control.disabled = false;
    control.title = label;
    control.addEventListener("click", () => {
      if (!available()) return;
      if (label === "FK rotate") document.getElementById("tool-rotate")!.click();
      if (label === "Create joints") {
        const parentId = joints().some(j => j.id === selected) ? selected : null;
        const id = crypto.randomUUID(); selection = new Set([id]); selected = id;
        commit([...joints(), { id, name: `joint${joints().length + 1}`, parentId, position: parentId ? [0, 1, 0] : [0, 0, 0] }], "Create joint");
      }
    });
  }
  store.subscribe((state, previous) => { if (state.document.joints !== previous.document.joints) render(); }); render();
  return {
    applyPose(poses: ReadonlyMap<string, import("./animation.ts").AnimationPose>) {
      for (const [id, bone] of bones) {
        const pose = poses.get(id);
        if (!pose) continue;
        bone.position.fromArray(pose.position);
        bone.quaternion.copy(jointLocalQuaternion(joints().find(j => j.id === id)!, pose.rotation));
        bone.visible = pose.visibility >= .5;
        const marker = markerFor.get(id);
        if (marker) marker.visible = pose.visibility >= .5;
      }
      this.preview();
    },
    beginRotation() {
      rotationStart.clear();
      for(const id of selection){const bone=bones.get(id);if(bone)rotationStart.set(id,bone.quaternion.clone());}
    },
    previewRotation() {
      const anchor=bones.get(selected),start=rotationStart.get(selected);
      if(!anchor||!start)return;
      const delta=start.clone().invert().multiply(anchor.quaternion);
      for(const [id,initial]of rotationStart)if(id!==selected)bones.get(id)?.quaternion.copy(initial).multiply(delta);
    },
    commitRotation() {
      const rotations=new Map<string,Joint["rotation"]>();
      for(const id of rotationStart.keys()){
        const bone=bones.get(id);if(!bone)continue;
        const joint = joints().find(j => j.id === id)!;
        rotations.set(id,jointRotationFromQuaternion(joint,bone.quaternion,joint.rotation));
      }
      rotationStart.clear();
      commit(joints().map(j=>rotations.has(j.id)?{...j,rotation:rotations.get(j.id)}:j),"Rotate selected joints");
    },
    setVisible(visible:boolean) { layer.visible=visible; },
    get selectedId() { return selected; },
    boneMatrix(id: string) { return bones.get(id)?.matrixWorld.clone(); },
    get selectedIds() { return new Set(selection); },
    get selectedBone() { return bones.get(selected); },
    select(id: string) { selection = new Set(id ? [id] : []); render(); },
    selectMany(ids: string[], additive = false) {
      const next = additive ? new Set(selection) : new Set<string>();
      for (const id of ids) {
        if (additive && next.has(id)) next.delete(id); else next.add(id);
      }
      selection = next; render();
    },
    marquee(begin: THREE.Vector2, end: THREE.Vector2, camera: THREE.Camera) {
      if(!layer.visible)return [];
      layer.updateMatrixWorld(true);
      return [...bones].filter(([id, bone]) => {
        if (!boneVisible(id)) return false;
        const p = bone.getWorldPosition(new THREE.Vector3()).project(camera);
        return p.z >= -1 && p.z <= 1 && p.x >= Math.min(begin.x,end.x) && p.x <= Math.max(begin.x,end.x)
          && p.y >= Math.min(begin.y,end.y) && p.y <= Math.max(begin.y,end.y);
      }).map(([id]) => id);
    },
    pick(raycaster: THREE.Raycaster) {
      if(!layer.visible)return undefined;
      layer.updateMatrixWorld(true);
      return raycaster.intersectObjects(markers.filter(marker => boneVisible(marker.userData.jointId)), false)[0]?.object.userData.jointId as string | undefined;
    },
    preview() {
      layer.updateMatrixWorld(true);
      for (const {line, shape, child, parent} of links) {
        const positions = line.geometry.getAttribute("position") as THREE.BufferAttribute;
        const a = bones.get(child)!.getWorldPosition(new THREE.Vector3());
        const b = bones.get(parent)!.getWorldPosition(new THREE.Vector3());
        positions.setXYZ(0, a.x, a.y, a.z); positions.setXYZ(1, b.x, b.y, b.z);
        positions.needsUpdate = true; line.geometry.computeBoundingSphere();
        placeBone(shape,b,a);
        line.visible = boneVisible(child);
        shape.visible = shape.visible && line.visible;
      }
    },
    commitMove(id: string, position: Joint["position"], rotation?: Joint["rotation"]) {
      commit(joints().map(j => j.id === id ? {...j, position, ...(rotation ? {rotation} : {})} : j), rotation ? "Transform joint" : "Move joint");
    },
    reparent(id: string, parentId: string | null) {
      commit(reparentJoint(joints(), id, parentId), "Parent joint");
    },
    reset: render,
  };
}

