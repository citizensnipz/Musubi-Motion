// CPU evaluation only; browser/UI evidence is recorded separately.
// node --expose-gc scripts/benchmark-animation-layers.mjs
// Optional ANIMATION_BASELINE_ROOT compares the unchanged evaluator in the same process.
import { createServer } from "vite";
const config = { server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] }, cacheDir: process.env.TEMP ? `${process.env.TEMP}/task-005-vite-benchmark` : "node_modules/.vite-benchmark" };
const server = await createServer(config);
let baselineServer;
try {
  const { emptyScene } = await server.ssrLoadModule("/src/scene-document.ts");
  const current = await server.ssrLoadModule("/src/animation.ts");
  let baseline;
  if (process.env.ANIMATION_BASELINE_ROOT) {
    baselineServer = await createServer({ ...config, root: process.env.ANIMATION_BASELINE_ROOT, cacheDir: `${config.cacheDir}-baseline` });
    baseline = await baselineServer.ssrLoadModule("/src/animation.ts");
  }
  const fixtures = [{ objects: 100, layers: 10, channels: 3, keys: 2 }, { objects: 1000, layers: 10, channels: 3, keys: 2 }, { objects: 100, layers: 1000, channels: 1, keys: 1 }];
  const reports=[];
  function fixture(settings,dynamic){
    const doc=emptyScene(), channels=["position.x","rotation.y","scale.z"];
    doc.animation={...current.defaultAnimation(),layers:Array.from({length:settings.layers},(_,i)=>({id:`layer-${i}`,name:`Layer ${i}`,mode:i%3===2?"override":"additive",weight:.5,mute:false,solo:false,locked:false,...(dynamic?{weightTrack:{id:`weight-${i}`,keys:[0,100].map((time,k)=>({id:`weight-key-${i}-${k}`,time,value:k,interpolation:"linear",tangentMode:"auto"}))}}:{})}))};
    // Reserve room for 2,000 weight keys in BOTH largest static/dynamic variants.
    const poseObjectCount=settings.layers===1000?98:settings.objects;
    for(let o=0;o<settings.objects;o++){
      const id=`object-${o}`;doc.nodes[id]={id,type:"transform",name:id,parentId:null,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],rotationOrder:"XYZ"};doc.rootIds.push(id);
      if(o>=poseObjectCount)continue;
      for(let l=0;l<settings.layers;l++)for(let c=0;c<settings.channels;c++){
        const value=c===2?1+l*.001:(l+1)*(c?.1:.01);
        doc.animation.tracks.push({id:`track-${o}-${l}-${c}`,targetId:id,channel:channels[c],layerId:`layer-${l}`,keys:Array.from({length:settings.keys},(_,k)=>({id:`key-${o}-${l}-${c}-${k}`,time:k*100,value:value*(1+k*.5),interpolation:"linear",tangentMode:"auto"}))});
      }
    }
    current.validateAnimation(doc.animation,doc);return {doc,poseObjectCount};
  }
  for(const settings of fixtures){
    const {doc:staticDoc,poseObjectCount}=fixture(settings,false),{doc:dynamicDoc}=fixture(settings,true);
    const variants=[...(baseline?[{name:"baseline-static",engine:baseline,doc:staticDoc}]:[]),{name:"current-static",engine:current,doc:staticDoc},{name:"current-dynamic",engine:current,doc:dynamicDoc}];
    for(const v of variants){global.gc?.();const start=performance.now();v.engine.evaluateSceneAnimation(v.doc,0);v.compileMs=performance.now()-start;v.times=[];v.rounds=[];v.maxError=0;}
    // Interleave warmup/measurement to share process load and JIT conditions.
    for(let round=-2;round<5;round++){
      for(const v of [...variants.slice(round%2===0?0:1),...variants.slice(0,round%2===0?0:1)]){
        global.gc?.();const heapBefore=process.memoryUsage().heapUsed,roundTimes=[];
        for(let sample=0;sample<120;sample++){
          const frame=(sample*.731+round*7+100)%100,start=performance.now(),poses=v.engine.evaluateSceneAnimation(v.doc,frame),elapsed=performance.now()-start;
          let expected=0,w=v.name==="current-dynamic"?frame/100:.5;
          for(let l=0;l<settings.layers;l++){const value=(l+1)*.01*(settings.keys===1?1:1+frame/200);expected=l%3===2?expected*(1-w)+value*w:expected+value*w;}
          let o=0;for(const pose of poses.values()){v.maxError=Math.max(v.maxError,Math.abs(pose.position[0]-(o++<poseObjectCount?expected:0)));}
          if(round>=0){v.times.push(elapsed);roundTimes.push(elapsed);}
        }
        if(round>=0){const heapAfter=process.memoryUsage().heapUsed;global.gc?.();roundTimes.sort((a,b)=>a-b);v.rounds.push({round,medianMs:roundTimes[60],p95Ms:roundTimes[114],heapBeforeBytes:heapBefore,heapAfterBytes:heapAfter,retainedAfterGCBytes:process.memoryUsage().heapUsed});}
      }
    }
    for(const v of variants){if(v.maxError>1e-9)throw Error(`Layer mismatch ${v.name}: ${v.maxError}`);v.times.sort((a,b)=>a-b);reports.push({...settings,poseObjectCount,variant:v.name,tracks:v.doc.animation.tracks.length+(v.name==="current-dynamic"?settings.layers:0),totalKeys:v.doc.animation.tracks.length*settings.keys+(v.name==="current-dynamic"?2*settings.layers:0),compileMs:v.compileMs,medianMs:v.times[Math.floor(v.times.length/2)],p95Ms:v.times[Math.floor(v.times.length*.95)],maxError:v.maxError,rounds:v.rounds});}
  }
  const comparisons=fixtures.map(s=>{const matching=reports.filter(r=>r.objects===s.objects&&r.layers===s.layers),b=matching.find(r=>r.variant==="baseline-static"),c=matching.find(r=>r.variant==="current-static");return{objects:s.objects,layers:s.layers,staticP95ChangePercent:b?100*(c.p95Ms/b.p95Ms-1):null,investigationGatePercent:20,gateExceeded:b?c.p95Ms>b.p95Ms*1.2:null};});
  console.log(JSON.stringify({runtime:process.version,gcExposed:!!global.gc,scope:"CPU animation only; no rendering/skinning/UI. Heap deltas include runtime GC noise, not precise allocation counts.",baselineRoot:process.env.ANIMATION_BASELINE_ROOT??null,reports,comparisons},null,2));
} finally {await server.close();await baselineServer?.close();}
