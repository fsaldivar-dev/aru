import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {modelsFromCache,localModelCatalog} from '../tools/model-catalog.mjs';
import {modelOptions} from '../src/model-options.js';
import {createIllustrator} from '../plugin/core.js';
import {workspacePrompt} from '../src/workspace-context.js';
import {askIllustrator,produceIcons,createIconJob} from '../plugin/node.js';
test('only visible model metadata crosses the bridge; malformed cache falls back safely',()=>{
 const cache={identity:'private',models:[null,{slug:123,visibility:'list'},{slug:'visible',display_name:'Visible',visibility:'list',instructions:'private'},{slug:'hidden',visibility:'hide'},{slug:'visible',visibility:'list'},{slug:'bad model',visibility:'list'}]};
 assert.deepEqual(modelsFromCache(cache),[{id:'visible',label:'Visible'}]);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aru-models-'));
 try {fs.writeFileSync(path.join(dir,'models_cache.json'),JSON.stringify(cache));assert.deepEqual(localModelCatalog('codex',dir),{models:[{id:'visible',label:'Visible'}],modelSource:'local-cache'});fs.writeFileSync(path.join(dir,'models_cache.json'),'invalid');assert.deepEqual(localModelCatalog('codex',dir),{});} finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('provider catalog keeps the CLI default, custom saved model and provider-specific choices',()=>{
 assert.deepEqual(modelOptions('codex',{models:[{id:'model-a',label:'Model A'},'model-a']},'custom'),[{id:'',label:'Predeterminado del CLI'},{id:'model-a',label:'Model A'},{id:'custom',label:'custom · personalizado'}]);
 assert(modelOptions('claude').some(m=>m.id==='sonnet'));assert(!modelOptions('claude').some(m=>m.id==='gpt-5.5'));
});
test('active project context reaches the agent, changes atomically and does not claim other files were read',async()=>{
 const session=createIllustrator({project:{id:'mobile',name:'AutoPilot',description:'Automatización móvil'}}),first=session.context();
 assert.equal(first.project.name,'AutoPilot');const calls=[];
 await askIllustrator(session,{message:'¿Qué proyecto estoy usando?',review:0,transport:{run:async req=>{calls.push(req);return {ok:true,output:JSON.stringify({reply:'AutoPilot',operations:[]})};}},provider:'codex'});
 assert.match(calls[0].prompt,/AutoPilot/);assert.match(calls[0].prompt,/Automatización móvil/);
 session.setProject({id:'music',name:'Sonus'});assert.equal(session.context().project.name,'Sonus');assert(session.context().revision>first.revision);assert.throws(()=>session.apply([],{expectedRevision:first.revision}));
 assert.throws(()=>session.setProject({name:''}));assert.equal(session.context().project.name,'Sonus');session.setProject(null);assert.equal(session.context().project,null);
 assert.match(workspacePrompt({name:'AutoPilot'},{name:'Iconos'}),/Other documents have not been read/);
});
test('changing project during an agent call discards its response and refreshes resumed production context',async()=>{
 const session=createIllustrator({project:{name:'AutoPilot'}}),before=session.getDocument().text;
 await assert.rejects(()=>askIllustrator(session,{message:'Dibuja',review:0,transport:{run:async()=>{session.setProject({name:'Sonus'});return {ok:true,stdout:JSON.stringify({structured_output:{reply:'Antiguo',operations:[]}})};}}}),/cambió/);
 assert.equal(session.getDocument().text,before);
 const job=createIconJob('Crea 1 icono'),calls=[];
 await produceIcons(session,{job,review:0,transport:{run:async req=>{calls.push(req);session.setProject({name:'Nuevo proyecto'});return {ok:true,stdout:JSON.stringify({structured_output:{icons:[]}})};}}});
 assert.equal(job.status,'paused');assert.equal(job.accepted.length,0);assert.match(job.reason,/proyecto cambió/);assert.match(calls[0].prompt,/Sonus/);
 await produceIcons(session,{job,review:0,transport:{run:async req=>{calls.push(req);throw new Error('Pausa de prueba');}}});
 assert.match(calls[1].prompt,/Nuevo proyecto/);assert.equal(session.getDocument().text,before);
 await assert.rejects(()=>produceIcons(session,{message:'Crea 1 icono',model:'invalid model',transport:{run:()=>{throw new Error('No debe llamar al proveedor');}}}),/modelo inválido/);
});
