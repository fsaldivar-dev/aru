// Thin feature detection (whiskers, 1–3 px strokes, cracks, bird silhouettes): protected BEFORE region merging.
//
//   pixel test (4 orientations, half-widths 1 and 2): the pixel differs strongly from BOTH sides across the line
//   (beyond the stroke), the two sides look alike, and the pixels along the line look like the pixel itself:
//      R = min(ΔE(p, side1), ΔE(p, side2)) − 0.5·ΔE(side1, side2)  >= 20   and   ΔE(p, p ± along) <= 14
//   component test (8-connected): meaningful length (>= 10 px), small width (area / length <= 3.5), elongated
//
// High contrast + high aspect ratio + small width + meaningful length. Being small alone protects nothing.
export function detectThin(img, lab, { minResponse = 20, alongDE = 14, minLength = 10, maxWidth = 3.5 } = {}) {
  const W = img.width, H = img.height, N = W * H;
  const de = (i, j) => Math.hypot(lab[i * 3] - lab[j * 3], lab[i * 3 + 1] - lab[j * 3 + 1], lab[i * 3 + 2] - lab[j * 3 + 2]);
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]; // along-line directions; the normal is perpendicular
  const cand = new Uint8Array(N);
  for (let y = 3; y < H - 3; y++) for (let x = 3; x < W - 3; x++) {
    const i = y * W + x;
    for (const [ax, ay] of dirs) {
      const nx = -ay, ny = ax;
      let hit = false;
      for (const off of [2, 3]) { // sides sampled just beyond a stroke of half-width 1 or 2
        const a = (y + ny * off) * W + (x + nx * off), b = (y - ny * off) * W + (x - nx * off);
        const R = Math.min(de(i, a), de(i, b)) - 0.5 * de(a, b);
        if (R < minResponse) continue;
        const f = (y + ay) * W + (x + ax), g = (y - ay) * W + (x - ax);
        if (de(i, f) <= alongDE && de(i, g) <= alongDE) { hit = true; break; }
      }
      if (hit) { cand[i] = 1; break; }
    }
  }
  // components
  const mask = new Uint8Array(N), seen = new Uint8Array(N), comps = [];
  for (let s = 0; s < N; s++) {
    if (!cand[s] || seen[s]) continue;
    const px = [s]; seen[s] = 1;
    for (let k = 0; k < px.length; k++) {
      const i = px[k], x = i % W, y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx; if (cand[j] && !seen[j]) { seen[j] = 1; px.push(j); }
      }
    }
    // length = extent along the principal axis
    let mx = 0, my = 0; for (const i of px) { mx += i % W; my += Math.floor(i / W); } mx /= px.length; my /= px.length;
    let sxx = 0, syy = 0, sxy = 0; for (const i of px) { const dx = (i % W) - mx, dy = Math.floor(i / W) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(th), sn = Math.sin(th);
    let lo = Infinity, hi = -Infinity; for (const i of px) { const t = ((i % W) - mx) * c + (Math.floor(i / W) - my) * sn; lo = Math.min(lo, t); hi = Math.max(hi, t); }
    const length = hi - lo + 1, width = px.length / length;
    if (length >= minLength && width <= maxWidth) { for (const i of px) mask[i] = 1; comps.push({ pixels: px.length, length: +length.toFixed(1), width: +width.toFixed(2) }); }
  }
  return { mask, components: comps, pixels: comps.reduce((a, c) => a + c.pixels, 0) };
}
