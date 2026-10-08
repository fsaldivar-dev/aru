// Reproducible CPU benchmark and real instrument fixtures. No model calls or user documents.
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { compile } from '../src/engine.js';
import { toAru } from '../src/serialize.js';
import { parentOf } from '../src/edit.js';
import { applyMaterial } from '../src/materials.js';
const dir = new URL('../out/workspace-performance-2026-10-07/', import.meta.url);
const original = compile(await fs.readFile(new URL('../tests/fixtures/performance-instruments.aru', import.meta.url),'utf8')).scene;
await fs.mkdir(dir,{recursive:true});
const rows=[];
for(const count of [100,300,1000]) {
 const scene={...original,root:{...original.root,children:[]},width:72*25,height:72*Math.ceil(count/25)};
 for(let i=0;i<count;i++) {const n=structuredClone(original.root.children[i%20]);n.name=`instrument_${i}`;n.label=`Instrumento ${i+1}`;n.at=[(i%25)*72,Math.floor(i/25)*72];scene.root.children.push(n);}
 const text=toAru(scene);await fs.writeFile(new URL(`${count}.aru`,dir),text);
 if(count<=300){const colored=compile(text).scene;applyMaterial(colored,colored.root.children.map(n=>n.id),{preset:'fruits'});await fs.writeFile(new URL(`${count}-fruits.aru`,dir),toAru(colored));}
 const samples=[];
 for(let k=0;k<4;k++) {global.gc?.();let t=performance.now();const r=compile(text,{dataAttrs:true});const compileMs=performance.now()-t;t=performance.now();let parents=0;for(const n of r.scene.byId.values()) if(parentOf(r.scene,n))parents++;const parentsMs=performance.now()-t;t=performance.now();toAru(r.scene);const serializeMs=performance.now()-t;samples.push({compileMs,parentsMs,serializeMs,nodes:r.scene.byId.size,parents,heapMB:process.memoryUsage().heapUsed/1048576});}
 rows.push({count,bytes:Buffer.byteLength(text),samples:samples.slice(1)});
}
const report={runtime:process.version,platform:process.platform,rows};
await fs.writeFile(new URL(`${process.argv[2]||'cpu-baseline'}.json`,dir),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
