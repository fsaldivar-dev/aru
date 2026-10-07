// Assistant chat over the AI CLIs installed on this machine (claude, codex, agy, gemini).
// The page never builds command lines: it sends { provider, model, system, prompt, schema, images } to a BRIDGE
// (the Tauri backend in the desktop app, or tools/serve.mjs in the browser), which only knows these four CLIs and
// builds their arguments itself. Every CLI is asked for the same structured answer:
//   { reply, operations[], reference{...}, aru }
//   - operations: batch edits (src/batch.js), the default way to change the document
//   - reference:  "vectorize this attached image": the AI gives VISUAL CONTEXT only (parts, importance, intent,
//                 placement); the ReferenceTracer measures the pixels and produces the geometry
//   - aru:        ILLUSTRATOR MODE only (off by default): an ARU fragment written by the AI, compiled and inserted
import { PRESET_NAMES, EASES } from './anim.js';
import { OPERATIONS } from './edit.js';

export const PROVIDERS = [
  { id: 'claude', name: 'Claude', bin: 'claude', models: ['', 'sonnet', 'opus', 'haiku'], note: 'Claude Code CLI', vision: true },
  { id: 'codex', name: 'Codex', bin: 'codex', models: ['gpt-5.5', ''], note: 'OpenAI Codex CLI', vision: true },
  { id: 'agy', name: 'Antigravity', bin: 'agy', models: [''], note: 'Google Antigravity CLI (lento: ~30 s)', vision: true },
  { id: 'gemini', name: 'Gemini', bin: 'gemini', models: ['', 'gemini-2.5-pro', 'gemini-2.5-flash'], note: 'Gemini CLI', vision: true },
];

const OPS = OPERATIONS;
const nullable = (type) => ({ type: [type, 'null'] });
// strict schemas (OpenAI-compatible): every field present, unused ones null; no optional objects (portable)
const OP_FIELDS = {
  target: { type: 'string' }, pattern: nullable('string'), label: nullable('string'), fill: nullable('string'), stroke: nullable('string'),
  strokeWidth: nullable('number'), opacity: nullable('number'), hidden: nullable('boolean'), locked: nullable('boolean'),
  preset: nullable('string'), duration: nullable('number'), delay: nullable('number'), stagger: nullable('number'), repeat: nullable('string'), ease: nullable('string'),
  shadow: nullable('string'), inner: nullable('string'),
  color: nullable('string'),
  tolerance: nullable('number'), strength: nullable('number'), cornerAngle: nullable('number'), other: nullable('string'),
  endpoint: nullable('string'), otherEndpoint: nullable('string'), maxDistance: nullable('number'),
  dx: nullable('number'), dy: nullable('number'), dir: nullable('string'), shape: nullable('string'), x: nullable('number'), y: nullable('number'), w: nullable('number'), h: nullable('number'), text: nullable('string'),
};
const PART_FIELDS = { path: { type: 'string' }, label: nullable('string'), type: nullable('string'), importance: nullable('number'), x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, polygon: { type: ['array', 'null'], items: { type: 'array', items: { type: 'number' } } }, geometry: nullable('string'), edge: nullable('string'), detail: nullable('string') };
const BOX_OR_NULL = { type: ['object', 'null'], additionalProperties: false, required: ['x', 'y', 'w', 'h'], properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } };
const BACKDROP_OR_NULL = { type: ['object', 'null'], additionalProperties: false, required: ['shape', 'color', 'padding', 'style', 'glyphColor', 'depth'], properties: { shape: { type: 'string', enum: ['squircle', 'circle', 'square'] }, color: { type: 'string' }, padding: { type: 'number' }, style: { type: 'string', enum: ['full', 'glyph'] }, glyphColor: { type: ['string', 'null'] }, depth: { type: ['number', 'null'] } } };
const REF_FIELDS = { use: { type: 'boolean' }, image: { type: 'string' }, label: { type: 'string' }, x: nullable('number'), y: nullable('number'), w: nullable('number'), h: nullable('number'), abstraction: nullable('number'), keepBackground: { type: 'boolean' }, dropHoles: { type: 'boolean' }, crop: BOX_OR_NULL, backdrop: BACKDROP_OR_NULL, parts: { type: 'array', items: { type: 'object', additionalProperties: false, required: Object.keys(PART_FIELDS), properties: PART_FIELDS } } };
export const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'operations', 'reference', 'aru', 'aruInto'],
  properties: {
    reply: { type: 'string' },
    operations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['op', ...Object.keys(OP_FIELDS)], properties: { op: { type: 'string', enum: OPS }, ...OP_FIELDS } } },
    reference: { type: 'object', additionalProperties: false, required: Object.keys(REF_FIELDS), properties: REF_FIELDS },
    aru: { type: 'string' },
    aruInto: nullable('string'),
  },
};

// AI review of a traced reference: the model SEES original | result and the measured score, and may propose another
// tune. The Studio traces it and keeps it ONLY if the score improves, so every provider converges to the same result.
const TUNE_FIELDS = { ink: { type: 'string', enum: ['on', 'off'] }, faint: { type: 'number' }, abstraction: { type: 'number' }, detail: { type: 'string', enum: ['low', 'medium', 'high'] } };
export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['accept', 'reason', 'tune'],
  properties: { accept: { type: 'boolean' }, reason: { type: 'string' }, tune: { type: 'object', additionalProperties: false, required: Object.keys(TUNE_FIELDS), properties: TUNE_FIELDS } },
};
export const REVIEW_SYSTEM = `You review a vectorization made by ARU Studio's tracer. The attached image "compare" shows the ORIGINAL on the
left and the current VECTOR RESULT on the right. You never draw; you choose tracer parameters ("tune"):
- ink: "on" = line-art mode: dark outlines/hatching become a crisp ink layer over flat color fills (cartoons, manga,
  anime, comics, sketches). "off" = flat color regions only (flat vector art without outlines, logos, photos).
- faint 0.5..1: how bold faint thin lines are drawn (1 = keep every faint line at its half-maximum width; lower = thinner).
- abstraction 0..1: higher = simpler, smoother, fewer regions; lower = more color detail.
- detail low|medium|high: how many colors/regions the fill tracer may keep.
A deterministic score decides: your tune is traced and kept only if it measures better, so propose ONE concrete change
that fixes the most visible difference (missing or broken lines, lost shading, too many specks, posterized gradients).
Set accept=true (and repeat the current tune) when the result is already faithful or nothing would help.
Judge ONLY the tracing fidelity here: the icon styling (base shape, pastel colours, depth / elevation, glyph) is applied
afterwards by the tool, so do not mention it as missing.
Reply in the user's language in "reason" (one or two short sentences).`;
export function buildReviewPrompt({ label, current, metrics, tried, userText = '' }) {
  const pct = (v) => `${Math.round(v * 1000) / 10}%`;
  return `${userText ? `User's request (reply in its language): ${String(userText).slice(0, 300)}\n` : ''}Reference: ${label}
Current tune: ${JSON.stringify(current)}
Measured (vs the original): score ${metrics.score}; thin lines recovered ${pct(metrics.lineRecall)}; invented lines ${pct(1 - metrics.linePrecision)}; pixels within ±30 RGB ${pct(metrics.within30)}; mean ΔE ${metrics.dE}.
Already tried (do not repeat): ${tried.map((t) => `${JSON.stringify(t.tune)} -> score ${t.metrics.score}`).join('; ')}
Look at "compare" (left original, right result) and return { accept, reason, tune }.`;
}

// Semantic grouping by "Set-of-Mark": the tracer cuts the image into numbered PIECES (trace/segments.js) and the model
// says which part each piece belongs to. The AI names, the tracer cuts.
export const PIECES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['assignments'],
  properties: { assignments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['piece', 'part'], properties: { piece: { type: 'integer' }, part: { type: 'string' } } } } },
};
export const PIECES_SYSTEM = `You organize the layers of a vectorized image. The attached image "pieces" shows the image cut into numbered
pieces (thin white borders, a number on each piece). Assign EVERY piece number to exactly one part path from the list
(use "background" for anything that is scenery/backdrop not covered by a more specific background part). Choose the most
specific part that contains the whole piece; when a piece mixes two parts, choose the one that covers most of it.
Return { assignments: [{ piece, part }] } with one entry per piece. Use only the given part paths.`;
export function buildPiecesPrompt({ parts, count }) {
  return `Pieces: 1..${count}
Parts (path — label):
${parts.map((p) => `${p.path} — ${p.label || p.path}`).join('\n')}
background — (generic backdrop)
Look at "pieces" and assign every piece.`;
}

// Icon review (glyph style): the model reads the INSPECTION of the built icon (trace/glyph.js) and moves the levers.
const GLYPH_FIELDS = { openThin: { type: 'number' }, closeCuts: { type: 'number' }, minFeature: { type: 'number' }, smooth: { type: 'number' } };
export const GLYPH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['accept', 'reason', 'params'],
  properties: { accept: { type: 'boolean' }, reason: { type: 'string' }, params: { type: 'object', additionalProperties: false, required: Object.keys(GLYPH_FIELDS), properties: GLYPH_FIELDS } },
};
export const GLYPH_SYSTEM = `You are a senior icon designer reviewing a flat GLYPH icon (one flat colour, interior lines cut out) that ARU
Studio built from the user's artwork. You never draw: you set the cleanup LEVERS and the tool rebuilds the glyph.
The attached image "icon" shows, left, the icon large with the inspector's markers (RED circle = speck, ORANGE = part
too thin, BLUE = cut too thin, MAGENTA = saw-tooth) and, right, the same icon at 96 px and 48 px (how users see it).
Professional standard: no specks, no parts or cuts thinner than 0.75 px at 48 px, clean outlines with sharp intended
corners, and the identity of the artwork kept (fidelity ≥ 0.9). Fix the defects the report lists with the lever it
names; change one or two levers per round, in small steps. The tool keeps your change ONLY if the icon score
improves. Set accept=true (and repeat the current levers) when nothing visible is left to fix. Reply in the user's
language in "reason" (one or two short sentences).`;
export function buildGlyphPrompt({ report, userText = '', tried = [] }) {
  return `${userText ? `User's request (reply in its language): ${String(userText).slice(0, 300)}\n` : ''}${report}
Already tried (do not repeat): ${tried.map((t) => `${JSON.stringify(t.params)} -> ${t.score}`).join('; ') || 'none'}
Return { accept, reason, params }.`;
}

// Icon pack review: the tool inspects the AI-drawn pack (trace/iconpack.js); the model sets pack levers and may redraw
// flagged icons; the pack score keeps the best.
const PACK_LEVER_FIELDS = { repair: nullable('boolean'), strokeWidth: nullable('number'), caps: { type: ['string', 'null'], enum: ['round', 'butt', 'square', null] }, joins: { type: ['string', 'null'], enum: ['round', 'miter', 'bevel', null] }, fitSize: nullable('number'), color: nullable('string') };
export const PACK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['accept', 'reason', 'levers', 'redraw'],
  properties: {
    accept: { type: 'boolean' }, reason: { type: 'string' },
    levers: { type: 'object', additionalProperties: false, required: Object.keys(PACK_LEVER_FIELDS), properties: PACK_LEVER_FIELDS },
    redraw: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['icon', 'aru'], properties: { icon: { type: 'string' }, aru: { type: 'string' } } } },
  },
};
export const PACK_SYSTEM = `You are a senior icon designer reviewing an app ICON PACK that you (or another model) drew in ARU. The tool
inspected it. The attached image "pack" shows every icon at 96 px (RED frame = it has issues) with the same icon at
24 px under it. Professional pack: one style, one stroke width, the same optical size, every icon inside the safe
area, no duplicates (each a distinct, recognizable metaphor), no specks, legible at 24 px.
Fix mechanical issues with the LEVERS (pack-wide, deterministic): repair (fixes ARU mistakes the report lists: a
multi-point "move", a stroked shape without "fill none" that renders BLACK, invisible shapes), strokeWidth, caps, joins,
fitSize (same optical size for all), color. REDRAW only icons a lever cannot fix (duplicate metaphor, empty, illegible, too detailed,
wrong style): give their new content as ARU in local 0..24 units inside the safe area 2..22 (your redraw goes
through the same levers as the rest of the pack), in the pack's style
(outline: fill none; stroke COLOR 2; cap round; join round), no wrapper group. The tool keeps a change ONLY if the
pack score improves. accept=true when nothing visible is left to fix. Reply in the user's language in "reason".
The report includes a BLIND TEST (another look at the icons without labels): an icon "no se reconoce" needs a clearer,
conventional metaphor (settings = a gear with teeth, not a sun; profile = head and shoulders inside the safe area).
"Facetada" means a curve drawn with straight segments: redraw it with "curve" (smooth Béziers).`;
export const packSystem = () => `${PACK_SYSTEM}\n\n${ARU_GUIDE}`;
export function buildPackPrompt({ report, userText = '', tried = [] }) {
  return `${userText ? `User's request (reply in its language): ${String(userText).slice(0, 300)}\n` : ''}${report}
Already tried: ${tried.map((t) => `${t.what} -> ${t.score}${t.kept ? ' (kept)' : ' (discarded)'}`).join('; ') || 'nothing yet'}
Return { accept, reason, levers, redraw }.`;
}
// Blind test of an icon pack: numbered icons WITHOUT labels; the model says what each one means. A professional icon is
// recognised at 24 px without its label.
export const BLIND_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answers'],
  properties: { answers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['icon', 'meaning'], properties: { icon: { type: 'integer' }, meaning: { type: 'string' } } } } },
};
export const BLIND_SYSTEM = `You are testing the legibility of an app icon pack. The attached image "blind" shows numbered icons with NO labels
(large and at 24 px). For EACH number say what it depicts: pick one meaning from the given list if (and only if) the
icon clearly reads as it; otherwise answer "otro: <what you actually see>" (e.g. "otro: sol"). Judge like a first-time
user; do not guess from position. Return { answers: [{ icon, meaning }] } with one entry per number.`;
export const buildBlindPrompt = ({ meanings, count }) => `Icons: 1..${count}\nMeanings (in random order): ${meanings.join(' · ')}\nAnswer for every icon.`;

const ARU_GUIDE = `ARU language (for the "aru" field). Units are canvas units; y grows downwards. Nodes, one per line or "{ a; b }":
  group name { at X Y; label "Name"; ...children }        (children are relative to the group's "at")
  rect name { at CX CY; size W H; corner R; fill #RRGGBB }  (centered on at)
  circle name { at CX CY; radius R; fill ... }   ellipse name { at CX CY; size W H; fill ... }
  polygon name { points X1 Y1 X2 Y2 X3 Y3; fill ... }   line name { from X1 Y1; to X2 Y2; stroke #RRGGBB 4; cap round }
  path name {
      move X Y
      line X Y
      curve C1X C1Y C2X C2Y X Y      (cubic Bézier)
      quad CX CY X Y
      close
      fill #RRGGBB
      stroke #RRGGBB 3
  }
  text name { at X Y; content "Hola"; size 32; weight 700; anchor middle; fill #FFFFFF; font "Inter" }
  gradient gname linear 90 { stop 0 #FFB000; stop 1 #E5383B }   then "fill gname"   (radial: gradient g radial 0.5 0.5 0.6)
  any shape/group: opacity 0.8; rotate 15; scale 1.2; label "Visible name"; animate pop 0.6 0 once ease-out
  effects on any shape/group: shadow DX DY BLUR #RRGGBB OPACITY (drop shadow: elevation) · inner DX DY BLUR #RRGGBB OPACITY
  (inner shadow / highlight: relief, up to two: e.g. inner 0 4 6 #FFFFFF 0.5 for a top light, inner 0 -5 10 #2F5148 0.2 for a bottom shade)
  repeat 8 i { circle { at 100+i*40 200; radius 6; fill #FFFFFF } }      (expressions: 100+i*40 or (expr))
Write clean, closed shapes with smooth Béziers, consistent stroke widths, a small palette and descriptive names
(group per part: glove { cuff {...} thumb {...} }). Keep everything inside the canvas. No comments.
ICON PACKS (app/UI icons): ONE group (the frame, with a label and semantic ui.iconpack) whose child groups are the icons, one per meaning, each
with a label in the user's language; each icon's "at" is the TOP-LEFT of its 24×24 cell (cells 24 apart plus a gap of
16, e.g. at 0 0, at 40 0, at 80 0 …) and its content uses LOCAL units 0..24 inside the safe area 2..22. Professional
UI icons: one style (outline by default: fill none, stroke one colour 2, cap round, join round), the same optical size,
no duplicates (every icon a distinct, recognizable metaphor), at most ~12 shapes each, legible at 24 px. The tool
inspects the pack and may ask you to adjust levers or redraw specific icons.`;

export function systemPrompt({ illustrator = false } = {}) {
  return `You are the assistant inside ARU Studio, a layered vector editor. You help the user understand and edit the open document.
Answer in the user's language, briefly, in plain text (light Markdown is fine: **bold**, lists).
You may receive images: "canvas.png" is a render of the CURRENT artboard (use it to see what the layers look like);
"ref1.png", "ref2.png"... are REFERENCE images attached by the user.

Return JSON with: reply, operations, reference, aru, aruInto. Every object must contain ALL its fields; unused fields are null.
aruInto (or null): the path of an EXISTING group to draw INTO (a light, a shine, a badge ON TOP of an icon): your "aru" is
then written in CANVAS coordinates, added inside that group above its content and never moved; null = a new frame in free space.

1) operations (default way to edit). Targets: a layer path from the outline, "selection", "root" (for add), or a selector:
part:<name>, role:<role>, type:<type>, semantic:<path>, name:<name>, "*"; several selectors separated by spaces = AND.
For ONE specific layer use its exact path (e.g. card.dot), never part:<path>. Do not invent paths.
- rename: pattern with tokens {name} {label} {type} {part} {semantic} {i} {n}
- material: preset neon|chrome|glass|clay|fruits, optional color #RRGGBB, strength >0..1 (default 1).
  Paints existing filled/stroked pieces consistently, preserves holes, geometry, transforms and stroke widths.
  Gradients and proportional relief are computed by the engine; no drawing or gradient coordinates needed.
- set: label, fill, stroke, strokeWidth, opacity (0..1), hidden, locked (colors #RRGGBB), shadow "DX DY BLUR #COLOR OPACITY"
  (drop shadow = elevation), inner "DX DY BLUR #COLOR OPACITY" (inner shadow/highlight = relief; two separated by |), "none" clears
- animate: preset (${PRESET_NAMES.join(', ')}, none), duration s, delay s, stagger s per layer, repeat (once|loop|alternate), ease (${Object.keys(EASES).join(', ')})
- translate: dx, dy · group (label) · ungroup · duplicate · delete · reorder (dir: top|up|down|bottom)
- add: shape (rect|ellipse|text|group), x, y (centre), w, h, fill, label, text; target = parent group path or "root"
- canvas: w, h = new canvas size (target "root"); use it BEFORE adding content that does not fit
- smooth: target = existing path or group, strength 0..1 (default 0.6), tolerance 0.001..100 (default 1 canvas unit),
  cornerAngle 5..175 (default 60 degrees). The engine aligns curve handles, preserves anchors/endpoints and sharp corners,
  and bounds the displacement. Use for softer contours, never redraw coordinates. Start with tolerance 0.5..1.
- simplify: target = path or group, tolerance and cornerAngle as above. Removes redundant LINE points while preserving
  existing curves, corners, closures and separate subpaths (holes). Run BEFORE smooth; it does not reduce Bézier segments.
- weld: target and other = TWO exact open path names, endpoint and otherEndpoint = auto|start|end (default auto: nearest pair),
  maxDistance (default 8 canvas units). Moves both selected endpoints to their midpoint, keeping adjacent handles and both layers.
- connect: same fields as weld, joins into ONE continuous path named target; removes other. Requires adjacent layers
  in the same group, fill none, matching style/scale/rotation; use weld when either path's identity/style must remain.
pathInfo in the outline describes editable contours. These tools support move/line/curve/quad/close only; arcs and smooth
commands are rejected without editing. Locked paths/ancestors are protected. Group refinement visits descendant paths once.
Edit the existing reference-derived layers to transform a base. Preserve semantic parts and use small, scoped changes;
do not replace an entire reference with a drawing from memory. These operations refine geometry; new poses/expressions
need semantic deformation tools beyond this first set. Welding is a positional edit, not a persistent constraint.
LAYOUT: the outline gives bounds=[x, y, w, h] for frames and the occupied/free area. New frames (a drawing, a traced
reference, a set of icons) go in FREE space with a margin of ~48 units and never overlap existing bounds; group each
new set in one top-level group with a label (it becomes a movable frame).

2) reference: to turn an attached reference image into vector layers, set use=true, image="ref1", a label, the placement
(x, y = centre in canvas units; w, h = box) and describe what you SEE as parts: each part has a dotted path
("glove", "glove.cuff", "glove.thumb"), a label in the user's language ("Guante", "Puño", "Pulgar"), a box in the reference image
normalized 0..1 (x, y = top-left, w, h) and, when the box is loose (diagonal limbs, crossed arms, irregular shapes), a polygon
of 6-16 normalized [x, y] points following the part's outline (else null). The parts become the LAYER GROUPS: cover every
visible element, background included (e.g. "background.trees", "background.sky", "character.head.fur", "character.leftArm",
"character.head.leftEye"), from big to small; a region goes to the deepest part that contains it. Parts never change the
pixels (the tracer measures them), they only organize the layers,
importance 0..1, and intent words (geometry: geometric|organic|organic-clean|circular|linear; edge: sharp|smooth|irregular|analytic;
detail: low|medium|high). You do NOT draw: the tracer measures the pixels. abstraction 0..1 (0.5 default; higher = simpler).
New illustrations receive an editable opaque background in the artboard's colour (white on a transparent artboard).
This background belongs to the illustration and moves with it. Do not add a duplicate background in your ARU fragment.
keepBackground=false drops the original plain backdrop around the subject. dropHoles=true ALSO cuts enclosed areas
of that backdrop colour (letter counters, gaps between fingers); the opaque background shows through those holes.
Keep it false when those areas are deliberate highlights of the same color. Geometric holes are preserved; new images
are opaque, including rounded icon corners. Adding details with aruInto preserves the existing group's background.
crop (normalized box of the reference, or null) vectorizes ONLY that area: use it when the user wants one element of the
image (the wolf head of a logo without its wordmark). backdrop (or null) puts the traced subject on a base shape for app
icons / avatars: { shape: squircle|circle|square, color: "#RRGGBB", padding 0..0.4, style: full|glyph, glyphColor: "#RRGGBB"|null, depth 0..1 }.
depth > 0 = SOFT 3D (pastel, elevated, gradients — e.g. 0.6): gradient base with a drop shadow, a top highlight and a bottom
shade, and a raised glyph (gradient + its own shadow); 0 = flat. Pastel colours with white glyphs are fine with depth.
style "full" keeps the artwork's colours; style "glyph" makes the subject ONE flat colour (glyphColor, white by default)
with its interior lines cut out — the look of flat social/app icon sets (white symbol on a solid coloured circle).
With TWO images — the user's artwork (logo) and a STYLE reference (an icon sheet, a moodboard) — trace the ARTWORK
(reference.image = that image) and only READ the style from the other one: shape, palette, glyph vs full colour.
Prefer the user's brand colours (taken from their logo) for the base.
An icon, avatar, sticker or variant OF an attached logo or image is a REFERENCE job (crop + backdrop), never a redraw in
"aru": the tracer keeps the real shapes of the user's artwork; a redraw from memory loses its identity.
If no reference is used: use=false, image="", label="", parts=[], keepBackground=false, dropHoles=false, crop=null, backdrop=null.

3) aru: ${illustrator ? `ILLUSTRATOR MODE IS ON. When the user asks you to draw something new (an icon, a shape, a scene) and there is no reference
to trace, write it in the "aru" field (it is inserted as a new group on top of the document). Otherwise "".
${ARU_GUIDE}` : 'illustrator mode is OFF: always "". If the user asks you to draw something from scratch, say they can attach a reference image or turn on "Modo ilustrador".'}

If the user only asks a question, return operations [], reference.use=false and aru "".
There is NO second turn: everything your reply announces must be in THIS answer (if you say you will vectorize or make
an icon from the image, reference.use must be true now). Never only resize the canvas and promise the rest.`;
}
// kept for compatibility with earlier callers
export const SYSTEM = systemPrompt();

export function buildPrompt({ context, selection, history, message, images = [] }) {
  const past = history.slice(-8).map((m) => (m.role === 'user' ? `User: ${m.text}` : `Assistant: ${m.text}${m.applied ? ` (applied ${m.applied} operations)` : ''}${m.log?.length ? `\nEngine results: ${m.log.slice(0, 12).map((l) => `${l.ok ? 'OK' : 'ERROR'} ${l.message}`).join('; ')}` : ''}`)).join('\n');
  const att = images.length ? `\nAttached images (also present as files in your working directory): ${images.map((i) => `${i.name}.${i.ext}${i.name === 'canvas' ? ' (render of the current artboard)' : ' (reference from the user)'}`).join(', ')}` : '';
  return `${context}
Current selection: ${selection.length ? selection.join(', ') : '(nothing)'}${att}
${past ? `\nConversation so far:\n${past}\n` : ''}
User: ${message}`;
}

// provider output -> { reply, operations, reference, aru, usage }
// provider output -> the structured JSON object (any schema), plus usage
export function extractStructured(provider, res) {
  const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const fromText = (t) => { const m = String(t || '').match(/\{[\s\S]*\}/); return m ? tryJson(m[0]) : null; };
  let answer = null, usage = null;
  if (provider === 'claude') {
    // stream-json: the final event has type "result" (json mode: the whole stdout is that object)
    let j = tryJson(res.stdout);
    if (!j) for (const line of String(res.stdout || '').split('\n').reverse()) { const e = tryJson(line); if (e?.type === 'result') { j = e; break; } }
    if (j?.is_error) throw new Error(j.result || 'Claude devolvió un error');
    answer = j?.structured_output || fromText(j?.result);
    if (j) usage = { usd: j.total_cost_usd ?? null, ms: j.duration_ms ?? null };
  } else if (provider === 'codex') {
    answer = tryJson(res.output) || fromText(res.output) || fromText(res.stdout);
  } else if (provider === 'agy') {
    const j = tryJson(res.stdout);
    if (j && j.status && j.status !== 'SUCCESS') throw new Error(`Antigravity: ${j.status}`);
    answer = j?.structured_output || fromText(j?.response);
    if (j?.usage) usage = { tokens: j.usage.total_tokens, ms: j.duration_seconds ? j.duration_seconds * 1000 : null };
  } else if (provider === 'gemini') {
    const j = tryJson(res.stdout);
    answer = fromText(j?.response ?? res.stdout);
  }
  return { answer, usage };
}
export function parseAnswer(provider, res) {
  const { answer, usage } = extractStructured(provider, res);
  if (!answer || typeof answer.reply !== 'string') {
    const err = (res.stderr || '').split('\n').filter(Boolean).slice(-3).join(' · ');
    throw new Error(res.code ? `El CLI terminó con código ${res.code}${err ? `: ${err}` : ''}` : 'La respuesta no tiene el formato esperado');
  }
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
  const operations = (answer.operations || []).map(clean);
  const ref = answer.reference && answer.reference.use ? { ...clean(answer.reference), parts: (answer.reference.parts || []).map(clean) } : null;
  return { reply: answer.reply, operations, reference: ref, aru: typeof answer.aru === 'string' ? answer.aru.trim() : '', aruInto: typeof answer.aruInto === 'string' && answer.aruInto.trim() ? answer.aruInto.trim() : null, usage };
}

// flat parts from the AI -> a VisualContext (nested by dotted path; boxes normalized to the reference image)
export function contextFromParts(parts = []) {
  const byPath = new Map(), roots = [];
  const sorted = [...parts].filter((p) => p.path && /^[A-Za-z0-9_.]+$/.test(p.path)).sort((a, b) => a.path.split('.').length - b.path.split('.').length);
  const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  for (const p of sorted) {
    const segs = p.path.split('.'), id = segs[segs.length - 1];
    const vi = Object.fromEntries([['geometry', p.geometry], ['edge', p.edge], ['detail', p.detail]].filter(([, v]) => v));
    // polygon: [[x, y], ...] normalized (≥ 3 points) — follows the part's outline; the box stays as a fallback
    const poly = Array.isArray(p.polygon) ? p.polygon.filter((q) => Array.isArray(q) && q.length >= 2 && q.every(Number.isFinite)).map((q) => [clamp(q[0]), clamp(q[1])]) : [];
    const node = { id, type: p.type || id, ...(p.label ? { label: String(p.label).slice(0, 60) } : {}), importance: p.importance == null ? 0.7 : clamp(p.importance), bounds: [clamp(p.x), clamp(p.y), Math.max(0.01, clamp(p.w)), Math.max(0.01, clamp(p.h))], ...(poly.length >= 3 ? { polygon: poly } : {}), ...(Object.keys(vi).length ? { visualIntent: vi } : {}), parts: [] };
    if (byPath.has(p.path)) continue;
    // missing ancestors ("wolf.left" for "wolf.left.fur") are created without a shape, so the AI's paths stay exact
    // and two "fur" under different parents never become duplicate siblings
    let parent = null;
    for (let d = 1; d < segs.length; d++) {
      const path = segs.slice(0, d).join('.');
      if (!byPath.has(path)) { const imp = { id: segs[d - 1], type: segs[d - 1], parts: [] }; byPath.set(path, imp); (parent ? parent.parts : roots).push(imp); }
      parent = byPath.get(path);
    }
    byPath.set(p.path, node);
    (parent ? parent.parts : roots).push(node);
  }
  return { version: 1, scene: 'reference', background: { importance: 0.2 }, objects: roots };
}

// ---- transport: Tauri backend or the local dev server ----
const tauri = () => (typeof window !== 'undefined' ? window.__TAURI__ : null);
export const isDesktop = () => !!tauri()?.core;
export async function detectAgents() {
  if (isDesktop()) return tauri().core.invoke('agents_detect');
  const r = await fetch('/api/agents', { headers: { 'x-aru-bridge': '1' } });
  if (!r.ok) throw new Error('El servidor local no tiene el puente de agentes (usa node tools/serve.mjs)');
  return r.json();
}
export async function runAgent(req) {
  if (isDesktop()) return tauri().core.invoke('agent_run', { req });
  const r = await fetch('/api/agents/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aru-bridge': '1' }, body: JSON.stringify(req) });
  if (!r.ok) { const t = await r.text(); let m = t; try { m = JSON.parse(t).error || t; } catch { /* plain text */ } throw new Error(BRIDGE_ERRORS[m] || m); }
  return r.json();
}
const BRIDGE_ERRORS = { 'at most 4 images': 'Se pueden enviar como máximo 4 imágenes por mensaje.', 'invalid image': 'Una de las imágenes no es válida (PNG, JPEG o WebP).', 'image too large (max 6 MB)': 'Una imagen pesa más de 6 MB.' };
export async function cancelAgent(runId) {
  if (isDesktop()) return tauri().core.invoke('agent_cancel', { runId });
  return fetch('/api/agents/cancel', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aru-bridge': '1' }, body: JSON.stringify({ runId }) });
}
