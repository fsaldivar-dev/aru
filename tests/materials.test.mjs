import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createIllustrator, readDocument, listMaterials, prepareIconExports } from '../plugin/index.js';
import { renderPng, refineIllustration } from '../plugin/node.js';
const base = `canvas 80 28
background #F8F8FC
gradient compartido linear 90 { stop 0 #FFFFFF; stop 1 #336688 }
group pack { fill none; stroke #234567 2; semantic ui.iconpack
 group casa { path contorno { move 3.123456789 20; line 3 9; line 12 3; line 21 9; line 21 20; close }
 path hueco { move 10 20; line 10 15; quad 12 13 14 15; line 14 20 }
 line horizontal { from 7 10; to 17 10 }
 line vertical { from 12 7; to 12 11 } }
 group buscar { at 40 0; circle lente { at 10 10; radius 7; fill compartido }
 line mango { from 15 15; to 21 21 } }
}
circle ajeno { at 72 14; radius 4; fill compartido }
`;
const geometry = text => [...readDocument(text).scene.byPath].map(([p,n]) => [p,n.type,n.at,n.scale,n.rotate,n.geom && JSON.parse(JSON.stringify(n.geom,(k,v)=>['line','col'].includes(k)?undefined:v)),n.semantic,n.label,n.children.map(c=>c.path)]);
test('all materials preserve high precision geometry, channels, external paint and exact undo', async () => {
 for (const {id} of listMaterials()) {
  const s=createIllustrator({text:base,selection:['pack.casa']}), before=readDocument(base).scene;
  const r=s.refine([{op:'material',target:'selection',preset:id}]);
  assert(r.geometryPreserved); assert.deepEqual(geometry(r.text),geometry(base));
  const after=readDocument(r.text).scene;
  assert.deepEqual(after.gradients.compartido,before.gradients.compartido);
  assert.equal(after.byPath.get('ajeno').fill,'compartido');
  for(const path of ['pack.casa.contorno','pack.casa.hueco','pack.casa.horizontal','pack.casa.vertical']) {
   const n=after.byPath.get(path); assert.equal(n.fill,path.endsWith('horizontal')||path.endsWith('vertical')?'none':null);
   assert(after.gradients[n.stroke]?.user); assert(!s.svg().includes('NaN'));
   assert.equal(n.strokeWidth,2);
  }
  assert(r.changed.every(p=>p.startsWith('pack.casa.')));
  const {data}=await sharp(await renderPng(r.text,{width:160})).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  for(let i=3;i<data.length;i+=4) assert.equal(data[i],255);
  s.undo();assert.equal(s.getDocument().text,base);
 }
});
test('material edits are atomic and reject locked descendants, outside targets, invalid parameters and geometry extras', () => {
 for(const ops of [
  [{op:'material',target:'pack.casa',preset:'chrome'},{op:'material',target:'ajeno',preset:'clay'}],
  [{op:'material',target:'pack.casa',preset:'unknown'}],
  [{op:'material',target:'pack.casa',preset:'clay',color:'red'}],
  [{op:'material',target:'pack.casa',preset:'clay',strength:NaN}],
  [{op:'material',target:'pack.casa',preset:'clay',strength:0}],
  [{op:'material',target:'pack.casa',preset:'clay',dx:50}],
 ]) {const s=createIllustrator({text:base,selection:['pack.casa']});assert.throws(()=>s.refine(ops));assert.equal(s.getDocument().text,base);}
 const locked=createIllustrator({text:base.replace('line horizontal {','line horizontal { locked 1;'),selection:['pack']});
 assert.throws(()=>locked.refine([{op:'material',target:'pack',preset:'clay'}]),/bloquead/);
 assert.throws(()=>locked.apply([{op:'material',target:'pack',preset:'clay'}]),/rechazado/);
});
test('paint recipes are idempotent, safe after restyling, and gradient reuse does not alter unselected shapes', () => {
 const s=createIllustrator({text:base,selection:['pack']});const op={op:'material',target:'pack',preset:'chrome',color:'#446688'};
 s.refine([op]);const first=s.getDocument().text;s.refine([op]);assert.equal(s.getDocument().text,first);
 const outside=readDocument(first).scene.byPath.get('pack.buscar.lente').fill;
 const oldGradient=readDocument(first).scene.gradients[outside];s.select(['pack.casa']);s.refine([{...op,target:'selection',preset:'fruits'}]);
 const after=readDocument(s.getDocument().text).scene;assert.deepEqual(after.gradients[outside],oldGradient);
 const exports=prepareIconExports(s.getDocument().text,{group:'pack'});assert.equal(exports.entries.length,2);assert(exports.entries.every(e=>!e.svg.includes('NaN')));
});
test('real AI protocol permits one simple material command while keeping replacement guard', async () => {
 const s=createIllustrator({text:base,selection:['pack.casa']});
 const r=await refineIllustration(s,{message:'Cromado',transport:{run:async req=>{
  assert(req.schema.properties.operations.items.properties.op.enum.includes('material'));
  assert(req.schema.properties.operations.items.properties.color);
  assert.match(req.prompt,/"id":"chrome"/);
  return {ok:true,stdout:JSON.stringify({structured_output:{reply:'Cromado',operations:[{op:'material',target:'selection',preset:'chrome',color:null,strength:null}],reference:{use:false},aru:'',aruInto:''}}),ms:1};
 }}});assert(r.geometryPreserved);assert.equal(r.report.operations.length,1);
});
test('horizontal and vertical strokes remain visible after every material in actual PNG rendering', async () => {
 const text='canvas 28 28\nbackground #FFFFFF\ngroup trazo { line h { from 4 8; to 24 8; stroke #234567 2 } line v { from 14 14; to 14 24; stroke #234567 2 } }';
 for(const {id} of listMaterials()) {
  const s=createIllustrator({text,selection:['trazo']});s.refine([{op:'material',target:'selection',preset:id}]);
  assert.match(s.svg(),/filterUnits="userSpaceOnUse"/);
  const {data,info}=await sharp(await renderPng(s.getDocument().text,{width:112})).removeAlpha().raw().toBuffer({resolveWithObject:true});
  for(const points of [Array.from({length:16},(_,i)=>[(6+i)*4,8*4]),Array.from({length:8},(_,i)=>[14*4,(15+i)*4])]) {
   const painted=points.filter(([x,y])=>{const o=(y*info.width+x)*3;return Math.min(...data.subarray(o,o+3))<240;}).length;
   assert(painted>=points.length/2,`${id} erased a stroke`);
  }
 }
});
