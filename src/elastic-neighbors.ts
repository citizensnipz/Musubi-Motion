import * as THREE from "three";

export type SurfaceSample = {center:THREE.Vector3; scales:THREE.Vector3; quaternion:THREE.Quaternion};

// Freeze connectivity before animation; nearby folds must not become neighbors
// merely because a pose brings them together.
export function surfaceNeighbors(samples:SurfaceSample[]) {
  const frames=samples.map(s=>{
    const sizes=s.scales.toArray(),thin=sizes.indexOf(Math.min(...sizes));
    const normal=new THREE.Vector3().setComponent(thin,1).applyQuaternion(s.quaternion);
    const tangent=new THREE.Vector3().setComponent((thin+1)%3,1).applyQuaternion(s.quaternion);
    return {normal,tangent,bitangent:normal.clone().cross(tangent),radius:Math.max(...sizes),reliable:Math.min(...sizes)<Math.max(...sizes)*.7};
  });
  const radii=frames.filter(f=>f.radius>0).map(f=>f.radius).sort((a,b)=>a-b);
  const cell=Math.max(1e-6,(radii[Math.floor(radii.length/2)]??1)*3);
  const grid=new Map<string,number[]>();
  const key=(x:number,y:number,z:number)=>`${x},${y},${z}`;
  samples.forEach((s,i)=>{
    const p=s.center.clone().divideScalar(cell).floor(),k=key(p.x,p.y,p.z);
    const bucket=grid.get(k)??[];bucket.push(i);grid.set(k,bucket);
  });
  const neighbors=samples.map((s,i)=>{
    const f=frames[i],p=s.center.clone().divideScalar(cell).floor();
    const sectors:{id:number;distance:number}[]=[];
    const radius=Math.min(f.radius*3,cell*2),cells=Math.ceil(radius/cell);
    for(let x=-cells;x<=cells;x++) for(let y=-cells;y<=cells;y++) for(let z=-cells;z<=cells;z++) {
      for(const j of grid.get(key(p.x+x,p.y+y,p.z+z))??[]) {
        if(i===j) continue;
        const delta=samples[j].center.clone().sub(s.center),distance=delta.length();
        if(distance<1e-7||distance>radius||distance>frames[j].radius*3) continue;
        delta.divideScalar(distance);
        // Thin Gaussians supply normals: reject through-thickness links and
        // sharply conflicting surface directions.
        if(f.reliable&&Math.abs(delta.dot(f.normal))>.45) continue;
        if(frames[j].reliable&&Math.abs(delta.dot(frames[j].normal))>.45) continue;
        if(f.reliable&&frames[j].reliable&&Math.abs(f.normal.dot(frames[j].normal))<.75) continue;
        const angle=Math.atan2(delta.dot(f.bitangent),delta.dot(f.tangent));
        const sector=Math.floor((angle+Math.PI+Math.PI/8)/(Math.PI/4))%8;
        if(!sectors[sector]||distance<sectors[sector].distance) sectors[sector]={id:j,distance};
      }
    }
    return sectors.filter(Boolean).map(n=>n.id);
  });
  const edges:[number,number][]=[];
  const linked=new Set<string>();
  neighbors.forEach((list,i)=>list.forEach(j=>{
    if(!neighbors[j].includes(i)) return;
    const a=Math.min(i,j),b=Math.max(i,j),k=`${a}/${b}`;
    if(!linked.has(k)){linked.add(k);edges.push([a,b]);}
  }));
  const triangles:[number,number,number][]=[];
  const seen=new Set<string>();
  neighbors.forEach((list,i)=>{
    const f=frames[i];
    const around=list.filter(j=>linked.has(`${Math.min(i,j)}/${Math.max(i,j)}`)).map(j=>{
      const d=samples[j].center.clone().sub(samples[i].center);
      return {id:j,angle:Math.atan2(d.dot(f.bitangent),d.dot(f.tangent))};
    }).sort((a,b)=>a.angle-b.angle);
    for(let n=0;n<around.length;n++) {
      const a=around[n],b=around[(n+1)%around.length];
      const angle=(b.angle-a.angle+Math.PI*2)%(Math.PI*2);
      if(angle<.1||angle>Math.PI*.75||!linked.has(`${Math.min(a.id,b.id)}/${Math.max(a.id,b.id)}`)) continue;
      const ids=[i,a.id,b.id].sort((a,b)=>a-b) as [number,number,number],k=ids.join("/");
      if(!seen.has(k)){seen.add(k);triangles.push(ids);}
    }
  });
  return {edges,triangles};
}
