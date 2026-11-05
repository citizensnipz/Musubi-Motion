// Original procedural three-joint rig; no external assets or services.
import { createServer } from "vite";
import { readFile, writeFile } from "node:fs/promises";
const server=await createServer({configLoader:"runner",server:{middlewareMode:true,hmr:false,ws:false},appType:"custom",optimizeDeps:{noDiscovery:true,include:[]}});
try{
  const {emptyScene}=await server.ssrLoadModule("/src/scene-document.ts");
  const {createSceneStore}=await server.ssrLoadModule("/src/scene-store.ts");
  const {createController,findControllerShape,updateControllerShape}=await server.ssrLoadModule("/src/controller-curves.ts");
  const {controllerPlacement}=await server.ssrLoadModule("/src/controller-placement.ts");
  const {evaluateSceneAnimation,upsertTrack}=await server.ssrLoadModule("/src/animation.ts");
  const {setDrivenKey,evaluateDrivenKeys}=await server.ssrLoadModule("/src/driven-keys.ts");
  const {encodeProject,decodeProject}=await server.ssrLoadModule("/src/project-archive.ts");
  const scene=emptyScene();scene.joints=[
    {id:"shoulder",name:"Shoulder",parentId:null,position:[0,1,0]},
    {id:"elbow",name:"Elbow",parentId:"shoulder",position:[1.6,0,0]},
    {id:"wrist",name:"Wrist",parentId:"elbow",position:[1.4,0,0]},
  ];
  const store=createSceneStore(scene);
  const control=createController(store,"circle",{name:"Elbow curl control",plane:"YZ",size:.65,...controllerPlacement(scene,evaluateSceneAnimation(scene,0),"elbow")});
  const shape=findControllerShape(store.getState().document,control),points=shape.points.map(p=>[...p]);points[1][3]=.65;
  updateControllerShape(store,shape.id,{points});
  const driver={targetId:control,channel:"rotation.x"},driven={targetId:"elbow",channel:"rotation.z"};
  setDrivenKey(store,driver,driven,0,0);setDrivenKey(store,driver,driven,90,100);
  const key=(id,time,value)=>({id,time,value,interpolation:"linear",tangentMode:"auto"});
  upsertTrack(store,{id:"curl-performance",targetId:control,channel:"rotation.x",keys:[key("curl-start",0,0),key("curl-bend",24,90),key("curl-return",48,0)]});
  const doc=store.getState().document;doc.animation.end=48;
  const verify=scene=>{for(let frame=0;frame<=48;frame+=.25){const poses=evaluateSceneAnimation(scene,frame);evaluateDrivenKeys(scene,poses);const expected=frame<=24?frame/24*100:(48-frame)/24*100;if(Math.abs(poses.get("elbow").rotation[2]-expected)>1e-9)throw Error(`Elbow pose differs at frame ${frame}`);}};
  verify(doc);
  const path="examples/controller-sdk-rig.msb",editor={camera:{position:[5,4,7],target:[1.3,1.2,0],fov:42,near:.01,far:1000},time:0};
  const bytes=await encodeProject(doc,new Map(),editor);await writeFile(path,bytes);
  const reopened=await decodeProject(new Uint8Array(await readFile(path)));verify(reopened.scene);
  if(JSON.stringify(reopened.scene)!==JSON.stringify(doc))throw Error("Reopen changed authored rig.");
  console.log(JSON.stringify({path,bytes:bytes.length,joints:3,controllers:1,relationships:1,frameSamples:193,control},null,2));
}finally{await server.close();}
