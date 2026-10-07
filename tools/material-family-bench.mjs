import {renderMaterialGallery} from './material-gallery.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createIllustrator, readDocument, listMaterials, prepareIconExports } from '../plugin/index.js';
import { refineIllustration, renderPng, exportIconArchive } from '../plugin/node.js';
import { zipStore } from '../src/export-icons.js';
const dir=path.resolve('out/material-family-2026-10-07');await fs.mkdir(dir,{recursive:true});
const previous=process.argv.includes('--replay')?JSON.parse(await fs.readFile(path.join(dir,'verification.json'),'utf8')):null;
const base=await fs.readFile('out/refinement-batch-2026-10-07/catart-base.aru','utf8'),group='iconos_app_2';
await fs.writeFile(path.join(dir,'base.aru'),base);
const colors={base:'#F7F7FA',neon:'#191426',chrome:'#182130',glass:'#EFF4FA',clay:'#F7F1EB',fruits:'#EFF5E8'};
const reports=[],allFiles=[],esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const shapeSignature=text=>JSON.stringify([...readDocument(text).scene.byPath].map(([p,n])=>[p,n.type,n.at,n.scale,n.rotate,n.geom,n.label,n.semantic,n.children.map(c=>c.path)]),(k,v)=>['line','col'].includes(k)?undefined:v);
async function variant(id,label,text,report={}) {
 const directory=path.join(dir,id);await fs.mkdir(directory,{recursive:true});
 const plan=prepareIconExports(text,{group,sizes:[24,48,96],background:colors[id],cellSize:28});
 let transparent=0;const composites=[],sample=[];
 for(let i=0;i<plan.entries.length;i++){
  const e=plan.entries[i];await fs.writeFile(path.join(directory,e.name+'.aru'),e.aru);
  for(const size of [24,48,96]){
   const data=await renderPng(e.aru,{width:size});await fs.writeFile(path.join(directory,`${e.name}-${size}.png`),data);
   const raw=await sharp(data).ensureAlpha().raw().toBuffer();for(let k=3;k<raw.length;k+=4)if(raw[k]!==255)transparent++;
   if(size===96){composites.push({input:data,left:i%10*112+8,top:Math.floor(i/10)*156+4});if(i<5)sample.push({input:data,left:i*112+8,top:0});}
   if(size===24)composites.push({input:data,left:i%10*112+44,top:Math.floor(i/10)*156+106});
  }
 }
 let labels='';for(let i=0;i<plan.entries.length;i++)labels+=`<text x="${i%10*112+56}" y="${Math.floor(i/10)*156+148}" text-anchor="middle" font-size="9" fill="${['neon','chrome'].includes(id)?'#DAE4EF':'#283C40'}">${esc(plan.entries[i].label.slice(0,20))}</text>`;
 composites.push({input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="780">${labels}</svg>`),left:0,top:0});
 await fs.writeFile(path.join(dir,id+'-sheet.png'),await sharp({create:{width:1120,height:780,channels:4,background:colors[id]}}).composite(composites).png().toBuffer());
 await fs.writeFile(path.join(dir,id+'-sample.png'),await sharp({create:{width:560,height:100,channels:4,background:colors[id]}}).composite(sample).png().toBuffer());
 await fs.writeFile(path.join(dir,id+'.aru'),text);
 const zip=await exportIconArchive(text,{group,sizes:[24,48,96],background:colors[id],cellSize:28});await fs.writeFile(path.join(dir,id+'-50.zip'),zip.data);
 if(id!=='base') { const b=Buffer.from(zip.data);let offset=0;while(b.readUInt32LE(offset)===0x04034b50){const length=b.readUInt32LE(offset+18),nl=b.readUInt16LE(offset+26),extra=b.readUInt16LE(offset+28),name=b.subarray(offset+30,offset+30+nl).toString(),start=offset+30+nl+extra;allFiles.push({name:id+'/'+name,data:b.subarray(start,start+length)});offset=start+length;} }
 reports.push({id,label,icons:plan.entries.length,pngs:plan.entries.length*3,transparentPixels:transparent,geometryPreserved:shapeSignature(text)===shapeSignature(base),...report});
 await fs.writeFile(path.join(dir,'verification.json'),JSON.stringify(reports,null,2));
 console.log(id,plan.entries.length,transparent);
}
await variant('base','Base',base);
for(const m of listMaterials()){
 const s=createIllustrator({text:base,selection:[group]});
 const saved=previous?.find(r=>r.id===m.id)?.ai;
 const result=process.argv.includes('--ai')?await refineIllustration(s,{message:`Transforma esta familia de iconos en ${m.label}. Conserva sus formas y función.`,mode:'style',progress:()=>process.stderr.write(`${m.id}: IA\n`)}):s.refine(saved?.operations||[{op:'material',target:'selection',preset:m.id}]);
 s.undo();if(s.getDocument().text!==base)throw new Error('Undo incorrecto');
 await variant(m.id,m.label,result.text,{undoRestored:true,changed:result.changed.length,ai:result.report||saved||null});
}
// Separate filled-surface control: identical editable plate and ink glyph for every material.
const surface=`canvas 96 96\nbackground #F7F7FA\ngroup icono {\nrect placa { at 48 48; size 72 72; corner 18; fill #709D35 }\npath gato { move 28 42; line 28 28; line 39 36; quad 48 32 57 36; line 68 28; line 68 42; quad 71 67 48 69; quad 25 67 28 42; close; fill none; stroke #1B2533 4; join round }\ncircle ojo1 { at 38 49; radius 3; fill #1B2533 }\ncircle ojo2 { at 58 49; radius 3; fill #1B2533 }\n}\n`;
await fs.writeFile(path.join(dir,'surface-base.aru'),surface);
for(const m of listMaterials()) {const s=createIllustrator({text:surface,selection:['icono.placa']});s.refine([{op:'material',target:'selection',preset:m.id}]);await fs.writeFile(path.join(dir,m.id+'-surface.aru'),s.getDocument().text);await fs.writeFile(path.join(dir,m.id+'-surface.png'),await renderPng(s.getDocument().text,{width:192}));}
await fs.writeFile(path.join(dir,'cinco-materiales.zip'),zipStore([...allFiles,{name:'materiales.json',data:JSON.stringify(reports.filter(r=>r.id!=='base').map(({ai,...r})=>r),null,2)}]));
await fs.writeFile(path.join(dir,'index.html'),renderMaterialGallery(base,group));
