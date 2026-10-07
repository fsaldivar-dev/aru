import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/engine.js';
import { findPack, applyPackLevers, applyRedraw, packFragment, inspectPack } from '../trace/iconpack.js';

const aru = `canvas 200 60
background none
group pack {
    label "Pack"
    group home { at 0 0; label "Inicio"; path roof { move 3 11; line 12 4; line 21 11; fill none; stroke #2F5148 1 } }
    group search { at 40 0; label "Buscar"; circle lens { at 10 10; radius 7; fill none; stroke #2F5148 3 } }
    group user { at 80 0; label "Perfil"; circle head { at 12 8; radius 5; fill none; stroke #2F5148 2 } }
}
`;

test('illustrations with many semantic parts are not processed as 24px icon packs', () => {
  const illustration = aru.replace('group pack', 'group wolf').replace('label "Pack"', 'label "Lobo"; semantic character');
  const scene = compile(illustration).scene;
  assert.equal(findPack(scene), null);
  assert.equal(findPack(compile(illustration.replace('semantic character', 'semantic ui.iconpack')).scene).name, 'wolf');
});

test('findPack + levers unify stroke width, caps and colour without touching the input', () => {
  const scene = compile(aru).scene, pack = findPack(scene);
  assert.equal(pack.name, 'pack');
  const out = applyPackLevers(scene, { strokeWidth: 2, caps: 'round', color: '#C8643A' });
  const widths = [], caps = [], colors = [];
  const walk = (n) => { for (const c of n.children || []) { if (c.type !== 'group') { widths.push(c.strokeWidth); caps.push(c.cap); colors.push(c.stroke); } walk(c); } };
  walk(findPack(out));
  assert.deepEqual([...new Set(widths)], [2]); assert.deepEqual([...new Set(caps)], ['round']); assert.deepEqual([...new Set(colors)], ['#C8643A']);
  assert.equal(findPack(scene).children[0].children[0].strokeWidth, 1, 'input untouched');
});

test('redraw replaces one icon; the fragment recompiles without canvas lines', () => {
  const scene = compile(aru).scene;
  const r = applyRedraw(scene, 'search', 'circle lens { at 10 10; radius 6; fill none; stroke #2F5148 2 }\nline handle { from 14.5 14.5; to 20 20; stroke #2F5148 2; cap round }');
  assert.equal(r.ok, true);
  assert.equal(findPack(r.scene).children.find((c) => c.name === 'search').children.length, 2);
  assert.equal(applyRedraw(scene, 'nope', 'circle c { at 1 1; radius 1 }').ok, false);
  const frag = packFragment(r.scene);
  assert.ok(!/^canvas /m.test(frag));
  assert.equal(compile(`canvas 200 60\nbackground none\n${frag}`).errors.length, 0);
});

test('inspectPack flags an empty icon and a duplicate (mock raster from the cell geometry)', async () => {
  const dup = aru.replace('group user { at 80 0; label "Perfil"; circle head { at 12 8; radius 5; fill none; stroke #2F5148 2 } }', 'group user { at 80 0; label "Perfil" }\n    group search2 { at 120 0; label "Lupa"; circle lens { at 10 10; radius 7; fill none; stroke #2F5148 3 } }');
  const scene = compile(dup).scene;
  // mock: draw circles/lines of the cell as filled discs/boxes on white
  const rasterize = async (sc, W, H) => {
    const d = new Uint8ClampedArray(W * H * 4).fill(255), k = W / 24;
    const walk = (n, ox, oy) => { for (const c of n.children || []) { const x = ox + c.at[0], y = oy + c.at[1]; if (c.type === 'group') walk(c, x, y); else if (c.type === 'circle') { for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) if (Math.abs(Math.hypot(px / k - x, py / k - y) - c.geom.radius) < 1) d.set([0, 0, 0, 255], (py * W + px) * 4); } else if (c.type === 'path') { for (let px = 3 * k; px < 21 * k; px++) for (let py = 9 * k; py < 11 * k; py++) d.set([0, 0, 0, 255], (py * W + px) * 4); } } };
    walk(sc.root, 0, 0);
    return { width: W, height: H, data: d };
  };
  const ins = await inspectPack(scene, findPack(scene), rasterize);
  const by = Object.fromEntries(ins.icons.map((i) => [i.name, i.issues.join('; ')]));
  assert.match(by.user, /vacío/);
  assert.match(by.search2, /repite la silueta/);
  assert.equal(ins.duplicates.length, 1);
});

test('lintIcon explains silent ARU mistakes; repair fixes them', async () => {
  const { lintIcon } = await import('../trace/iconpack.js');
  const bad = `canvas 100 40
background none
group pack {
    group a { at 0 0; circle lens { at 10 10; radius 6; stroke #2F5148 2 } }
    group b { at 30 0; circle head { at 12 8; radius 3; fill none }; path body { move 5 20 6 15 9 13 12 13 } }
    group c { at 60 0; line l { from 2 2; to 20 20; stroke #2F5148 2 } }
}
`;
  const scene = compile(bad).scene, pack = findPack(scene);
  const kinds = (name) => lintIcon(pack.children.find((c) => c.name === name)).map((l) => l.kind).sort();
  assert.deepEqual(kinds('a'), ['defaultFill']);
  assert.deepEqual(kinds('b'), ['args', 'invisible']);
  assert.deepEqual(kinds('c'), []);
  const fixed = findPack(applyPackLevers(scene, { repair: true }));
  for (const icon of fixed.children) assert.deepEqual(lintIcon(icon), [], icon.name);
  const body = fixed.children.find((c) => c.name === 'b').children.find((c) => c.name === 'body');
  assert.deepEqual(body.geom.commands.map((c) => c.cmd), ['move', 'line', 'line', 'line']);
});
