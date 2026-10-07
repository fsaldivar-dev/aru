// ARU parser: tokens -> AST.
//
// Grammar (informal):
//   document  := stmt*
//   stmt      := node | property
//   node      := NODETYPE arg* [ '{' stmt* '}' ]
//   property  := IDENT value*                    (terminated by newline / ';' / '}')
//   value     := '(' expr ')' | tightExpr        (tightExpr = expression with no spaces: 100+i*40)
//   expr      := Pratt-parsed arithmetic with idents, numbers, calls
//
// Node types and their positional args:
//   circle|ellipse|rect|polygon|path|line|group  [name]
//   gradient  name [linear|radial] [angle]
//   repeat    count [varname]
//   clone     ref [name]
//   define    name
//   fur       targetName [name]
//   ridge     name

import { tokenize, AruSyntaxError } from './tokenizer.js';

export const NODE_TYPES = new Set([
  'circle', 'ellipse', 'rect', 'polygon', 'path', 'line', 'group', 'text',
  'gradient', 'repeat', 'clone', 'define', 'fur', 'ridge',
  // semantic level (ARU Semantic): compiled to geometry by the procedural compiler
  'blueprint', 'landmarks', 'landmark', 'palette', 'region', 'contour', 'spot', 'edge', 'planes',
  'symmetry', 'mirror', 'tweak', 'scatter',
]);

// blocks whose body holds only properties (so `line 0 0` inside a path, or `nose 0.5 0.6` inside landmarks,
// are never mistaken for node headers)
const PROPERTY_ONLY = new Set(['path', 'text', 'landmarks', 'palette', 'edge', 'planes', 'contour', 'spot', 'symmetry', 'fur']);

const BIN_PREC = { '..': 5, '+': 10, '-': 10, '*': 20, '/': 20, '%': 20 };

class Parser {
  constructor(tokens) { this.toks = tokens; this.pos = 0; }
  peek(o = 0) { return this.toks[this.pos + o]; }
  next() { return this.toks[this.pos++]; }
  is(type, value) { const t = this.peek(); return t.type === type && (value === undefined || t.value === value); }
  error(msg, tok = this.peek()) { throw new AruSyntaxError(msg, tok.line, tok.col); }
  skipSeparators() { while (this.is('newline') || this.is('punct', ';')) this.next(); }
  atStmtEnd() { return this.is('newline') || this.is('punct', ';') || this.is('punct', '}') || this.is('eof'); }

  parseDocument() {
    const doc = { type: 'document', props: [], children: [], line: 1, col: 1 };
    this.parseStatements(doc, true);
    if (!this.is('eof')) this.error(`Unexpected '${this.peek().value}'`);
    return doc;
  }

  parseStatements(parent, isRoot) {
    for (;;) {
      this.skipSeparators();
      if (this.is('eof')) { if (!isRoot) this.error(`Unexpected end of file: '${parent.type}${parent.name ? ' ' + parent.name : ''}' opened on line ${parent.line} is missing its '}'`); return; }
      if (this.is('punct', '}')) { if (isRoot) this.error("Unexpected '}'"); return; }
      const t = this.peek();
      if (t.type !== 'ident') this.error(`Expected a keyword, got '${t.value}'`);
      // inside a path block every statement is a drawing command / property (so `line x y` is a command)
      if (!PROPERTY_ONLY.has(parent.type) && NODE_TYPES.has(t.value)) parent.children.push(this.parseNode());
      else parent.props.push(this.parseProperty());
    }
  }

  parseNode() {
    const t = this.next();
    const node = { type: t.value, name: null, args: [], props: [], children: [], line: t.line, col: t.col };
    // positional args until '{' or statement end
    while (!this.is('punct', '{') && !this.atStmtEnd()) node.args.push(this.parseValue());
    const named = this.nodeNameFromArgs(node);
    node.name = named;
    if (this.is('punct', '{')) {
      this.next();
      this.parseStatements(node, false);
      if (!this.is('punct', '}')) this.error("Expected '}'");
      node.endLine = this.next().line;
    } else node.endLine = t.line;
    return node;
  }

  nodeNameFromArgs(node) {
    const identArg = (i) => node.args[i] && node.args[i].kind === 'ident' ? node.args[i].name : null;
    switch (node.type) {
      case 'gradient': case 'define': return identArg(0);
      case 'blueprint': case 'region': case 'contour': case 'spot': case 'scatter': case 'landmark': case 'tweak': return identArg(0);
      case 'edge': case 'planes': case 'symmetry': case 'mirror': case 'landmarks': case 'palette': return null;
      case 'clone': case 'fur': return identArg(1);
      case 'repeat': return null;
      default: return identArg(0);
    }
  }

  parseProperty() {
    const t = this.next();
    const prop = { key: t.value, values: [], line: t.line, col: t.col };
    // forgiving: `radius = 58` and `radius: 58` are accepted (common LLM habits)
    if (this.is('punct', '=') || this.is('punct', ':')) this.next();
    while (!this.atStmtEnd()) {
      if (this.is('punct', ',')) { this.next(); continue; }
      if (this.is('punct', '{')) this.error(`Unknown node type '${t.value}' (properties cannot have a block)`, t);
      prop.values.push(this.parseValue());
    }
    return prop;
  }

  // A value is either a parenthesised expression, or a "tight" expression without spaces.
  parseValue() {
    const t = this.peek();
    if (t.type === 'color') { this.next(); return { kind: 'color', value: t.value }; }
    if (t.type === 'string') { this.next(); return { kind: 'string', value: t.value }; }
    if (t.type === 'punct' && t.value === '[') return this.parseList();
    return this.parseExpr(0, true);
  }

  parseList() {
    this.next();
    const items = [];
    while (!this.is('punct', ']')) {
      if (this.is('eof')) this.error("Expected ']'");
      if (this.is('punct', ',') || this.is('newline')) { this.next(); continue; } // lists may span lines
      items.push(this.parseValue());
    }
    this.next();
    return { kind: 'list', items };
  }

  parseExpr(minPrec, tight) {
    let left = this.parsePrimary(tight);
    for (;;) {
      const t = this.peek();
      if (t.type !== 'punct' || !(t.value in BIN_PREC)) break;
      if (tight && t.spaceBefore) break;
      const prec = BIN_PREC[t.value];
      if (prec < minPrec) break;
      this.next();
      const right = this.parseExpr(prec + 1, tight);
      left = { kind: 'bin', op: t.value, l: left, r: right };
    }
    return left;
  }

  parsePrimary(tight) {
    const t = this.next();
    if (t.type === 'num') return { kind: 'num', value: t.value };
    if (t.type === 'color') return { kind: 'color', value: t.value };
    if (t.type === 'string') return { kind: 'string', value: t.value };
    if (t.type === 'punct' && t.value === '(') {
      const e = this.parseExpr(0, false);
      this.skipNewlinesInParens();
      if (!this.is('punct', ')')) this.error("Expected ')'");
      this.next();
      return e;
    }
    if (t.type === 'punct' && t.value === '-') return { kind: 'neg', e: this.parsePrimary(tight) };
    if (t.type === 'ident') {
      if (this.is('punct', '(') && !this.peek().spaceBefore) {
        this.next();
        const args = [];
        while (!this.is('punct', ')')) {
          if (this.is('eof')) this.error("Expected ')'");
          if (this.is('punct', ',')) { this.next(); continue; }
          args.push(this.parseExpr(0, false));
        }
        this.next();
        return { kind: 'call', name: t.value, args };
      }
      return { kind: 'ident', name: t.value };
    }
    this.error(`Unexpected '${t.value === '\n' ? 'newline' : t.value}'`, t);
  }
  skipNewlinesInParens() { while (this.is('newline')) this.next(); }
}

export function parse(src) {
  const tokens = tokenize(src);
  const p = new Parser(tokens);
  return { ast: p.parseDocument(), tokenCount: tokens.length - 1 };
}
