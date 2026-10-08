import test from 'node:test';
import assert from 'node:assert/strict';
import { createIconJob, requestedIconCount, runIconJob, verifyIconJob, productionStatus, revalidateIconJob } from '../src/icon-production.js';
import { createIllustrator, readDocument } from '../plugin/core.js';
import { produceIcons, askIllustrator, exportIconArchive } from '../plugin/node.js';
import { productionBrief } from '../src/production-brief.js';

const base = 'canvas 800 600\nbackground #FFFFFF\n';
const icon = i => ({ label: `Function ${i}`, purpose: `Distinct function ${i}`, aru: `path mark { move 4 4; line ${8 + i / 100} 12; line 20 20; fill none; stroke #604631 1.8 }\n` + Array.from({ length: 9 }, (_, bit) => `line bit${bit} { from 4 ${3 + bit * 2}; to ${i & (1 << bit) ? 18 : 8} ${3 + bit * 2}; stroke #604631 1 }`).join('\n') });
function harness() { let text = base; return { getText: () => text, commit: next => { text = next; } }; }

test('brief chooses the latest and most specific style without matching parts of words',()=>{
 assert.equal(productionBrief('Crea iconos populares').style,'');
 assert.equal(productionBrief('Crea iconos Frutiger Aero Dark').style,'dark-aero');
 assert.equal(productionBrief('Ahora Material 3 Expressive',{history:[{role:'user',text:'Usa Frutiger Fruits'}]}).style,'material-3-expressive');
 assert.equal(productionBrief('Crea 300 iconos',{history:[{role:'user',text:'Material Fruits'}]}).material,'fruits');
});

test('requested explicit icon counts; does not interpret dimensions or ordinary edit requests', () => {
  assert.equal(requestedIconCount('Genera un pack de 320 iconos que no se repitan'), 320);
  assert.equal(requestedIconCount('create 48 vintage music icons'), 48);
  assert.equal(requestedIconCount('Exporta los iconos a 320 px'), null);
  assert.equal(requestedIconCount('Cambia el color de 50 iconos'), null);
});
test('320 requested: partial replies are continued, inventory is passed and actual direct groups reach exactly 320', async () => {
  const h = harness(), job = createIconJob('Crea 320 iconos vintage'), counts = [];
  let serial = 0;
  await runIconJob(job, { ...h, request: async (system, prompt) => {
    assert.match(prompt, /Target: 320/); if (serial) assert.match(prompt, /Function 0/);
    const asked = Number(/EXACTLY (\d+)/.exec(prompt)[1]);
    // A provider delivers only eight per answer. The engine must still fulfil 320.
    return { icons: Array.from({ length: Math.min(8, asked) }, () => icon(serial++)) };
  }, checkpoint: async (state, text) => { assert.equal(verifyIconJob(state, text), state.accepted.length); counts.push(state.accepted.length); } });
  assert.equal(job.status, 'complete'); assert.equal(job.accepted.length, 320); assert.equal(job.attempts, 40);
  assert.equal(readDocument(h.getText()).scene.root.children[0].children.length, 320);
  assert(counts.includes(24)); assert(counts.includes(312));
});
test('renaming/repainting geometry, duplicate labels, empty/invalid/clipped drawings rejected; pause after three empty batches', async () => {
  const h = harness(), job = createIconJob('Crea 4 iconos'); let n = 0;
  await runIconJob(job, { ...h, request: async () => ({ icons: n++ === 0 ? [icon(1)] : [
    { ...icon(1), label: 'Other', aru: icon(1).aru.replace('mark', 'changed').replace('#604631', '#FF0000') },
    { ...icon(2), label: 'function 1' },
    { ...icon(3), aru: 'group empty {}' },
    { ...icon(4), aru: 'rect invisible { at 12 12; size 16 16; fill none; stroke none }' },
  ] }) });
  assert.equal(job.status, 'paused'); assert.equal(job.accepted.length, 1); assert.equal(job.attempts, 4);
  assert(job.issues.some(e => /Geometría repetida/.test(e.reason)));
  assert(job.issues.some(e => /Nombre repetido/.test(e.reason)));
});
test('stop keeps committed work; JSON checkpoint resumes only pending slots and honours original target', async () => {
  const h = harness(), job = createIconJob('Crea 33 iconos'), controller = new AbortController(); let serial = 0, checkpoint;
  await runIconJob(job, { ...h, signal: controller.signal, request: async () => ({ icons: Array.from({ length: 16 }, () => icon(serial++)) }),
    checkpoint: async state => { checkpoint = JSON.parse(JSON.stringify(state)); if (state.accepted.length === 16) controller.abort(); } });
  assert.equal(job.status, 'paused'); assert.equal(job.accepted.length, 16);
  const asked = [];
  await runIconJob(checkpoint, { ...h, request: async (_, prompt) => { const count = Number(/EXACTLY (\d+)/.exec(prompt)[1]); asked.push(count); return { icons: Array.from({ length: count }, () => icon(serial++)) }; } });
  assert.equal(checkpoint.status, 'complete'); assert.deepEqual(asked, [16, 1]); assert.equal(verifyIconJob(checkpoint, h.getText()), 33);
});
test('document edits during a call are preserved; undo prevents false completion/resume', async () => {
  const h = harness(), job = createIconJob('Crea 30 iconos');
  await runIconJob(job, { ...h, request: async () => { h.commit(base + 'circle user { at 100 100; radius 10 }'); return { icons: [icon(1)] }; } });
  assert.equal(job.status, 'paused'); assert.equal(job.accepted.length, 0); assert.match(h.getText(), /circle user/);
  await runIconJob(job,{...h,request:async()=>({icons:[icon(2)]})});
  assert.match(h.getText(),/circle user/); assert.equal(job.accepted.length,1);
  const s = createIllustrator({ text: base });
  const result = await produceIcons(s, { job: createIconJob('Crea 1 icono'), transport: { run: async () => ({ ok: true, stdout: JSON.stringify({ structured_output: { icons: [icon(1)] } }) }) } });
  assert(result.report.complete); s.undo(); assert.throws(() => verifyIconJob(result.report.production, s.getDocument().text), /Inventario modificado/);
});
test('node ask auto-routes large requests; per-batch undo, original content and ZIP exports survive', async () => {
  const original = base + 'circle original { at 20 20; radius 5; fill #FF0000 }', s = createIllustrator({ text: original }); let serial = 0;
  const r = await askIllustrator(s, { message: 'Crea 25 iconos', review: 0, transport: { run: async req => {
    assert(req.schema.properties.icons); const count = Number(/EXACTLY (\d+)/.exec(req.prompt)[1]);
    return { ok: true, stdout: JSON.stringify({ structured_output: { icons: Array.from({ length: count }, () => icon(serial++)) } }) };
  } } });
  assert(r.report.complete); assert.equal(r.report.production.accepted.length, 25);
  assert(readDocument(s.getDocument().text).scene.root.children.some(n => n.name === 'original'));
  const zip = await exportIconArchive(s.getDocument().text, { group: r.report.production.id, sizes: [24], formats: ['svg', 'aru'] });
  assert.equal(zip.manifest.entries.length, 25);
  s.undo(); assert.equal(readDocument(s.getDocument().text).scene.root.children[1].children.length, 16);
  s.undo(); assert.equal(s.getDocument().text, original);
});
test('gradient names are isolated across jobs and repeated colours do not evade geometry checks', async () => {
  const h = harness(), entry = { label: 'Glass', purpose: 'Glass icon', aru: 'gradient glass linear 90 { stop 0 #FFF; stop 1 #ACE }\ncircle body { at 12 12; radius 8; fill glass; stroke none }' };
  const first = createIconJob('Crea 1 icono'), second = createIconJob('Crea 1 icono');
  await runIconJob(first, { ...h, request: async () => ({ icons: [entry] }) });
  await runIconJob(second, { ...h, request: async () => ({ icons: [{...entry,label:'Glass triangle',aru:entry.aru.replace('circle body { at 12 12; radius 8;','polygon body { points 4 4 20 4 12 20;')}] }) });
  assert.equal(first.status, 'complete'); assert.equal(second.status, 'complete'); assert.equal(Object.keys(readDocument(h.getText()).scene.gradients).length, 2);
});


test('brief, palette and Fruits survive all batches and recolouring a complete pack keeps its verified count', async()=>{
 const s=createIllustrator({text:base}),job=createIconJob('Crea 33 iconos',{batchSize:16,style:'Material 3',material:'fruits',color:'#2463EB',accent:'#FFD426',purpose:'Automatización móvil',history:[{role:'user',text:'La app automatiza tareas en el móvil; no es de DJ'}]});let serial=0,calls=0;
 await produceIcons(s,{job,review:1,transport:{run:async req=>{
  assert.match(req.prompt,/Automatización móvil/);
  if(req.schema.properties.accept){calls++;assert(req.images[0].data.length>100);return {ok:true,stdout:JSON.stringify({structured_output:{accept:true,styleMatch:true,purposeMatch:true,smallLegibility:true,reason:'coherente'}})};}
  assert.match(req.prompt,/#2463EB/);assert.match(req.prompt,/material-3/);
  return {ok:true,stdout:JSON.stringify({structured_output:{icons:Array.from({length:Number(/EXACTLY (\d+)/.exec(req.prompt)[1])},()=>icon(serial++))}})};
 }}});
 assert.equal(job.status,'complete');assert.equal(calls,3);
 s.select([job.id]);s.refine([{op:'palette',target:'selection',color:'#336699',accent:'#EFCB33',material:'fruits'}]);
 const status=productionStatus(job,s.getDocument().text);assert.equal(status.valid,true);assert.equal(status.count,33);assert.equal(status.status,'complete');
 assert([...readDocument(s.getDocument().text).scene.byId.values()].filter(n=>n.type==='line').every(n=>n.stroke.startsWith('aru_mat_fruits_')));
 await produceIcons(s,{job,transport:{run:()=>{throw new Error('Complete jobs must not call the provider');}}});assert.equal(job.status,'complete');
});
test('existing inventory is excluded; additional and total have distinct targets',async()=>{
 const h=harness(),prior=createIconJob('Crea 2 iconos');let serial=0;
 await runIconJob(prior,{...h,request:async()=>({icons:[icon(serial++),icon(serial++)]})});
 const initial=h.getText(),additional=createIconJob('Crea 3 iconos que faltan');let attempt=0;
 await runIconJob(additional,{...h,request:async(_,prompt)=>{assert.match(prompt,/Function 0/);const count=Number(/EXACTLY (\d+)/.exec(prompt)[1]);return {icons:[...(attempt++===0?[icon(0)]:[]),...Array.from({length:count},()=>icon(serial++))]};}});
 assert.equal(additional.existing.length,2);assert.equal(additional.target,3);assert.equal(additional.accepted.length,3);
 let text=initial;const total=createIconJob('Crea 3 iconos en total');
 await runIconJob(total,{getText:()=>text,commit:n=>text=n,request:async()=>({icons:[icon(99)]})});
 assert.equal(total.target,1);assert.equal(total.accepted.length,1);
});
test('Node resumes a repainted pack with explicit palette and recipe overrides',async()=>{
 const s=createIllustrator({text:base}),job=createIconJob('Crea 3 iconos',{batchSize:2,style:'Material 3',material:'chrome',color:'#336699'}),controller=new AbortController();let serial=0;
 const transport={run:async req=>({ok:true,stdout:JSON.stringify({structured_output:{icons:Array.from({length:Number(/EXACTLY (\d+)/.exec(req.prompt)[1])},()=>icon(serial++))}})})};
 await produceIcons(s,{job,review:0,transport,signal:controller.signal,checkpoint:state=>{if(state.accepted.length===2) controller.abort();}});
 assert.equal(job.accepted.length,2);s.select([job.id]);s.refine([{op:'palette',target:'selection',color:'#2463EB',material:'fruits'}]);
 await produceIcons(s,{job,review:0,transport,color:'#2463EB',material:'fruits'});
 assert.equal(job.status,'complete');assert.equal(job.brief.styleProfile.id,'material-3');assert.equal(job.brief.material,'fruits');
 assert([...readDocument(s.getDocument().text).scene.byId.values()].filter(n=>n.type==='line').every(n=>n.stroke.startsWith('aru_mat_fruits_')));
});
test('explicit revalidation preserves user edits, repairs missing slots and never reuses deleted IDs',async()=>{
 const s=createIllustrator({text:base}),job=createIconJob('Crea 3 iconos');let serial=0;
 await runIconJob(job,{getText:()=>s.getDocument().text,commit:n=>s.replacePrepared(n),request:async()=>({icons:[icon(serial++),icon(serial++),icon(serial++)]})});
 s.apply([{op:'delete',target:job.id+'.icon_0002'}]);
 assert.equal(productionStatus(job,s.getDocument().text).count,2);assert.equal(productionStatus(job,s.getDocument().text).valid,false);
 await revalidateIconJob(job,s.getDocument().text);assert.equal(job.accepted.length,2);
 await runIconJob(job,{getText:()=>s.getDocument().text,commit:n=>s.replacePrepared(n),request:async(_,prompt)=>{assert.match(prompt,/EXACTLY 1/);return {icons:[icon(100)]};}});
 assert.equal(job.status,'complete');assert.equal(job.accepted[2].id,'icon_0004');
});
test('wrong style or purpose fails visual review before commitment, can recover with the same brief',async()=>{
 const h=harness(),job=createIconJob('Crea 1 icono',{style:'Funky Seasons',purpose:'Automatización móvil'});let reviewed=0;
 await runIconJob(job,{...h,request:async()=>({icons:[icon(99)]}),reviewBatch:async()=>{reviewed++;return {accept:true,purposeMatch:false,reason:'Parece un DJ, no automatización'};}});
 assert.equal(job.status,'paused');assert.equal(reviewed,3);assert.equal(h.getText(),base);assert.match(job.reason,/revisión visual/);
 await runIconJob(job,{...h,request:async()=>({icons:[icon(100)]}),reviewBatch:async()=>({accept:true,styleMatch:true,purposeMatch:true,smallLegibility:true,reason:'Legible'})});assert.equal(job.status,'complete');
});
test('300-piece ZIP is actually exported without editing the source',async()=>{
 const h=harness(),job=createIconJob('Crea 300 iconos');let serial=0;
 await runIconJob(job,{...h,request:async(_,prompt)=>({icons:Array.from({length:Number(/EXACTLY (\d+)/.exec(prompt)[1])},()=>icon(serial++))})});
 const text=h.getText(),zip=await exportIconArchive(text,{group:job.id,sizes:[24],formats:['png','aru']});assert.equal(zip.manifest.entries.length,300);assert.equal(zip.fileCount,601);assert.equal(h.getText(),text);
});
