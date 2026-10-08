import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { exploreIconStyles, renderPng } from '../plugin/node.js';
import { fitExplorationArtwork, reviewIconExploration } from '../plugin/icon-exploration.js';
import { readDocument } from '../plugin/core.js';

const labels = ['Guitarra eléctrica', 'Teclado musical', 'Maracas', 'Batería acústica'];
const ids = ['guitarra_electrica', 'teclado_musical', 'maracas', 'bateria_acustica'];
const hash = data => createHash('sha256').update(data).digest('hex');
const pixels = await sharp({ create: { width: 120, height: 160, channels: 4, background: '#FA120A' } }).png().toBuffer();
function discovery() {
  return { subjects: labels.map((subject, i) => ({ subject, brief: `Objeto observado ${subject}`, features: [`Rasgo visible ${i + 1}`], images: [{ id: i + 1, subject, data: pixels.toString('base64'), width: 120, height: 160, mime: 'image/png', sha256: hash(pixels), sourceURL: `https://example.test/object-${i}`, imageURL: `https://example.test/object-${i}.png`, observations: `Se observa el rasgo ${i + 1}`, use: 'Silueta e identidad', query: subject, provider: 'fixture' }], evidence: [{ completed: true }], attempts: [] })), evidence: [{ completed: true }] };
}
const reply = answer => ({ ok: true, ms: 2, stdout: JSON.stringify({ structured_output: answer }) });
function drawing(variation = 0, overrides = {}) {
  return { reply: 'Objetos interpretados', reference: { use: false }, operations: [], aruInto: 'Iconos', aru: ids.map((id, i) => `group ${id} { at ${24 + i % 2 * 384} ${24 + Math.floor(i / 2) * 384}; label "${labels[i]}"; path forma { move 80 80; line ${220 + variation + i} 90; curve 250 120 230 230 110 240; close; fill #2359B0 } }`).join('\n'), ...overrides };
}
function inspection(pass = true) { return { accept: true, purposeMatch: true, styleMatch: pass, anatomyMatch: true, smallLegibility: true, reason: pass ? 'Cumple la referencia' : 'Falta volumen del estilo', correction: pass ? '' : 'Reconstruye con volumen y distinta silueta', subjects: ids.map(id => ({ id, recognizable: true, anatomyMatch: true, observations: 'Se reconoce el rasgo observado' })) }; }

test('actual reference pixels reach independent generation, review and one fresh redraw with provenance', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aru-style-explore-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let drawings = 0, checks = 0;
  const canvases = [], generationRefs = [], reviewRefs = [], checkpoints = [];
  const result = await exploreIconStyles({ usage: 'illustrated', subjects: labels, styles: ['frutiger-fruits'], discovery: discovery(), outputDir: directory, checkpoint: snapshot => checkpoints.push(snapshot), transport: { run: async request => {
    if (request.system.includes('exploration artist')) {
      assert(!request.system.includes('outline by default'));
      assert.match(request.system, /reference.use MUST be false/);
      assert.match(request.prompt, /Rasgo visible 1/);
      assert.match(request.prompt, /Colores cítricos/);
      assert.equal(request.images.length, 3);
      canvases.push(request.images[0].data);
      generationRefs.push(request.images.slice(1).map(image => image.data));
      for (const image of request.images.slice(1)) {
        const raw = await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer();
        let red = 0; for (let i = 0; i < raw.length; i += 4) if (raw[i] > 230 && raw[i + 1] < 50 && raw[i + 2] < 50) red++;
        assert(red > 1000, 'the generation sees actual reference pixels, not metadata only');
      }
      if (drawings) assert.match(request.prompt, /Reconstruye con volumen/);
      return reply(drawing(drawings++ * 10));
    }
    checks++;
    assert.equal(request.images.length, 4);
    assert.equal(request.images[1].name, 'numbered_112px_and_24px');
    assert.match(request.prompt, /Rasgo visible 4/);
    reviewRefs.push(request.images.slice(2).map(image => image.data));
    return reply(inspection(checks > 1));
  } } });
  assert.equal(drawings, 2); assert.equal(checks, 2);
  assert.equal(canvases[0], canvases[1], 'a rejected draft is independently redrawn from a fresh blank canvas');
  assert.deepEqual(generationRefs[0], generationRefs[1]);
  assert.deepEqual(reviewRefs[0], reviewRefs[1]);
  assert.equal(result.complete, true);
  const style = result.styles[0];
  assert.equal(style.status, 'accepted'); assert.equal(style.quality.redraws, 1);
  assert.equal(style.quality.reviews[0].accept, false, 'the model cannot override a failed style check with accept:true');
  assert.equal(style.quality.selectedRound, 2);
  assert.match(await fs.readFile(style.attempts[0].file, 'utf8'), /line 220 90/);
  assert.match(await fs.readFile(style.attempts[1].file, 'utf8'), /line 230 90/);
  assert.deepEqual(readDocument(style.text).scene.root.children.map(node => node.name), ids);
  assert.equal(style.instruments.length, 4);
  assert.equal(style.generation.referenceAttachments[0].length, 2);
  assert.deepEqual(style.generation.referenceAttachments[0][0].sourceHashes, [hash(pixels), hash(pixels)]);
  for (const instrument of style.instruments) {
    assert.equal((await sharp(await fs.readFile(instrument.preview24)).metadata()).width, 24);
    const document = readDocument(await fs.readFile(instrument.aru, 'utf8')).scene;
    assert.equal(document.width, 336); assert.equal(document.height, 336);
    assert.equal(document.root.children[0].name, instrument.id);
    const raw = await sharp(await renderPng(instrument.text)).ensureAlpha().raw().toBuffer();
    for (let i = 3; i < raw.length; i += 4) assert.equal(raw[i], 255);
  }
  const saved = await fs.readFile(path.join(directory, 'report.json'), 'utf8');
  assert(!saved.includes(pixels.toString('base64')));
  assert.equal(JSON.parse(saved).subjects[0].references[0].query, labels[0]);
  assert(await fs.stat(JSON.parse(saved).subjects[0].references[0].file));
  assert(checkpoints.some(snapshot => snapshot.styles[0].status === 'pending'));
  assert.equal(checkpoints.at(-1).complete, true);
});

test('missing, corrupt or unobserved references fail before any generation instead of falling back to memory', async () => {
  for (const damage of ['missing', 'hash', 'observations', 'subject']) {
    const source = discovery();
    if (damage === 'missing') source.subjects[0].images = [];
    if (damage === 'hash') source.subjects[0].images[0].sha256 = '0'.repeat(64);
    if (damage === 'observations') source.subjects[0].images[0].observations = '';
    if (damage === 'subject') source.subjects.pop();
    let calls = 0;
    await assert.rejects(exploreIconStyles({ usage: 'illustrated', subjects: labels, styles: ['apple-minimal'], discovery: source, transport: { run: async () => { calls++; return reply(drawing()); } } }), /referencia|procedencia|Discovery/i);
    assert.equal(calls, 0);
  }
});

test('the exact subject inventory and reference.use=false are enforced, with bounded attempts and partial failures', async () => {
  const cases = [drawing(0, { reference: { use: true, image: 'ref1' } }), drawing(0, { aru: drawing().aru.replace('group maracas ', 'group guitarra_electrica ') }), drawing(0, { operations: [{ op: 'material', target: 'root', preset: 'fruits' }] })];
  for (const bad of cases) {
    let calls = 0;
    const result = await exploreIconStyles({ usage: 'illustrated', subjects: labels, styles: ['apple-minimal'], discovery: discovery(), transport: { run: async () => { calls++; return reply(bad); } } });
    assert.equal(calls, 2); assert.equal(result.complete, false); assert.equal(result.styles[0].status, 'failed');
    assert.equal(result.styles[0].instruments, undefined);
    assert.match(result.styles[0].error, /grupos|reference.use=false/);
  }
});

test('each style gets a blank session and identical geometry is not accepted as a new style', async () => {
  const canvases = [];
  const result = await exploreIconStyles({ usage: 'illustrated', subjects: labels, styles: ['material-3', 'funky-seasons'], discovery: discovery(), concurrency: 2, transport: { run: async request => {
    if (request.system.includes('exploration artist')) { canvases.push(request.images[0].data); return reply(drawing()); }
    return reply(inspection());
  } } });
  assert.equal(canvases.length, 2); assert.equal(canvases[0], canvases[1]);
  assert.equal(result.styles[0].status, 'accepted');
  assert.equal(result.styles[1].status, 'needs-review');
  assert.equal(result.styles[1].sameGeometryAs, 'material-3'); assert.equal(result.complete, false);
});

test('unbounded, background-only and invisible artwork cannot pass a positive model review', async () => {
  for (const content of ['circle cuerpo { at 9000 9000; radius 60; fill #222222 }', 'rect Fondo { at 168 168; size 336 336; fill #222222 }', 'group hidden_parent { hidden true; circle cuerpo { at 160 160; radius 60; fill #222222 } }', 'circle invisible { at 160 160; radius 50; fill none; stroke none }']) {
    const answer = drawing(0, { aru: `group guitarra_electrica { at 24 24; ${content} }` });
    let reviews = 0;
    const result = await exploreIconStyles({ usage: 'illustrated', subjects: [labels[0]], styles: ['apple-minimal'], discovery: { subjects: [discovery().subjects[0]] }, transport: { run: async request => {
      if (request.system.includes('exploration artist')) return reply(answer);
      reviews++; return reply({ ...inspection(), subjects: inspection().subjects.slice(0, 1) });
    } } });
    assert.equal(reviews, 0); assert.equal(result.styles[0].status, 'failed');
    assert.match(result.styles[0].error, /recortarían|visible/);
  }
});

test('overflow fit preserves relative pieces, curves, paint, gradient and fixed backgrounds in one wrapper', async () => {
  const original = 'canvas 768 384\nbackground #F4F2EB\ngradient chrome linear 90 { stop 0 #AABBCC; stop 1 #223344 }\ngroup guitar { at 24 24; rect Fondo { at 168 168; size 300 300; corner 40; fill #FFCCAA }; group instrument { rotate 28; circle body { at 900 900; radius 60; fill chrome; shadow 0 6 8 #112233 0.4 }; line neck { from 900 900; to 900 740; stroke #332211 12; cap round } } }\ngroup keyboard { at 408 24; rect body { at 168 168; size 250 140; fill chrome } }';
  const fitted = await fitExplorationArtwork(original), before = readDocument(original).scene, after = readDocument(fitted.text).scene;
  const stable = node => JSON.parse(JSON.stringify(node, (key, value) => ['id', 'path', 'line', 'layer', 'source'].includes(key) ? undefined : value));
  assert.equal(fitted.adjustments.length, 1); assert.equal(fitted.adjustments[0].id, 'guitar');
  assert.deepEqual(stable(before.root.children[1]), stable(after.root.children[1]), 'the object that already fits is unchanged');
  assert.deepEqual(stable(before.root.children[0].children[0]), stable(after.root.children[0].children[0]), 'the background stays fixed');
  assert.deepEqual(stable(before.root.children[0].children[1]), stable(after.root.children[0].children[1].children[0]), 'every original foreground piece is intact inside a single transform');
  assert.match(fitted.text, /gradient chrome linear 90/); assert.match(fitted.text, /fill chrome/);
  assert.equal(after.root.children[0].children[1].scale[0], after.root.children[0].children[1].scale[1]);
  assert(fitted.adjustments[0].toBounds.every(value => value >= 19 && value <= 317));
  assert.deepEqual((await fitExplorationArtwork(fitted.text)).adjustments, [], 'the fit is idempotent');
});

test('generated overflow is fitted before the actual image reviewer receives it', async () => {
  const source = drawing(0, { aru: 'group guitarra_electrica { at 24 24; circle cuerpo { at 900 900; radius 60; fill #222222 } }' });
  const result = await exploreIconStyles({ usage: 'illustrated', subjects: [labels[0]], styles: ['apple-minimal'], discovery: discovery(), transport: { run: async request => {
    if (request.system.includes('exploration artist')) return reply(source);
    const check = inspection(); check.subjects = check.subjects.slice(0, 1); return reply(check);
  } } });
  assert.equal(result.styles[0].status, 'accepted', result.styles[0].error);
  assert.equal(result.styles[0].generation.layoutAdjustments.length, 1);
  let calls = 0;
  await reviewIconExploration(result.styles[0].text, { usage: 'illustrated', subjects: [labels[0]], style: 'apple-minimal', discovery: discovery(), transport: { run: async request => { calls++; assert(!request.system.includes('exploration artist')); const check = inspection(); check.subjects = check.subjects.slice(0, 1); return reply(check); } } });
  assert.equal(calls, 1, 'reviewing a retained drawing never generates a replacement');
});

test('soft shadow spread is not mistaken for clipped foreground geometry', async () => {
  const result = await exploreIconStyles({ usage: 'illustrated', subjects: [labels[0]], styles: ['clay'], discovery: { subjects: [discovery().subjects[0]] }, review: 0, transport: { run: async () => reply(drawing(0, { aru: 'group guitarra_electrica { at 24 24; rect cuerpo { at 168 168; size 290 290; fill #335577; shadow 0 10 20 #112233 0.4 } }' })) } });
  assert.equal(result.styles[0].status, 'unreviewed'); assert.equal(result.styles[0].instruments.length, 1);
});

test('conservative rotated group bounds do not reject a shape that actually fits its cell', async () => {
  const aru = 'group guitarra_electrica { at 24 24; group instrumento { at 160 186; rotate 35; rect palo { at 0 -70; size 18 240; fill #112233 }; circle cuerpo { at 0 80; radius 55; fill #334455 } } }';
  const result = await exploreIconStyles({ usage: 'illustrated', subjects: [labels[0]], styles: ['apple-minimal'], discovery: { subjects: [discovery().subjects[0]] }, review: 0, transport: { run: async () => reply(drawing(0, { aru })) } });
  assert.equal(result.styles[0].status, 'unreviewed', result.styles[0].error);
});

test('review cannot accept duplicated assessments and retains valid drawings as pending instead of losing them', async () => {
  let generation = 0;
  const result = await exploreIconStyles({ usage: 'illustrated', subjects: labels, styles: ['material-3', 'apple-minimal'], discovery: discovery(), concurrency: 1, transport: { run: async request => {
    if (request.system.includes('exploration artist')) return reply(drawing(generation++));
    const check = inspection();
    if (request.prompt.includes('Apple minimalista')) check.subjects[3].id = check.subjects[0].id;
    return reply(check);
  } } });
  assert.equal(result.styles[0].status, 'accepted');
  assert.equal(result.styles[1].status, 'needs-review'); assert.match(result.styles[1].attempts[0].error, /Revisión sin verificar/);
  assert.equal(result.styles[1].instruments.length, 4); assert.equal(result.styles[1].quality.reviews.length, 0);
  assert.equal(result.complete, false);
});

test('partial subject improvements only break ties without masking a newly failed quality criterion', async () => {
  for (const regression of [false, true]) {
    let drawings = 0, checks = 0;
    const result = await exploreIconStyles({ usage: 'illustrated', subjects: labels, styles: ['apple-minimal'], discovery: discovery(), transport: { run: async request => {
      if (request.system.includes('exploration artist')) return reply(drawing(drawings++));
      const answer = inspection(); checks++;
      answer.subjects[0].recognizable = false;
      if (checks === 1) answer.subjects[1].recognizable = false;
      if (regression && checks === 2) answer.styleMatch = false;
      answer.correction = 'Mejora los sujetos que no se reconocen';
      return reply(answer);
    } } });
    assert.equal(result.styles[0].quality.selectedRound, regression ? 1 : 2);
    assert.deepEqual(result.styles[0].quality.reviews.map(r => r.recognized), [2, 3]);
  }
});

test('CLI exposes the exploration command and rejects unavailable references or ambiguous output options before research', () => {
  const help = spawnSync(process.execPath, ['bin/aru.mjs', 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(JSON.parse(help.stdout).commands['explore-icons'], /--subjects/);
  const missing = spawnSync(process.execPath, ['bin/aru.mjs', 'explore-icons', '--subjects', 'Guitarra'], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stdout + missing.stderr, /requiere --subjects, --styles y --out/);
  const suppliedImage = spawnSync(process.execPath, ['bin/aru.mjs', 'explore-icons', '--subjects', 'Guitarra', '--styles', 'apple-minimal', '--out', '/tmp/unused-explore-test', '--image', 'invented.png'], { encoding: 'utf8' });
  assert.equal(suppliedImage.status, 1); assert.match(suppliedImage.stdout + suppliedImage.stderr, /investiga sus propias referencias/);
  const wrongUsage = spawnSync(process.execPath, ['bin/aru.mjs', 'explore-icons', '--subjects', 'Guitarra', '--styles', 'apple-minimal', '--usage', 'launcher', '--out', '/tmp/unused-explore-usage-test'], { encoding: 'utf8' });
  assert.equal(wrongUsage.status, 1); assert.match(wrongUsage.stdout + wrongUsage.stderr, /usage debe ser ui-controls o illustrated/);
});

test('default UI controls export transparent vector-based 24/32/48 assets and opaque contextual proofs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aru-ui-controls-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let reviews = 0;
  const result = await exploreIconStyles({ subjects: labels, styles: ['material-3-expressive'], discovery: discovery(), outputDir: directory, transport: { run: async request => {
    // tools/agents-bridge.mjs validates every attachment before launching a provider.
    // This integration boundary caught the overlong UI proof name that mocks previously accepted.
    assert(request.images.length <= 4);
    for (const image of request.images) assert.match(image.name, /^[a-z0-9_-]{1,32}$/, `bridge attachment name: ${image.name}`);
    if (request.system.includes('exploration artist')) {
      assert.match(request.system, /USAGE CONTRACT: UI-CONTROLS/);
      assert.match(request.prompt, /locales 0\.\.48/);
      return reply(drawing(0, { aru: ids.map((id, i) => `group ${id} { at ${16 + i % 2 * 80} ${16 + Math.floor(i / 2) * 80}; path objeto { move 12 6; line ${34 + i} 8; line 40 39; line 9 42; close; fill #446699 }; circle hueco { at 24 25; radius 8; fill none; stroke #EEDDAA 3 } }`).join('\n') }));
    }
    reviews++;
    assert.equal(request.images[1].name, 'ui_controls_24_32_light_dark');
    assert.equal(request.images.length, 4); assert.match(request.prompt, /"usage":"ui-controls"/);
    const { data } = await sharp(Buffer.from(request.images[1].data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 3; i < data.length; i += 4) assert.equal(data[i], 255, 'the host context proof is opaque');
    return reply(inspection());
  } } });
  assert.equal(reviews, 1); assert.equal(result.complete, true); assert.equal(result.usage, 'ui-controls'); assert.equal(result.cellSize, 48);
  for (const instrument of result.styles[0].instruments) {
    const scene = readDocument(await fs.readFile(instrument.aru, 'utf8')).scene;
    assert.equal(scene.width, 48); assert.equal(scene.background, 'none');
    assert(!scene.root.children[0].children.some(node => node.name === 'Fondo'));
    for (const [file, size] of [[instrument.png, 48], [instrument.preview24, 24], [instrument.preview32, 32]]) {
      const { data, info } = await sharp(await fs.readFile(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, size); assert.equal(info.height, size);
      assert.equal(data[3], 0, 'the exterior is transparent');
      assert.equal(data[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3], 255, 'the foreground remains opaque');
    }
    assert.match(await fs.readFile(instrument.svg, 'utf8'), /<svg/);
  }
});

test('review transport failure retains the valid UI draft and never triggers another drawing', async () => {
  for (const failure of ['throw', 'provider-error']) {
    let draws = 0, reviews = 0;
    const progress = [];
    const result = await exploreIconStyles({ subjects: labels, styles: ['apple-minimal'], discovery: discovery(), progress: phase => progress.push(phase), transport: { run: async request => {
      if (request.system.includes('exploration artist')) {
        draws++;
        return reply(drawing(0, { aru: ids.map((id, i) => `group ${id} { at ${16 + i % 2 * 80} ${16 + Math.floor(i / 2) * 80}; rect body { at 24 24; size ${20 + i} 32; fill #446688 } }`).join('\n') }));
      }
      reviews++;
      if (failure === 'throw') throw new Error('invalid image');
      return { ok: false, stderr: 'review connection failed' };
    } } });
    assert.equal(draws, 1); assert.equal(reviews, 1);
    const style = result.styles[0];
    assert.equal(style.status, 'needs-review'); assert.equal(style.instruments.length, 4);
    assert.equal(style.quality.redraws, 0); assert.equal(style.attempts.length, 1);
    assert.match(style.quality.error, /invalid image|connection failed/);
    assert(!progress.includes('style-redraw'));
    assert.match(style.text, /guitarra_electrica/);
  }
});

test('UI controls reject personal backgrounds and translucent or blurred foreground without changing illustrated policy', async () => {
  for (const content of ['rect Fondo { at 24 24; size 40 40; fill #223344 }', 'rect body { at 24 24; size 30 30; fill #223344; opacity 0.5 }', 'rect body { at 24 24; size 30 30; fill #223344; shadow 0 2 4 #123456 0.5 }', 'rect body { at 24 24; size 30 30; fill #3698 }', 'rect body { at 24 24; size 30 30; fill transparent }']) {
    let calls = 0;
    const result = await exploreIconStyles({ subjects: [labels[0]], styles: ['clay'], discovery: discovery(), transport: { run: async request => {
      calls++; assert.match(request.system, /UI-CONTROLS/); return reply(drawing(0, { aru: `group guitarra_electrica { at 16 16; ${content} }` }));
    } } });
    assert.equal(calls, 2); assert.equal(result.styles[0].status, 'failed'); assert.match(result.styles[0].error, /controles UI/);
  }
  for (const stop of ['stop 0 #446699 0.4; stop 1 #334455 0.4', 'stop 0 #44669988; stop 1 #334F']) {
    const result = await exploreIconStyles({ subjects: [labels[0]], styles: ['frutiger-fruits'], discovery: discovery(), review: 0, transport: { run: async () => reply(drawing(0, { aru: `gradient translucent linear 90 { ${stop} }\ngroup guitarra_electrica { at 16 16; rect body { at 24 24; size 30 30; fill translucent } }` })) } });
    assert.equal(result.styles[0].status, 'failed'); assert.match(result.styles[0].error, /gradientes opacos/);
  }
});

test('UI export preserves an intentional interior hole while keeping the surrounding shape opaque', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aru-ui-hole-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = await exploreIconStyles({ subjects: [labels[0]], styles: ['apple-minimal'], discovery: discovery(), review: 0, outputDir: directory, transport: { run: async () => reply(drawing(0, { aru: 'group guitarra_electrica { at 16 16; path ring { move 6 6; line 42 6; line 42 42; line 6 42; close; move 18 18; line 18 30; line 30 30; line 30 18; close; fill #223344 } }' })) } });
  assert.equal(result.styles[0].status, 'unreviewed', result.styles[0].error);
  const { data } = await sharp(await fs.readFile(result.styles[0].instruments[0].png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = (x, y) => data[(y * 48 + x) * 4 + 3];
  assert.equal(alpha(0, 0), 0); assert.equal(alpha(24, 24), 0); assert.equal(alpha(10, 24), 255);
});

test('MusicArt is an explicit outline family while tonal styles retain independent construction', async () => {
  const {resolveStyle} = await import('../plugin/styles.js');
  assert.equal(resolveStyle('MusicArt').id,'outline-rounded');
  let requests=0;
  const result = await exploreIconStyles({subjects:[labels[0]],styles:['MusicArt'],discovery:discovery(),review:1,transport:{run:async request=>{
    requests++;
    if (!request.system.includes('exploration artist')) {
      const {data,info}=await sharp(Buffer.from(request.images[1].data,'base64')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      let lightInk=0,darkInk=0;
      for(let p=0;p<data.length;p+=4){const y=Math.floor(p/4/info.width);if(y<132&&data[p]===47&&data[p+1]===81&&data[p+2]===72)lightInk++;if(y>=132&&y<200&&data[p]===191&&data[p+1]===214&&data[p+2]===196)darkInk++;}
      assert(lightInk>20,'light context contains actual dark-green glyphs');
      assert(darkInk>20,'dark context contains the identical vector tinted by the host');
      const check=inspection();check.subjects=check.subjects.slice(0,1);return reply(check);
    }
    assert.match(request.system,/BINDING OUTLINE-ROUNDED FAMILY/);
    assert.match(request.system,/fill none and stroke #2F5148 2.4/);
    assert.match(request.system,/identical weight and paint in every batch/);
    return reply(drawing(0,{aru:'group guitarra_electrica { at 16 16; path cuerpo { move 10 18; curve 4 32 10 42 24 42; curve 38 42 44 32 38 18; fill none; stroke #2F5148 2.4; cap round; join round }; line mastil { from 24 7; to 24 26; stroke #2F5148 2.4; cap round } }'}));
  }}});
  assert.equal(requests,2);
  assert.equal(result.styles[0].instruments.length,1);
  assert.equal(result.styles[0].profile.id,'outline-rounded');
});
