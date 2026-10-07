// Multi-scale persistence: re-quantize the image at 75% and 50% with the SAME palette and check whether a small
// region's color still appears where the region was. Structural details (pupils, highlights) survive downscaling;
// anti-aliasing slivers and compression specks usually do not. Score = fraction of scales where it persists.
import { normalizeImage } from './image.js';
import { labImage, nearestCentroid } from './quantize.js';

export function persistenceModel(img, labelLab, scales = [0.75, 0.5]) {
  const levels = scales.map((s) => {
    const small = normalizeImage(img, { maxSide: Math.max(8, Math.round(Math.max(img.width, img.height) * s)) });
    const lab = labImage(small), labels = new Uint16Array(small.width * small.height);
    for (let i = 0; i < labels.length; i++) labels[i] = nearestCentroid(lab, i, labelLab);
    return { s: small.width / img.width, W: small.width, H: small.height, labels };
  });
  return {
    // share of the region's pixels whose position still carries the region's color at each coarser scale
    score(c, label, W) {
      let total = 0;
      for (const L of levels) {
        let same = 0;
        for (const p of c.pixels) {
          const x = p % W, y = (p - x) / W;
          const sx = Math.min(L.W - 1, Math.floor((x + 0.5) * L.s)), sy = Math.min(L.H - 1, Math.floor((y + 0.5) * L.s));
          if (L.labels[sy * L.W + sx] === label) same++;
        }
        total += Math.min(1, (same / c.pixels.length) / 0.5); // half the pixels persisting counts as fully persistent
      }
      return total / levels.length;
    },
  };
}
