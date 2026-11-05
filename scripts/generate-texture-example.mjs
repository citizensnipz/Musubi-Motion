import {createServer} from "vite";
import {Group,Mesh,MeshStandardMaterial,PlaneGeometry,Texture} from "three";
import {deflateSync} from "node:zlib";
import {mkdir,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
const root=fileURLToPath(new URL("../",import.meta.url)),out=path.join(root,"examples/textures");
const crc32=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const t=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([length,t,data,crc]);};
const size=16,header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
const pixels=Buffer.alloc((size*4+1)*size);
for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=y*(size*4+1)+1+x*4,on=((x>>2)+(y>>2))%2;pixels[i]=on?238:48;pixels[i+1]=on?170:96;pixels[i+2]=on?96:160;pixels[i+3]=x<3&&y<3?96:255;}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]),uri=`data:image/png;base64,${png.toString("base64")}`;
const server=await createServer({root,configLoader:"runner",cacheDir:path.join(process.env.TEMP??root,"texture-example-cache"),server:{middlewareMode:true,hmr:false,ws:false},appType:"custom",optimizeDeps:{noDiscovery:true,include:[]}});
try{
 const {emptyScene}=await server.ssrLoadModule("/src/scene-document.ts"),{convertFBX}=await server.ssrLoadModule("/src/fbx-import.ts"),{collectEmbeddedTextures}=await server.ssrLoadModule("/src/texture-assets.ts"),{encodeProjectBlob,decodeProjectBlob}=await server.ssrLoadModule("/src/project-archive.ts");
 const group=new Group(),material=new MeshStandardMaterial({roughness:.8,transparent:true});material.name="Original checker";material.map=new Texture();material.map.userData.musubiDataURI=uri;
 const mesh=new Mesh(new PlaneGeometry(3,3),material);mesh.name="Texture preview card";group.add(mesh);
 const doc=await collectEmbeddedTextures(convertFBX(group,emptyScene(),"Texture study").document,async()=>({alpha:true,thumbnail:uri}));
 const editor={camera:{position:[0,0,6],target:[0,0,0],fov:42,near:.01,far:1000},time:0};
 const bytes=await encodeProjectBlob(doc,new Map(),editor);await decodeProjectBlob(bytes);
 await mkdir(out,{recursive:true});await writeFile(path.join(out,"musubi-checker.png"),png);await writeFile(path.join(out,"texture-library.msb"),Buffer.from(await bytes.arrayBuffer()));
 console.log("Generated original16x16 RGBA checker and portable shared-texture MSB",Object.keys(doc.textureAssets));
}finally{await server.close();}
