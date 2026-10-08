import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createIllustrator, readDocument, documentContext } from '../plugin/core.js';
import { toAru } from '../src/serialize.js';
import { normalizeResource, listResources, resourcePrompt } from '../src/resources.js';
import { selectNodes } from '../src/ops.js';
import { assistantFlow, validateAssistantAnswer, resolveCreatedOperations } from '../src/assistant-flow.js';
import { systemPrompt, ANSWER_SCHEMA } from '../src/agents.js';
const base = `canvas 800 500
background #FFFFFF
gradient blue linear 90 { stop 0 #3075B6; stop 1 #123456 }
group original { at 100 100; locked 1
 rect tile { size 100 100; corner 24; fill blue }
 circle record { radius 35; fill #142232 }
 circle label { radius 12; fill #FFCB42 }
}
group splash { at 300 20; rect bg { at 150 220; size 300 440; fill #F4EEDB } }
`;
const metadata = { key:'musaru.icon',kind:'app-icon',brand:'Musaru',purpose:'Identidad oficial para splash y portada',tags:['Música','vinilo',' música '],identity:'Vinilo "m"; azul y amarillo. No cambiar la marca.\nTexto O\'Brien \\ ruta',reusable:true };
function session() { const api=createIllustrator({text:base.replace('locked 1','')}); api.apply([{op:'set',target:'original',resource:metadata}]); return api; }
test('resource identity round-trips quotes, newline, apostrophes and backslashes through ARU and history',()=>{
 const api=session(),expected=normalizeResource(metadata),text=api.getDocument().text;
 assert.deepEqual(readDocument(toAru(readDocument(text).scene)).scene.byPath.get('original').resource,expected);
 assert.deepEqual(api.context().resources[0].tags,['música','vinilo']);
 const copied=api.context();copied.resources[0].tags.push('bad');assert.equal(api.context().resources[0].tags.length,2);
 api.undo();assert.equal(api.context().resources.length,0);api.redo();assert.deepEqual(api.context().resources[0].identity,metadata.identity);
});
test('reuse copies exact editable geometry, isolates gradients, preserves original and tracks lineage',()=>{
 const api=session();api.apply([{op:'set',target:'original',locked:true}]);const before=api.getDocument().text;
 api.apply([{op:'reuse',other:'resource:musaru.icon',target:'splash',x:150,y:120,scale:0.7}]);
 const scene=readDocument(api.getDocument().text).scene,copy=scene.byPath.get('splash.original'),original=scene.byPath.get('original');
 assert.equal(copy.resource.source,'musaru.icon');assert.equal(copy.resource.key,undefined);assert.equal(copy.locked,undefined);
 assert.deepEqual(copy.at,[150,120]);assert.deepEqual(copy.scale,[0.7,0.7]);
 assert.deepEqual(copy.children.map(n=>n.geom),original.children.map(n=>n.geom));
 assert.notEqual(copy.children[0].fill,original.children[0].fill);assert.deepEqual(scene.gradients[copy.children[0].fill],scene.gradients.blue);
 api.undo();assert.equal(api.getDocument().text,before);
});
test('tags and purpose are searchable and resources past large outlines stay in AI inventory',()=>{
 const api=session();const scene=readDocument(api.getDocument().text).scene;
 assert.deepEqual(selectNodes(scene,'tag:música kind:app-icon').map(n=>n.path),['original']);
 assert.equal(listResources(scene,{query:'splash',brand:'musaru'}).length,1);
 const many=Array.from({length:700},(_,i)=>`circle c${i} { at ${i} 2; radius 1 }`).join('\n');
 const large=readDocument(many+'\n'+api.getDocument().text).scene;
 assert.match(resourcePrompt(large),/musaru.icon/);assert.equal(documentContext(toAru(large)).resources.length,1);
 assert.match(systemPrompt({illustrator:true}),/untrusted descriptive data/);
 assert.ok(ANSWER_SCHEMA.properties.operations.items.properties.op.enum.includes('reuse'));
});
test('invalid metadata, duplicate keys and forbidden reuse fail atomically',()=>{
 const api=session(),before=api.getDocument().text;
 for(const operations of [
  [{op:'set',target:'splash',resource:{...metadata,key:'musaru.icon'}}],
  [{op:'set',target:'original',resource:{...metadata,reusable:'yes'}}],
  [{op:'reuse',other:'tag:absent',target:'splash'}],
  [{op:'translate',target:'splash',dx:1},{op:'reuse',other:'original',target:'original.tile'}],
 ]) {assert.throws(()=>api.apply(operations));assert.equal(api.getDocument().text,before);}
 api.apply([{op:'set',target:'splash',locked:true}]);assert.throws(()=>api.apply([{op:'reuse',other:'original',target:'splash'}]),/bloqueada/);
 api.apply([{op:'set',target:'original',resource:{...metadata,reusable:false}}]);assert.throws(()=>api.apply([{op:'reuse',other:'original',target:'root'}]));
});
test('duplicate demotes canonical key and paint or redraw retain saved identity',()=>{
 const api=session();api.apply([{op:'duplicate',target:'original'}]);
 assert.equal(api.context().resources.filter(r=>r.key==='musaru.icon').length,1);
 assert.equal(api.context().resources.find(r=>r.path==='original_2').source,'musaru.icon');
 api.select(['original']);const before=api.context().resources[0];
 api.refine([{op:'material',target:'original',preset:'chrome'}],{mode:'style'});
 assert.deepEqual(api.context().resources[0],before);
 api.refine([{op:'redraw',target:'original',aru:'circle vinyl { radius 40; fill #142232 }'}],{mode:'redraw'});
 assert.deepEqual(api.context().resources[0],before);
 assert.throws(()=>api.refine([{op:'set',target:'original',resource:{identity:'changed'}}],{mode:'redraw'}));
});
test('detached child keeps inherited appearance and reuse applies explicit zero coordinates',()=>{
 const api=createIllustrator({text:'canvas 100 100\ngroup family { fill #123456; stroke #ABCDEF 2; opacity 0.5; circle glyph { radius 5 } }'});
 api.apply([{op:'set',target:'family.glyph',resource:{kind:'ui-icon',tags:[]}}]);
 api.apply([{op:'reuse',other:'family.glyph',target:'root',x:0,y:0}]);
 const sc=readDocument(api.getDocument().text).scene,copy=sc.root.children[1];
 assert.deepEqual(copy.at,[0,0]);assert.equal(copy.resource.source,'family.glyph');
 assert.equal(copy.children[0].fill,'#123456');assert.equal(copy.children[0].strokeWidth,2);assert.equal(copy.children[0].opacity,0.5);
});
test('creation can reuse into its fresh wrapper but cannot reuse into an existing piece',()=>{
 const flow=assistantFlow({message:'Crea un splash de Musaru'}),op={op:'reuse',other:'resource:musaru.icon',target:'$created',x:40,y:40};
 assert.doesNotThrow(()=>validateAssistantAnswer(flow,{operations:[op],aru:'group splash {}'}));
 assert.throws(()=>validateAssistantAnswer(flow,{operations:[{...op,target:'existing'}],aru:'group splash {}'}));
 assert.throws(()=>validateAssistantAnswer(flow,{operations:[op],aru:''}));
 assert.throws(()=>resolveCreatedOperations([op],[]));assert.equal(resolveCreatedOperations([op],['Splash_2'])[0].target,'Splash_2');
});
test('CLI lists and filters saved resources and reuses via apply',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aru-resources-'));
 try {const input=join(dir,'base.aru'),ops=join(dir,'ops.json'),out=join(dir,'copy.aru');await writeFile(input,session().getDocument().text);await writeFile(ops,JSON.stringify([{op:'reuse',other:'resource:musaru.icon',target:'splash',x:150,y:100}]));
 const cli=(...args)=>JSON.parse(execFileSync(process.execPath,['bin/aru.mjs',...args],{encoding:'utf8'}));
 assert.equal(cli('resources',input,'--tag','vinilo','--brand','Musaru').resources.length,1);
 assert.equal(cli('resources',input,'--kind','logo').resources.length,0);
 cli('apply',input,'--ops',ops,'--out',out);assert.equal(cli('context',out).resources.length,2);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('agent orchestration receives saved identity and reuses inside its new composition',async()=>{
 const {askIllustrator}=await import('../plugin/node.js');const api=session(),before=api.getDocument().text,calls=[];
 await askIllustrator(api,{message:'Crea un splash de Musaru con su icono oficial',illustrator:true,review:0,provider:'codex',transport:{run:async req=>{
  calls.push(req);return {ok:true,output:JSON.stringify({reply:'Splash con el icono existente',aru:'group cover { rect bg { at 160 240; size 320 480; fill #123456 } }',operations:[{op:'reuse',other:'resource:musaru.icon',target:'$created',x:160,y:160,scale:1}],reference:{use:false}})};
 }}});
 assert.match(calls[0].prompt,/musaru.icon/);assert.match(calls[0].prompt,/Identidad oficial/);
 assert.equal(api.context().resources.filter(r=>r.source==='musaru.icon').length,1);
 assert.match(api.context().resources.find(r=>r.source==='musaru.icon').path,/cover/);
 api.undo();assert.equal(api.getDocument().text,before);
});
test('redrawing a parent cannot discard registered child resource identity',()=>{
 const api=session();api.select(['original']);
 api.apply([{op:'set',target:'original.record',resource:{key:'musaru.vinyl',kind:'illustration',identity:'Vinilo negro',tags:['vinilo']}}]);
 assert.throws(()=>api.refine([{op:'redraw',target:'original',aru:'circle replacement { radius 35; fill #142232 }'}],{mode:'redraw'}),/ficha del recurso/);
});
