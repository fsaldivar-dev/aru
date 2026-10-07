// Crop of a reference to ONE subject (the wolf of a logo, without its divider bar and wordmark).
// The AI's box is approximate: a tight box cuts a snout or an ear tip flat, a padded box drags in neighbours.
// On a plain backdrop the subject is measured instead:
//   1. backdrop = dominant colour of the image border (must cover ≥ 60 % of the border, else the box is used as is)
//   2. foreground = pixels away from the backdrop (max RGB channel difference > 40), 8-connected components inside a
//      window = the box grown by 25 %
//   3. the subject = the largest component touching the box + components within ~1 % of the diagonal of it
//      (detached details) unless it is a straight solid rule (a divider bar or underline), even inside the box
//   4. crop = bounding box of the subject + 2 px; everything else inside it is painted with the backdrop colour
// Deterministic. Returns { raw, box (normalized, final), refined, removed }.
import { rgbToLab } from './quantize.js';
import { labToRgb } from './rag.js';

export function cropToSubject(raw, box, opts = {}) {
  // the search window grows while the subject touches its edge (a very tight box must not cut the neck)
  let grow = opts.grow ?? 0.25, r;
  for (let k = 0; k < 4; k++, grow *= 2) { r = cropOnce(raw, box, { ...opts, grow }); if (!r.touchesWindow) break; }
  delete r.touchesWindow;
  return r;
}
function cropOnce(raw, box, { grow = 0.25, tol = 40 } = {}) {
  const W = raw.width, H = raw.height, d = raw.data;
  const px = (v, n) => Math.max(0, Math.min(n, Math.round(v * n)));
  let x0 = px(box.x, W), y0 = px(box.y, H), x1 = px(box.x + box.w, W), y1 = px(box.y + box.h, H);
  const plain = (cx0, cy0, cx1, cy1) => slice(raw, cx0, cy0, cx1, cy1);
  // 1. backdrop from the border of the whole image (alpha composited over white)
  const rgb = (i) => { const a = d[i * 4 + 3] / 255; return [d[i * 4] * a + 255 * (1 - a), d[i * 4 + 1] * a + 255 * (1 - a), d[i * 4 + 2] * a + 255 * (1 - a)]; };
  const border = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) border.push(y * W, y * W + W - 1);
  const hist = new Map();
  for (const i of border) { const c = rgb(i).map((v) => Math.round(v / 16)); const k = c.join(','); hist.set(k, (hist.get(k) || 0) + 1); }
  const [topKey, topN] = [...hist].sort((a, b) => b[1] - a[1])[0];
  if (topN < 0.6 * border.length) return { raw: plain(x0, y0, x1, y1), box, refined: false, removed: 0 };
  const q = topKey.split(',').map(Number), bg = [0, 0, 0]; let nb = 0;
  for (const i of border) { const c = rgb(i); if (c.every((v, k) => Math.round(v / 16) === q[k])) { bg[0] += c[0]; bg[1] += c[1]; bg[2] += c[2]; nb++; } }
  for (let k = 0; k < 3; k++) bg[k] /= nb;
  const isFg = (i) => { const c = rgb(i); return Math.max(Math.abs(c[0] - bg[0]), Math.abs(c[1] - bg[1]), Math.abs(c[2] - bg[2])) > tol; };
  // 2. components inside the grown window
  const gx = Math.round((x1 - x0) * grow), gy = Math.round((y1 - y0) * grow);
  const wx0 = Math.max(0, x0 - gx), wy0 = Math.max(0, y0 - gy), wx1 = Math.min(W, x1 + gx), wy1 = Math.min(H, y1 + gy);
  const ww = wx1 - wx0, wh = wy1 - wy0, lab = new Int32Array(ww * wh).fill(-1), comps = [];
  // straight rules (divider bars, underlines): a vertical/horizontal strip ≤ 5 px wide with backdrop on both sides
  // for a long run is layout, even where it touches the subject: those pixels are treated as backdrop
  const fgW = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) fgW[y * ww + x] = isFg((wy0 + y) * W + wx0 + x) ? 1 : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= ww || y >= wh ? 0 : fgW[y * ww + x]);
  const rule = new Uint8Array(ww * wh), minRun = Math.max(20, Math.round(0.08 * Math.max(ww, wh)));
  const strip = (along, across, len, get, mark) => {
    for (let a = 0; a < across; a++) {
      let start = -1;
      for (let t = 0; t <= len; t++) {
        const ok = t < len && get(a, t, 0) && !get(a - 3, t, 1) && !get(a + 3, t, 1);
        if (ok && start < 0) start = t;
        if (!ok && start >= 0) { if (t - start >= minRun) for (let u = start; u < t; u++) for (let o = -2; o <= 2; o++) mark(a + o, u); start = -1; }
      }
    }
  };
  const vCols = new Set(), hRows = new Set();
  strip('y', ww, wh, (x, y) => at(x, y), (x, y) => { if (x >= 0 && x < ww) { rule[y * ww + x] = 1; vCols.add(x); } });
  strip('x', wh, ww, (y, x) => at(x, y), (y, x) => { if (y >= 0 && y < wh) { rule[y * ww + x] = 1; hRows.add(y); } });
  // the same rule continues where it passes next to the subject (backdrop on ONE side only): follow its line
  const follow = (lines, len, get, mark) => {
    for (const a of lines) {
      let start = -1, oneSide = 0;
      for (let t = 0; t <= len; t++) {
        const on = t < len && get(a, t, 0);
        if (on && start < 0) { start = t; oneSide = 0; }
        if (on && (!get(a - 3, t, 1) || !get(a + 3, t, 1))) oneSide++;
        if (!on && start >= 0) { if (t - start >= 10 && oneSide >= 0.8 * (t - start)) for (let u = start; u < t; u++) for (let o = -2; o <= 2; o++) mark(a + o, u); start = -1; }
      }
    }
  };
  follow([...vCols], wh, (x, y) => at(x, y), (x, y) => { if (x >= 0 && x < ww) rule[y * ww + x] = 1; });
  follow([...hRows], ww, (y, x) => at(x, y), (y, x) => { if (y >= 0 && y < wh) rule[y * ww + x] = 1; });
  const fgAt = (s) => fgW[s] && !rule[s];
  for (let sy = 0; sy < wh; sy++) for (let sx = 0; sx < ww; sx++) {
    const s = sy * ww + sx; if (lab[s] >= 0 || !fgAt(s)) continue;
    const c = { n: 0, inside: 0, bx0: Infinity, by0: Infinity, bx1: -1, by1: -1 }, st = [s]; lab[s] = comps.length;
    while (st.length) {
      const t = st.pop(), tx = t % ww, ty = (t / ww) | 0, X = wx0 + tx, Y = wy0 + ty;
      c.n++; if (X >= x0 && X < x1 && Y >= y0 && Y < y1) c.inside++;
      if (X < c.bx0) c.bx0 = X; if (Y < c.by0) c.by0 = Y; if (X > c.bx1) c.bx1 = X; if (Y > c.by1) c.by1 = Y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const ux = tx + dx, uy = ty + dy; if (ux < 0 || uy < 0 || ux >= ww || uy >= wh) continue;
        const u = uy * ww + ux; if (lab[u] < 0 && fgAt(u)) { lab[u] = comps.length; st.push(u); }
      }
    }
    comps.push(c);
  }
  // 3. the subject: the largest component that touches the box, plus every component within `gap` px of it
  //    (a detached tuft or an eye dot); a divider bar beside it, separated by a clear gap, is not part of it
  const touching = comps.map((c, k) => k).filter((k) => comps[k].inside > 0);
  if (!touching.length) return { raw: plain(x0, y0, x1, y1), box, refined: false, removed: 0 };
  const main = touching.sort((a, b) => comps[b].n - comps[a].n)[0];
  const gap = Math.max(3, Math.round(0.01 * Math.hypot(W, H)));
  // a straight solid rule (divider bar, underline: ≥ 6:1 and ≥ 60 % of its box filled) is layout, never a detail
  const isRule = (c) => { const bw = c.bx1 - c.bx0 + 1, bh = c.by1 - c.by0 + 1; return Math.max(bw, bh) >= 6 * Math.min(bw, bh) && c.n >= 0.6 * bw * bh; };
  const keep = comps.map((_, k) => k === main);
  for (let changed = true; changed;) {
    changed = false;
    const dist = new Int16Array(ww * wh).fill(-1), qu = [];
    for (let s = 0; s < ww * wh; s++) if (lab[s] >= 0 && keep[lab[s]]) { dist[s] = 0; qu.push(s); }
    for (let h = 0; h < qu.length; h++) {
      const t = qu[h], tx = t % ww, ty = (t / ww) | 0;
      if (dist[t] >= gap) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const ux = tx + dx, uy = ty + dy; if (ux < 0 || uy < 0 || ux >= ww || uy >= wh) continue;
        const u = uy * ww + ux; if (dist[u] >= 0) continue;
        if (lab[u] >= 0 && !keep[lab[u]] && comps[lab[u]].n >= 2 && !isRule(comps[lab[u]])) { keep[lab[u]] = true; changed = true; }
        dist[u] = dist[t] + 1; qu.push(u);
      }
    }
  }
  const kept = comps.filter((_, k) => keep[k]);
  // 4. tight crop around it (+2 px), other foreground painted with the backdrop
  const cx0 = Math.max(0, Math.min(...kept.map((c) => c.bx0)) - 2), cy0 = Math.max(0, Math.min(...kept.map((c) => c.by0)) - 2);
  const cx1 = Math.min(W, Math.max(...kept.map((c) => c.bx1)) + 3), cy1 = Math.min(H, Math.max(...kept.map((c) => c.by1)) + 3);
  const out = plain(cx0, cy0, cx1, cy1);
  // removed components AND their 2 px anti-aliasing halo (pixels that are not part of the subject) become backdrop
  const owner = (x, y) => (x >= wx0 && x < wx1 && y >= wy0 && y < wy1 ? lab[(y - wy0) * ww + (x - wx0)] : -1);
  let removed = 0;
  for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) {
    const l = owner(x, y); if (l >= 0 && keep[l]) continue;
    const inW = x >= wx0 && x < wx1 && y >= wy0 && y < wy1;
    let hit = l >= 0 || (inW && rule[(y - wy0) * ww + (x - wx0)] === 1);
    for (let dy = -2; dy <= 2 && !hit; dy++) for (let dx = -2; dx <= 2 && !hit; dx++) { const m = owner(x + dx, y + dy); if (m >= 0 && !keep[m]) hit = true; }
    if (!hit) continue;
    // a halo pixel next to the subject stays (it is the subject's own anti-aliased edge)
    if (l < 0) { let nearSubject = false; for (let dy = -1; dy <= 1 && !nearSubject; dy++) for (let dx = -1; dx <= 1 && !nearSubject; dx++) { const m = owner(x + dx, y + dy); if (m >= 0 && keep[m]) nearSubject = true; } if (nearSubject) continue; }
    const o = ((y - cy0) * out.width + (x - cx0)) * 4; out.data[o] = bg[0]; out.data[o + 1] = bg[1]; out.data[o + 2] = bg[2]; out.data[o + 3] = 255; removed++;
  }
  const bx0 = Math.min(...kept.map((c) => c.bx0)), by0 = Math.min(...kept.map((c) => c.by0)), bx1 = Math.max(...kept.map((c) => c.bx1)), by1 = Math.max(...kept.map((c) => c.by1));
  const touchesWindow = (bx0 <= wx0 && wx0 > 0) || (by0 <= wy0 && wy0 > 0) || (bx1 >= wx1 - 1 && wx1 < W) || (by1 >= wy1 - 1 && wy1 < H);
  return { raw: out, box: { x: cx0 / W, y: cy0 / H, w: (cx1 - cx0) / W, h: (cy1 - cy0) / H }, refined: true, removed, touchesWindow };
}

function slice(raw, x0, y0, x1, y1) {
  const W = Math.max(1, x1 - x0), H = Math.max(1, y1 - y0), data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) data.set(raw.data.subarray(((y0 + y) * raw.width + x0) * 4, ((y0 + y) * raw.width + x0 + W) * 4), y * W * 4);
  return { width: W, height: H, data };
}

// backdrop colour that contrasts with the subject's outline: if the base is within ΔE 18 of any outline/ink colour,
// its lightness moves away (towards white or black, whichever is farther) until ΔE ≥ 25 — hue kept
export function contrastBackdrop(hex, outlineHexes) {
  const lab = (h) => rgbToLab(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));
  const toHex = (L) => '#' + labToRgb(L).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const outs = outlineHexes.filter((h) => /^#[0-9a-f]{6}$/i.test(h)).map(lab), base = lab(hex);
  const dist = (L) => Math.min(Infinity, ...outs.map((c) => Math.hypot(L[0] - c[0], L[1] - c[1], L[2] - c[2])));
  if (dist(base) >= 18) return hex;
  const dir = base[0] < 50 ? 1 : -1;
  for (let s = 4; s <= 80; s += 4) { const L = [Math.max(0, Math.min(100, base[0] + dir * s)), base[1], base[2]]; if (dist(L) >= 25) return toHex(L); }
  return dir > 0 ? '#F3EFE8' : '#1E1E24';
}
