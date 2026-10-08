import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('CLI checkpoints partial output, resumes original target, reports incomplete correctly and retains safe edits and protects changed inventory', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aru-production-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const mock = path.join(dir, 'claude');
  await fs.writeFile(mock, `#!/usr/bin/env node
import fs from 'node:fs';
if(process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
let input='';for await(const chunk of process.stdin)input+=chunk;
const prompt=JSON.parse(input).message.content[0].text;
const inventory=JSON.parse(prompt.split('Inventory (exclude these meanings and labels): ')[1].split('\\nPrevious')[0]);
const count=Number(/EXACTLY (\\d+)/.exec(prompt)[1]), used=new Set(inventory.map(i=>i.label));
let icons=Array.from({length:33},(_,i)=>({label:'Action '+i,purpose:'Function '+i,aru:Array.from({length:9},(_,bit)=>'line p'+bit+' { from 4 '+(3+bit*2)+'; to '+(i&(1<<bit)?18:8)+' '+(3+bit*2)+'; stroke #604631 1 }').join('\\n')})).filter(i=>!used.has(i.label)).slice(0,count);
if(process.env.ARU_FIXTURE_STALL&&inventory.length>=16)icons=[];
console.log(JSON.stringify({type:'result',structured_output:{icons}}));
`, { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  const source = path.join(dir, 'base.aru'), out = path.join(dir, 'pack.aru'), checkpoint = path.join(dir, 'job.json');
  await fs.writeFile(source, 'canvas 800 600\nbackground #FFF\n');
  const cli = path.resolve('bin/aru.mjs'), env = { ...process.env, PATH: dir + ':' + process.env.PATH, SHELL: '/bin/false' };
  const run = (args, extra = {}) => { const r = spawnSync(process.execPath, [cli, 'produce', source, '--out', out, '--job', checkpoint, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 }); assert(!r.error, r.error?.message); return { code: r.status, body: JSON.parse(r.stdout) }; };
  const first = run(['--message', 'Crea 33 iconos'], { ARU_FIXTURE_STALL: '1' });
  assert.equal(first.code, 1); assert.equal(first.body.ok, false); assert(first.body.partial);
  assert.equal(first.body.report.production.accepted.length, 16);
  const saved = JSON.parse(await fs.readFile(checkpoint)); assert.equal(saved.job.status, 'paused'); assert.equal(saved.text, await fs.readFile(out, 'utf8'));
  const resumed = run(['--resume']); assert.equal(resumed.code, 0); assert(resumed.body.ok); assert.equal(resumed.body.report.production.accepted.length, 33);
  await fs.appendFile(out, '\ncircle manual { at 100 100; radius 2 }');
  const protectedOutput = await fs.readFile(out, 'utf8'), edited = run(['--resume']);
  assert.equal(edited.code,0); assert.match(await fs.readFile(out,'utf8'),/circle manual/);
  const painted=(await fs.readFile(out,'utf8')).replaceAll('#604631','#2463EB'); await fs.writeFile(out,painted);
  assert.equal(run(['--resume']).code,0); assert.match(await fs.readFile(out,'utf8'),/#2463EB/);
  const changed=(await fs.readFile(out,'utf8')).replace('to 8 3','to 9 3'); await fs.writeFile(out,changed);
  const invalid=run(['--resume']);assert.equal(invalid.code,1);assert.match(invalid.body.error.message,/Inventario modificado/);assert.equal(await fs.readFile(out,'utf8'),changed);
});
