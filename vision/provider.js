// VisionProvider: the only interface the tracer knows. Any model (Claude, OpenAI, Gemini, a local detector)
// or a human can implement it. The tracer never learns which one produced the context.
//
//   class MyProvider extends VisionProvider { get name() { return 'my-model'; } async analyze(image) { return visualContext; } }
//
// image = { width, height, data: RGBA } (the original reference). The result must pass validateContext().
import { validateContext, normalizeContext } from './context.js';

export class VisionProvider {
  get name() { return 'abstract'; }
  // eslint-disable-next-line no-unused-vars
  async analyze(image) { throw new Error('VisionProvider.analyze() not implemented'); }
}

export async function runVision(provider, image) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const raw = await provider.analyze(image);
  const errors = validateContext(raw);
  if (errors.length) throw new Error(`invalid VisualContext from ${provider.name}:\n` + errors.join('\n'));
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { context: normalizeContext(raw), raw, provider: provider.name, ms };
}

// Future providers (not implemented on purpose): ClaudeVisionProvider, OpenAIVisionProvider, GeminiVisionProvider,
// LocalVisionProvider. Each one only has to turn a model answer into a VisualContext JSON.
