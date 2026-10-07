// ManualVisionProvider: a hand-written VisualContext. Lets the whole pipeline run without any API.
import { VisionProvider } from './provider.js';

export class ManualVisionProvider extends VisionProvider {
  constructor(context) { super(); this.context = typeof context === 'string' ? JSON.parse(context) : context; }
  get name() { return 'manual'; }
  async analyze() { return JSON.parse(JSON.stringify(this.context)); }
}
