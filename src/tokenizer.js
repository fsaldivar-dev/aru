// ARU tokenizer: text -> tokens with position + whitespace info.
// Token types: num, ident, color, string, punct, newline, eof

const PUNCT = new Set(['{', '}', '(', ')', ',', ';', '+', '-', '*', '/', '%', '[', ']', ':', '=']);

export class AruSyntaxError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'AruSyntaxError';
    this.line = line;
    this.col = col;
  }
}

export function tokenize(src) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const n = src.length;
  let spaceBefore = false;

  const push = (type, value, len) => {
    tokens.push({ type, value, line, col, spaceBefore });
    col += len; i += len; spaceBefore = false;
  };

  while (i < n) {
    const ch = src[i];
    if (ch === '\n') {
      tokens.push({ type: 'newline', value: '\n', line, col, spaceBefore });
      i++; line++; col = 1; spaceBefore = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; spaceBefore = true; continue; }
    if (ch === '/' && src[i + 1] === '/') { // line comment
      while (i < n && src[i] !== '\n') { i++; col++; }
      continue;
    }
    if (ch === '#') {
      let j = i + 1;
      while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
      const len = j - i;
      if (len === 1) throw new AruSyntaxError('Expected hex color after #', line, col);
      push('color', src.slice(i, j), len);
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== '\n') j++;
      if (src[j] !== ch) throw new AruSyntaxError('Unterminated string', line, col);
      push('string', src.slice(i + 1, j), j - i + 1);
      continue;
    }
    if (ch === '.' && src[i + 1] === '.') { push('punct', '..', 2); continue; } // range: 0.08..0.16
    // number (with optional unary minus when it starts a value)
    const prev = tokens[tokens.length - 1];
    const isDigitStart = /[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''));
    const minusStartsNumber = ch === '-' && /[0-9.]/.test(src[i + 1] || '') &&
      (spaceBefore || !prev || prev.type === 'newline' || (prev.type === 'punct' && prev.value !== ')' && prev.value !== ']'));
    if (isDigitStart || minusStartsNumber) {
      const m = /^-?(\d+(?:\.(?!\.)\d*)?|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      push('num', parseFloat(m[0]), m[0].length);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
      push('ident', m[0], m[0].length);
      continue;
    }
    if (PUNCT.has(ch)) { push('punct', ch, 1); continue; }
    throw new AruSyntaxError(`Unexpected character '${ch}'`, line, col);
  }
  tokens.push({ type: 'eof', value: null, line, col, spaceBefore });
  return tokens;
}
