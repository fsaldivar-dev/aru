// Edge-preserving pre-filter (bilateral, 5x5, range kernel in Lab ΔE) used only for the regularized trace.
// Smooths JPEG blocks / anti-aliasing noise (low contrast) while keeping real edges (high contrast).
// Quantization sees the filtered image; colors and fidelity are still measured on the original.
export function bilateral(img, lab, { sigmaS = 1.6, sigmaR = 8, radius = 2 } = {}) {
  const { width: W, height: H } = img, out = new Uint8ClampedArray(img.data.length);
  const ws = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) ws.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS))]);
  const inv2r = 1 / (2 * sigmaR * sigmaR);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
    let r = 0, g = 0, b = 0, wsum = 0;
    for (const [dx, dy, w0] of ws) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx, d0 = lab[j * 3] - L, d1 = lab[j * 3 + 1] - A, d2 = lab[j * 3 + 2] - B;
      const w = w0 * Math.exp(-(d0 * d0 + d1 * d1 + d2 * d2) * inv2r);
      r += img.data[j * 4] * w; g += img.data[j * 4 + 1] * w; b += img.data[j * 4 + 2] * w; wsum += w;
    }
    out[i * 4] = r / wsum; out[i * 4 + 1] = g / wsum; out[i * 4 + 2] = b / wsum; out[i * 4 + 3] = 255;
  }
  return { ...img, data: out };
}
