// ARU animations: a closed set of presets, declared per node and rendered as CSS inside the SVG
// (plays in any browser, survives export). Syntax:
//   animate <preset> [duration s] [delay s] [once|loop|alternate|<count>] [ease|linear|ease-in|ease-out|ease-in-out|spring]
//   group logo { animate pop 0.6 0.2 once ease-out ... }
// The node is wrapped in <g class="aru-a-N"> whose transform origin is its own bounding box centre, so the
// animation composes with the node's own transform attribute.
export const PRESETS = {
  'fade-in': '0%{opacity:0}100%{opacity:1}',
  'fade-out': '0%{opacity:1}100%{opacity:0}',
  'slide-up': '0%{opacity:0;transform:translateY(24px)}100%{opacity:1;transform:none}',
  'slide-down': '0%{opacity:0;transform:translateY(-24px)}100%{opacity:1;transform:none}',
  'slide-left': '0%{opacity:0;transform:translateX(24px)}100%{opacity:1;transform:none}',
  'slide-right': '0%{opacity:0;transform:translateX(-24px)}100%{opacity:1;transform:none}',
  'scale-in': '0%{opacity:0;transform:scale(.6)}100%{opacity:1;transform:none}',
  pop: '0%{opacity:0;transform:scale(.4)}70%{opacity:1;transform:scale(1.08)}100%{transform:none}',
  pulse: '0%,100%{transform:none}50%{transform:scale(1.06)}',
  spin: '0%{transform:rotate(0)}100%{transform:rotate(360deg)}',
  float: '0%,100%{transform:none}50%{transform:translateY(-8px)}',
  wiggle: '0%,100%{transform:rotate(0)}25%{transform:rotate(-6deg)}75%{transform:rotate(6deg)}',
  blink: '0%,100%{opacity:1}50%{opacity:.2}',
  draw: '0%{stroke-dashoffset:var(--aru-len,1200)}100%{stroke-dashoffset:0}',
};
export const PRESET_NAMES = Object.keys(PRESETS);
export const EASES = { ease: 'ease', linear: 'linear', 'ease-in': 'ease-in', 'ease-out': 'ease-out', 'ease-in-out': 'ease-in-out', spring: 'cubic-bezier(.34,1.56,.64,1)' };
export const LOOPS = ['once', 'loop', 'alternate'];
export const LOOPING = new Set(['pulse', 'spin', 'float', 'wiggle', 'blink']);

// values from the parser -> normalized animation (or an error message)
export function parseAnimate(values) {
  const [preset, ...rest] = values.map((v) => (typeof v === 'string' ? v.trim() : v));
  if (!PRESETS[preset]) return { error: `Unknown animation '${preset}'. Use one of: ${PRESET_NAMES.join(', ')}` };
  const nums = rest.filter((v) => typeof v === 'number');
  const words = rest.filter((v) => typeof v === 'string');
  const a = { preset, duration: nums[0] ?? 0.6, delay: nums[1] ?? 0, repeat: LOOPING.has(preset) ? 'loop' : 'once', ease: preset === 'pop' ? 'spring' : 'ease-out' };
  for (const w of words) { if (LOOPS.includes(w)) a.repeat = w; else if (EASES[w]) a.ease = w; else if (/^\d+$/.test(w)) a.repeat = Number(w); else return { error: `Unknown animation option '${w}'` }; }
  if (typeof nums[2] === 'number') a.repeat = nums[2];
  return { anim: a };
}

export function animateToAru(a) {
  const r = (v) => String(Math.round(v * 1000) / 1000);
  return `animate ${a.preset} ${r(a.duration)} ${r(a.delay)} ${a.repeat} ${a.ease}`;
}

// CSS for the animated nodes of a scene, in render order (deterministic)
export function animationCss(entries) {
  if (!entries.length) return '';
  const used = [...new Set(entries.map((e) => e.anim.preset))].sort();
  const keyframes = used.map((p) => `@keyframes aru-${p}{${PRESETS[p]}}`);
  const rules = entries.map(({ cls, anim: a }) => {
    const iter = a.repeat === 'once' ? 1 : a.repeat === 'loop' || a.repeat === 'alternate' ? 'infinite' : a.repeat;
    const dir = a.repeat === 'alternate' ? ' alternate' : '';
    const base = `.${cls}{transform-box:fill-box;transform-origin:center;animation:aru-${a.preset} ${a.duration}s ${EASES[a.ease] || 'ease'} ${a.delay}s ${iter}${dir} both}`;
    return a.preset === 'draw' ? `.${cls} *{stroke-dasharray:var(--aru-len,1200);animation:aru-draw ${a.duration}s ${EASES[a.ease] || 'ease'} ${a.delay}s ${iter}${dir} both}` : base;
  });
  return `<style>${keyframes.join('')}${rules.join('')}@media (prefers-reduced-motion:reduce){[class^="aru-a-"],[class^="aru-a-"] *{animation:none!important}}</style>`;
}
