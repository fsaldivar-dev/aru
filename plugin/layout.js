const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
export function freeTranslation(b, others, { width, height }, gap = 48) {
  const w = b[2] - b[0], h = b[3] - b[1], area = Math.max(1, w * h);
  if (!others.some(o => overlap(b, o) > .01 * area)) return [0, 0];
  const free = (x, y) => !others.some(o => overlap([x, y, x + w, y + h], [o[0] - gap / 2, o[1] - gap / 2, o[2] + gap / 2, o[3] + gap / 2]) > 0);
  let spot; const step = Math.max(16, Math.round(Math.min(w, h) / 3));
  for (let y = gap / 2; !spot && y + h <= height - gap / 2; y += step) for (let x = gap / 2; x + w <= width - gap / 2; x += step) if (free(x, y)) { spot = [x, y]; break; }
  if (!spot) {
    const U = others.reduce((u, o) => [Math.min(u[0], o[0]), Math.min(u[1], o[1]), Math.max(u[2], o[2]), Math.max(u[3], o[3])]);
    const right = [U[2] + gap, Math.max(gap / 2, U[1])], below = [Math.max(gap / 2, U[0]), U[3] + gap];
    const grow = ([x, y]) => Math.max(width, x + w + gap) * Math.max(height, y + h + gap) - width * height;
    spot = grow(right) <= grow(below) ? right : below;
  }
  return [Math.round(spot[0] - b[0]), Math.round(spot[1] - b[1])];
}
