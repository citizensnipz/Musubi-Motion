export type FillRequest = { ids:number[]; desired:number; allocated:number; strain:number };

// Density determines demand. Budget truncates a stable candidate stream.
export function allocateFill(requests:FillRequest[], budget:number, distribution:number) {
  const heap: {request:FillRequest; order:number; weight:number}[]=[];
  const better=(a:typeof heap[number],b:typeof heap[number])=>{
    const x=a.weight/(a.request.allocated+1),y=b.weight/(b.request.allocated+1);
    return x===y ? a.order<b.order : x>y;
  };
  function push(item:typeof heap[number]) {
    let i=heap.length;heap.push(item);
    while(i>0){const p=(i-1)>>1;if(!better(item,heap[p]))break;heap[i]=heap[p];i=p;heap[i]=item;}
  }
  function pop() {
    const first=heap[0],last=heap.pop()!;
    if(heap.length){heap[0]=last;let i=0;while(true){let c=i*2+1;if(c>=heap.length)break;if(c+1<heap.length&&better(heap[c+1],heap[c]))c++;if(!better(heap[c],heap[i]))break;[heap[i],heap[c]]=[heap[c],heap[i]];i=c;}}
    return first;
  }
  requests.forEach((r,i)=>{r.allocated=0;if(r.desired>0)push({request:r,order:i,weight:1+distribution*(Math.min(1024,r.strain*r.strain)-1)});});
  for(let n=0;n<budget&&heap.length;n++){const item=pop();item.request.allocated++;if(item.request.allocated<item.request.desired)push(item);}
}

export function radicalInverse(index:number,base:number) {
  let result=0,place=1/base;
  while(index){result+=(index%base)*place;index=Math.floor(index/base);place/=base;}
  return result;
}
