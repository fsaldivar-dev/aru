// Deterministic score of a vector result against its source image (both RGBA, any size; compared at ≤ maxSide).
// This is the referee of the auto-tune and of the AI review: models PROPOSE parameters, the score DECIDES, so any
// provider (Claude, Codex, Gemini, Antigravity) ends at the same result or better, never worse.
//
//   lineRecall    ridge pixels of the source (thin dark lines) that are still dark in the render
//   linePrecision ridge pixels of the render that are dark in the source (no invented lines)
//   within30      pixels whose RGB channels all differ by ≤ 30
//   dE            mean CIELAB ΔE
//   score         0.35·lineRecall + 0.15·linePrecision + 0.30·within30 + 0.20·max(0, 1 − dE/25)
import { labImage } from './quantize.js';
import { normalizeImage } from './image.js';

// ridge = darker than BOTH sides across some direction (offset 1 or 2 px) by ≥ minContrast, and not light itself
export function ridgeMask(lab, W, H, { minContrast = 25, maxL = 60 } = {}) {
  const L = (x, y) => lab[(Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 3];
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = L(x, y); if (v >= maxL) continue;
    search: for (const [nx, ny] of [[1, 0], [0, 1], [1, 1], [1, -1]]) for (const o of [1, 2]) {
      if (L(x + nx * o, y + ny * o) - v >= minContrast && L(x - nx * o, y - ny * o) - v >= minContrast) { m[y * W + x] = 1; break search; }
    }
  }
  return m;
}

export function scoreRender(source, render, { maxSide = 600 } = {}) {
  const a = normalizeImage(source, { maxSide });
  const b = normalizeImage(render, { maxSide: Math.max(a.width, a.height) });
  if (a.width !== b.width || a.height !== b.height) throw new Error(`score: size mismatch ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  const W = a.width, H = a.height, N = W * H, la = labImage(a), lb = labImage(b);
  const ra = ridgeMask(la, W, H), rb = ridgeMask(lb, W, H);
  let w30 = 0, de = 0, rO = 0, rHit = 0, pO = 0, pHit = 0;
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    if (Math.abs(a.data[p] - b.data[p]) <= 30 && Math.abs(a.data[p + 1] - b.data[p + 1]) <= 30 && Math.abs(a.data[p + 2] - b.data[p + 2]) <= 30) w30++;
    de += Math.hypot(la[i * 3] - lb[i * 3], la[i * 3 + 1] - lb[i * 3 + 1], la[i * 3 + 2] - lb[i * 3 + 2]);
    if (ra[i]) { rO++; if (lb[i * 3] < la[i * 3] + 20) rHit++; }
    if (rb[i]) { pO++; if (la[i * 3] < lb[i * 3] + 20) pHit++; }
  }
  const lineRecall = rO ? rHit / rO : 1, linePrecision = pO ? pHit / pO : 1, within30 = w30 / N, dE = de / N;
  const score = 0.35 * lineRecall + 0.15 * linePrecision + 0.3 * within30 + 0.2 * Math.max(0, 1 - dE / 25);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { score: r3(score), lineRecall: r3(lineRecall), linePrecision: r3(linePrecision), within30: r3(within30), dE: Math.round(dE * 100) / 100 };
}
