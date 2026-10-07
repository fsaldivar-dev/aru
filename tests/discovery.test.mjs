import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { discoverProject, discoverIllustration, reviewDiscoveredIllustration, renderPng, run } from '../plugin/node.js';
const urls = ['https://design.example/style', 'https://design.example/concept'];
const plan = { purpose: 'Planificación local', audience: 'Equipos', uncertainty: '', sources: urls.map(url => ({ url, title: 'Referencia', insight: 'Forma clara' })), directions: ['Flujo', 'Puente', 'Órbita'].map(name => ({ name, metaphor: name, rationale: 'Relaciona trabajo y avance' })), chosen: 1, brief: 'Un puente tonal compacto.' };
function reply(answer, searched = true) {
  const events = searched ? [{ message: { content: [{ type: 'tool_use', id: 'search1', name: 'WebSearch', input: { query: 'planning visual metaphor' } }] } }, { message: { content: [{ type: 'tool_result', tool_use_id: 'search1', content: urls.join(' ') }] } }] : [];
  return { ok: true, stdout: [...events, { type: 'result', structured_output: answer }].map(x => JSON.stringify(x)).join('\n'), ms: 2 };
}
async function fixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'aru-discovery-test-'));
  await fs.writeFile(path.join(repo, 'README.md'), '# Producto\nPlanificación local.\n![logo](old-logo.png)');
  t.after(() => fs.rm(repo, { recursive: true, force: true })); return repo;
}
test('discovery requires actual successful search and provenance for every cited source', async t => {
  const repo = await fixture(t);
  await assert.rejects(discoverProject({ repo, visual: false, style: 'tonal', transport: { run: async () => reply(plan, false) } }), /ninguna búsqueda/);
  await assert.rejects(discoverProject({ repo, visual: false, style: 'tonal', transport: { run: async () => reply({ ...plan, sources: [...plan.sources, { url: 'https://invented.example', title: 'Inventada', insight: 'Nada' }] }) } }), /sin evidencia/);
  const result = await discoverProject({ repo, visual: false, style: 'tonal', transport: { run: async req => { assert.equal(req.research, true); assert.equal(req.images.length, 0); assert(!req.prompt.includes('old-logo.png')); return reply(plan); } } });
  assert.equal(result.directions[result.chosen].name, 'Puente'); assert.equal(result.evidence[0].completed, true);
});
test('discovery generates from its own chosen concept into a fixed editable opaque canvas', async t => {
  const repo = await fixture(t); let n = 0;
  const result = await discoverIllustration({ repo, visual: false, style: 'tonal', review: 0, transport: { run: async req => {
    if (n++ === 0) return reply(plan);
    assert(!req.research); assert.match(req.prompt, /Un puente tonal compacto/); assert.equal(req.images.length, 1); assert.equal(req.images[0].name, 'canvas');
    return reply({ reply: 'Creado', operations: [], reference: { use: false }, aruInto: 'NoExiste', aru: 'group Puente { semantic identidad.puente; circle Arco { at 256 256; radius 100; fill #432F80 } }' }, false);
  } } });
  assert.equal(n, 2); assert.match(result.text, /canvas 512 512/); assert.match(result.text, /identidad.puente/);
  const { data, info } = await sharp(await renderPng(result.text)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 512); for (let i = 3; i < data.length; i += info.channels) assert.equal(data[i], 255);
});
test('research is explicitly unsupported for bridges without isolated web tools', async () => {
  await assert.rejects(run({ provider: 'codex', research: true }), /Discovery web requiere Claude/);
});
test('visual review rejects concept drift, redraws from discovery and verifies the new result', async () => {
  const text = 'canvas 512 512\nbackground #FFFFFF\ncircle wrong { at 256 256; radius 80; fill #123456 }';
  let n = 0;
  const result = await reviewDiscoveredIllustration(text, { discovery: { ...plan, style: 'tonal', project: { name: 'App' } }, transport: { run: async req => {
    if (n++ === 0) { assert.equal(req.images.length, 2); assert.equal(req.research, undefined); return reply({ accept: true, purposeMatch: true, conceptMatch: false, styleMatch: true, smallLegibility: true, reason: 'Falta el puente', correction: 'Dibuja el puente elegido.' }, false); }
    if (n === 2) { assert.match(req.prompt, /Dibuja el puente elegido/); return reply({ reply: 'Corregido', operations: [], reference: { use: false }, aruInto: '', aru: 'group Puente { rect Paso { at 256 256; size 200 60; fill #432F80 } }' }, false); }
    return reply({ accept: true, purposeMatch: true, conceptMatch: true, styleMatch: true, smallLegibility: true, reason: 'Ahora coincide', correction: '' }, false);
  } } });
  assert.equal(n, 3); assert.equal(result.quality.redraws, 1); assert.equal(result.quality.reviews[0].accept, false); assert.equal(result.quality.reviews[1].accept, true); assert.match(result.text, /Puente/); assert.equal(result.quality.initialText, text);
});

test('syntax repair preserves discovery brief and attempted geometry instead of inventing from app name', async t => {
  const repo = await fixture(t); let n = 0;
  const result = await discoverIllustration({ repo, visual: false, style: 'tonal', review: 0, transport: { run: async req => {
    if (n++ === 0) return reply(plan);
    if (n === 2) return reply({ reply: 'Puente', operations: [], reference: { use: false }, aruInto: 'Icono', aru: 'group Puente { path Arco { move 50 200;' }, false);
    assert.match(req.prompt, /Un puente tonal compacto/); assert.match(req.prompt, /group Puente \{ path Arco \{ move 50 200/); assert.match(req.prompt, /preserving the requested concept/);
    return reply({ reply: 'Sintaxis reparada', operations: [], reference: { use: false }, aruInto: 'Icono', aru: 'group Puente { path Arco { move 50 200; quad 256 50 450 200; fill none; stroke #432F80 20 } }' }, false);
  } } });
  assert.equal(n, 3); assert.equal(result.report.generation.repaired, true); assert.match(result.text, /Puente/); assert.match(result.text, /quad/);
});

test('a concept that looks good but communicates the wrong product is rejected independently', async () => {
 const text='canvas 512 512\nbackground #FFF\ncircle Disco { at 256 256; radius 120; fill #555 }';
 const discovery={...plan,purpose:'Automatización móvil',userFeedback:'No es una app de música',style:'Y2K cromado',project:{name:'AutoPilot'}};
 let n=0;
 const result=await reviewDiscoveredIllustration(text,{discovery,review:1,transport:{run:async req=>{
  n++;
  assert.match(req.prompt,/Automatización móvil/);assert.match(req.prompt,/No es una app de música/);
  if(n===1)return reply({accept:true,purposeMatch:false,conceptMatch:true,styleMatch:true,smallLegibility:true,reason:'El disco comunica música, aunque respete el concepto',correction:'Expresa automatización móvil'},false);
  if(n===2){assert.match(req.prompt,/Expresa automatización móvil/);return reply({reply:'Control móvil',operations:[],reference:{use:false},aruInto:'Icono',aru:'group Control { rect Dispositivo { at 256 256; size 150 240; fill #567 } }'},false);}
  return reply({accept:true,purposeMatch:true,conceptMatch:true,styleMatch:true,smallLegibility:true,reason:'Representa acciones móviles',correction:''},false);
 }}});
 assert.equal(n,3);assert.equal(result.quality.redraws,1);
 assert.equal(result.quality.reviews[0].purposeMatch,false);assert.equal(result.quality.reviews[0].conceptMatch,true);
 assert.equal(result.quality.reviews[0].accept,false);assert.equal(result.quality.reviews[1].accept,true);
 assert.match(result.text,/Dispositivo/);

});

test('non-aquatic Frutiger guidance and user purpose correction reach research, drawing and review', async t => {
 const repo=await fixture(t);let n=0;
 const feedback='La función principal es automatización móvil';
 const result=await discoverIllustration({repo,style:'Frutiger Aero',feedback,visual:false,transport:{run:async req=>{
  n++;
  if(n===1){const p=JSON.parse(req.prompt);assert(p.styleProfile.avoid.includes('Burbujas acuáticas'));assert.equal(p.feedback,feedback);assert.equal(p.styleProfile.sources,undefined);return reply(plan);}
  assert.match(req.prompt,/Burbujas acuáticas/);assert(req.prompt.includes(feedback));
  if(n===2)return reply({reply:'Creado',operations:[],reference:{use:false},aruInto:'Icono',aru:'group Control { rect Dispositivo { at 256 256; size 150 240; fill #567 } }'},false);
  return reply({accept:true,purposeMatch:true,conceptMatch:true,styleMatch:true,smallLegibility:true,reason:'Control de acciones móviles',correction:''},false);
 }}});
 assert.equal(n,3);assert.equal(result.report.discovery.styleProfile.id,'frutiger-aero');assert.equal(result.report.discovery.userFeedback,feedback);
});

test('review keeps the strongest checked draft when a later redraw regresses or ties', async () => {
 const text='canvas 512 512\nbackground #FFF\ncircle Mejor { at 256 256; radius 120; fill #555 }'; let n=0;
 const result=await reviewDiscoveredIllustration(text,{discovery:{...plan,style:'tonal',project:{name:'App'}},review:1,transport:{run:async()=>{
  if(n++===0)return reply({accept:false,purposeMatch:true,conceptMatch:true,styleMatch:false,smallLegibility:true,reason:'Falta material',correction:'Ajusta material'},false);
  if(n===2)return reply({reply:'Otro',operations:[],reference:{use:false},aruInto:'Icono',aru:'group Peor { circle Forma { at 256 256; radius 120; fill #567 } }'},false);
  return reply({accept:false,purposeMatch:false,conceptMatch:true,styleMatch:true,smallLegibility:true,reason:'Perdió el propósito',correction:'Recupera significado'},false);
 }}});
 assert.equal(result.text,text);assert.equal(result.quality.selectedRound,1);assert.equal(result.quality.reviews[1].kept,false);
});
