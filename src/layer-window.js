// Fixed-height rows keep the DOM bounded while retaining the full logical tree for range selection.
export const LAYER_ROW_HEIGHT = 31;
export function layerWindow(count, scrollTop, height, overscan = 8) {
  const start = Math.min(Math.max(0, count - 1), Math.max(0, Math.floor(scrollTop / LAYER_ROW_HEIGHT) - overscan));
  const end = Math.min(count, start + Math.ceil(Math.max(0, height) / LAYER_ROW_HEIGHT) + 2 * overscan);
  return { start, end, before: start * LAYER_ROW_HEIGHT, after: (count - end) * LAYER_ROW_HEIGHT };
}
