// Expression evaluation for ARU values. Deterministic: same input -> same output.

function hash32(...nums) {
  // simple deterministic integer hash (xorshift-ish) over a list of numbers
  let h = 0x9e3779b9;
  for (const v of nums) {
    let x = Math.floor(v * 1000003) | 0;
    h ^= x + 0x7f4a7c15 + (h << 6) + (h >>> 2);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 13), 0x27d4eb2d);
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296; // [0,1)
}

export function rand(seed, env) {
  return hash32(seed, ...(env.seedPath || []));
}

const FUNCS = {
  sin: (a) => Math.sin(a * Math.PI / 180),
  cos: (a) => Math.cos(a * Math.PI / 180),
  tan: (a) => Math.tan(a * Math.PI / 180),
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sqrt: Math.sqrt,
  min: Math.min, max: Math.max,
  clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
  lerp: (a, b, t) => a + (b - a) * t,
};

export function evaluate(expr, env) {
  switch (expr.kind) {
    case 'num': return expr.value;
    case 'color': return expr.value;
    case 'string': return expr.value;
    case 'list': return expr.items.map((e) => evaluate(e, env));
    case 'ident': {
      if (expr.name in env.vars) return env.vars[expr.name];
      return expr.name; // bare identifiers are symbolic values (none, radial, gradient names, layer names...)
    }
    case 'neg': return -num(evaluate(expr.e, env), expr);
    case 'bin': {
      const lv = evaluate(expr.l, env), rv = evaluate(expr.r, env);
      if (expr.op === '..') return { range: [num(lv, expr), num(rv, expr)] }; // 0.08..0.16
      // symbolic words joined by '-' (direction bottom-right) stay a word
      if (expr.op === '-' && (typeof lv === 'string' || typeof rv === 'string')) return `${lv}-${rv}`;
      const l = num(lv, expr), r = num(rv, expr);
      switch (expr.op) {
        case '+': return l + r; case '-': return l - r; case '*': return l * r;
        case '/': return r === 0 ? 0 : l / r; case '%': return r === 0 ? 0 : l % r;
      }
      throw new Error(`Unknown operator ${expr.op}`);
    }
    case 'call': {
      const args = expr.args.map((a) => evaluate(a, env));
      if (expr.name === 'rand') {
        const [seed = 0, lo = 0, hi = 1] = args;
        return lo + rand(seed, env) * (hi - lo);
      }
      if (expr.name === 'cycle') { // cycle(index, a, b, c...) -> opts[index mod n], no randomness
        const [idx, ...opts] = args;
        return opts.length ? opts[((Math.floor(idx) % opts.length) + opts.length) % opts.length] : 0;
      }
      if (expr.name === 'pick') { // pick(seed, a, b, c...) -> deterministic choice
        const [seed, ...opts] = args;
        return opts.length ? opts[Math.floor(rand(seed, env) * opts.length) % opts.length] : 0;
      }
      const f = FUNCS[expr.name];
      if (!f) throw new Error(`Unknown function ${expr.name}()`);
      return f(...args);
    }
  }
  throw new Error(`Cannot evaluate ${expr.kind}`);
}

function num(v, expr) {
  if (typeof v !== 'number') throw new Error(`Expected a number but got '${v}'`);
  return v;
}
