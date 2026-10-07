import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { publicAddress, publicResource, pageImages, discoverVisuals, imageCandidates } from '../plugin/visual-discovery.js';
import { discoverIllustration } from '../plugin/node.js';
const urls=['https://style.example/glass','https://concept.example/nodes'];
const textPlan={purpose:'Diagramas locales',audience:'Diseñadores',uncertainty:'',sources:urls.map(url=>({url,title:'Diseño',insight:'Formas'})),directions:['Uno','Dos','Tres'].map(name=>({name,metaphor:'Nodo',rationale:'Conexión'})),chosen:0,brief:'Nodo genérico',visualQueries:['glass icons','connected nodes']};
const visualPlan={selected:[{id:1,observations:'Superficie azul',use:'Contraste'},{id:2,observations:'Forma coral',use:'Silueta'}],directions:['Conexión visual','Lente','Arco'].map(name=>({name,metaphor:'Conexión',rationale:'Píxeles observados'})),chosen:0,brief:'Un emblema visual conectado',findings:'Paleta y reflejos visibles',uncertainty:''};
function answer(value, search=false){return {ok:true,stdout:[...(search?[{message:{content:[{type:'tool_use',id:'s1',name:'WebSearch',input:{query:'generic icons'}}]}},{message:{content:[{type:'tool_result',tool_use_id:'s1',content:urls.join(' ')}]}}]:[]),{type:'result',structured_output:value}].map(x=>JSON.stringify(x)).join('\n'),ms:1};}
async function resources(){const blue=await sharp({create:{width:160,height:160,channels:3,background:'#206BB0'}}).png().toBuffer(),coral=await sharp({create:{width:160,height:160,channels:3,background:'#F46A58'}}).png().toBuffer();return async u=>{
 if(u.includes('api.openverse.org'))return {data:Buffer.from(JSON.stringify({results:[{url:'https://images.example/blue.png',foreign_landing_url:urls[0],title:'Azul',license:'cc0'},{url:'https://images.example/coral.png',foreign_landing_url:urls[1],title:'Coral',license:'cc0'}]})),mime:'application/json',url:u};
 if(u.includes('commons.wikimedia.org'))return {data:Buffer.from('{}'),mime:'application/json',url:u};
 if(u.includes('images.example'))return {data:u.includes('blue')?blue:coral,mime:'image/png',url:u};
 return {data:Buffer.from('<html></html>'),mime:'text/html',url:u};};}
test('remote visual inputs reject private addresses and non-HTTPS before connecting',async()=>{
 for(const a of ['127.0.0.1','10.0.0.3','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1'])assert.equal(publicAddress(a),false);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
 await assert.rejects(publicResource('http://example.com/a.png'),/HTTPS/);await assert.rejects(publicResource('https://127.0.0.1/a.png'),/privada/);
 const refs=pageImages('<meta content="https://cdn.example/a.png" property="og:image"><img src="javascript:alert(1)"><img src="https://cdn.example/favicon.png"><img src="/b.png" width="400">','https://style.example/post');assert.equal(refs.length,2);assert.equal(refs[1].imageURL,'https://style.example/b.png');
});
test('visual discovery interprets actual pixels and rejects nonexistent chosen reference IDs',async()=>{
 const resource=await resources();let calls=0;
 const discovery={...textPlan,style:'Cristal',project:{name:'App'},deliverable:{opaqueOutputPixels:true}};
 const result=await discoverVisuals(discovery,{resource,transport:{run:async req=>{calls++;assert.equal(req.images[0].name,'candidates');assert.equal((await sharp(Buffer.from(req.images[0].data,'base64')).metadata()).width,960);return answer(visualPlan);}}});
 assert.equal(calls,1);assert.equal(result.observedReferenceImages,2);assert.equal(result.visual.images[0].sha256.length,64);assert.equal(result.brief,visualPlan.brief);
 await assert.rejects(discoverVisuals(discovery,{resource,transport:{run:async()=>answer({...visualPlan,selected:[{...visualPlan.selected[0],id:999},visualPlan.selected[1]]})}}),/sin imagen observada/);
 await assert.rejects(discoverVisuals(discovery,{resource,transport:{run:async()=>answer({...visualPlan,selected:[],uncertainty:'Ninguna referencia pertinente'})}}),/visualmente útiles/);
});
test('selected visual assets reach drawing and its syntax repair; reviewer receives moodboard',async t=>{
 const repo=await fs.mkdtemp(path.join(os.tmpdir(),'aru-visual-test-'));t.after(()=>fs.rm(repo,{recursive:true,force:true}));await fs.writeFile(path.join(repo,'README.md'),'# App\nDiagramas locales.');const resource=await resources();let n=0;
 const result=await discoverIllustration({repo,style:'Cristal',resource,transport:{run:async req=>{
  if(n++===0)return answer(textPlan,true);
  if(n===2)return answer(visualPlan);
  if(n===3){assert.deepEqual(req.images.map(i=>i.name),['canvas','ref1','ref2']);assert.match(req.prompt,/Un emblema visual conectado/);return answer({reply:'Dibujo',operations:[],reference:{use:false},aruInto:'Icono',aru:'group Emblema { path Nodo { move 30 30;'});}
  if(n===4){assert.deepEqual(req.images.map(i=>i.name),['canvas','ref1','ref2']);assert.match(req.prompt,/Un emblema visual conectado/);return answer({reply:'Reparado',operations:[],reference:{use:false},aruInto:'Icono',aru:'group Emblema { circle Nodo { at 256 256; radius 100; fill #206BB0 } }'});}
  assert.deepEqual(req.images.map(i=>i.name),['icon','small_sizes','references']);return answer({accept:true,purposeMatch: true, conceptMatch:true,styleMatch:true,smallLegibility:true,reason:'Se ve',correction:''});
 }}});
 assert.equal(n,5);assert.equal(result.report.generation.repaired,true);assert.equal(result.report.generation.referenceAssets.length,2);assert.equal(result.report.discovery.mode,'web-and-visual-discovery');assert.match(result.text,/Emblema/);
});
test('AVIF editorial references are decoded to observed PNG pixels; document thumbnails are excluded',async()=>{
 const avif=await sharp({create:{width:160,height:160,channels:3,background:'#60C6C9'}}).avif().toBuffer();
 const ordinary=await resources();
 const resource=async u=>{
  if(u.includes('commons.wikimedia.org'))return {data:Buffer.from(JSON.stringify({query:{pages:{1:{title:'Unrelated book.pdf',imageinfo:[{mime:'application/pdf',url:'https://images.example/book.pdf',thumburl:'https://images.example/book.png'}]},2:{title:'Unrelated scan.djvu',imageinfo:[{mime:'image/vnd.djvu',url:'https://images.example/scan.djvu',thumburl:'https://images.example/scan.png'}]}}}})),mime:'application/json',url:u};
  if(u===urls[0])return {data:Buffer.from('<img src="https://images.example/modern.avif" width="160" height="160">'),mime:'text/html',url:u};
  if(u.endsWith('modern.avif'))return {data:avif,mime:'image/avif',url:u};
  return ordinary(u);
 };
 const pool=await imageCandidates(textPlan,{resource});
 assert.equal(pool.images.length,3);assert(!pool.images.some(x=>/Unrelated/.test(x.title)));
 const modern=pool.images.find(x=>x.imageURL.endsWith('.avif'));assert.equal(modern.mime,'image/png');assert.equal((await sharp(Buffer.from(modern.data,'base64')).metadata()).width,160);
});
