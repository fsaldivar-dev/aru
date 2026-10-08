import type { Illustrator, DocumentState, RefinementOptions, IconExportOptions, IconArchive, ProductionBriefOptions } from './index.js';
export interface RawImage { width: number; height: number; data: Uint8ClampedArray }
export function loadReference(file: string | Uint8Array): Promise<RawImage>;
export function rasterize(scene: object, width?: number, height?: number): Promise<RawImage>;
export function renderPng(text: string, options?: { width?: number }): Promise<Uint8Array>;
export function traceInto(session: Illustrator, image: string | Uint8Array, reference?: Record<string, unknown>, options?: { progress?: Function; tune?: object; assignments?: object[] }): Promise<DocumentState & { report: any; attempts: any[]; grouped: any }>;
export function askIllustrator(session: Illustrator, options: ProductionBriefOptions & { message: string; provider?: string; model?: string; images?: (string | Uint8Array)[]; history?: object[]; review?: number; illustrator?: boolean; insertInto?: string; transport?: { run: Function }; progress?: Function }): Promise<DocumentState & { report: any }>;
export function detect(): { id: string; name: string; installed: boolean; version: string | null; models?: {id:string;label:string}[]; modelSource?: string }[];
export function run(request: any): Promise<any>;
export function cancel(runId: string): boolean;
export interface IconProductionJob { version: 1; brief?: ProductionBriefOptions & { styleProfile?: StyleProfile | null }; requested?: number; existing?: IconProductionJob['accepted']; inventoryReady?: boolean; nextIcon?: number; qualityReview?: object; id: string; message: string; target: number; batchSize: number; context?: string; images?: { name: string; mime: string; data: string }[]; status: 'running' | 'paused' | 'complete'; accepted: { id: string; label: string; purpose: string; aru: string; signature: string; visualSignature?: string | null }[]; attempts: number; reason: string; documentKey: string | null; issues: { label: string; reason: string }[] }
export function requestedIconCount(message: string): number | null;
export function createIconJob(message: string, options?: ProductionBriefOptions & { target?: number; batchSize?: number }): IconProductionJob;
export function verifyIconJob(job: IconProductionJob, text: string): number;
export function produceIcons(session: Illustrator, options: ProductionBriefOptions & { review?: number; message?: string; job?: IconProductionJob; provider?: string; model?: string; transport?: { run: Function; cancel?: Function }; signal?: AbortSignal; checkpoint?: (job: IconProductionJob, text: string) => Promise<void>; progress?: (job: IconProductionJob) => void }): Promise<DocumentState & { report: { production: IconProductionJob; complete: boolean; reply: string } }>;
export interface StyleProfile { id: string; name: string; family: string; cues: string[]; avoid: string[]; note: string; requested: string }
export function listStyles(): (Omit<StyleProfile, 'requested'> & { aliases: string[]; sources: string[] })[];
export function resolveStyle(style: string): StyleProfile | null;
export interface DiscoveryOptions { repo: string; style: string; provider?: string; model?: string; review?: number; visual?: boolean; previous?: string; feedback?: string; resource?: Function; transport?: { run: Function }; progress?: Function }
export function discoverProject(options: DiscoveryOptions): Promise<{ project: object; style: string; styleProfile: StyleProfile | null; userFeedback: string; purpose: string; audience: string; uncertainty: string; sources: { url: string; title: string; insight: string }[]; directions: { name: string; metaphor: string; rationale: string }[]; chosen: number; brief: string; visualQueries: string[]; visual?: { images: { id: number; data: string; sourceURL: string; imageURL: string; sha256: string; observations: string; use: string }[]; [key: string]: any }; observedReferenceImages?: number; evidence: object[]; usage: object; ms: number; mode: string; suppliedImages: number }>;
export function discoverIllustration(options: DiscoveryOptions): Promise<DocumentState & { report: any }>;
export function reviewDiscoveredIllustration(text: string, options: { discovery: any; provider?: string; model?: string; review?: number; transport?: { run: Function }; progress?: Function }): Promise<{ text: string; quality: any }>;

export interface IconExplorationOptions {
  subjects: string[];
  styles: string[];
  /** UI controls (default) are foreground assets; illustrated retains rich opaque artwork. */
  usage?: 'ui-controls' | 'illustrated';
  provider?: string;
  model?: string;
  review?: 0 | 1;
  concurrency?: 1 | 2;
  outputDir?: string;
  discovery?: any;
  transport?: { run: Function };
  resource?: Function;
  progress?: (phase: string, status: string | number) => void;
  checkpoint?: (report: IconExplorationReport) => void | Promise<void>;
}
export interface IconExplorationReport {
  version: 1;
  mode: 'reference-guided-style-exploration';
  usage: 'ui-controls' | 'illustrated';
  cellSize: 48 | 336;
  complete: boolean;
  subjects: { id: string; label: string; brief: string; features: string[]; references: any[] }[];
  referenceSheets: { name: string; sha256: string; file?: string; references: any[] }[];
  discovery: any;
  styles: { id: string; label: string; profile: StyleProfile; status: 'pending' | 'generating' | 'accepted' | 'needs-review' | 'unreviewed' | 'failed'; text?: string; file?: string; png?: string; previews?: string; instruments?: { id: string; label: string; text?: string; aru?: string; svg?: string; png?: string; preview24?: string; preview32?: string; geometryHash: string }[]; quality?: any; generation?: any; attempts?: any[]; error?: string; sameGeometryAs?: string; warning?: string }[];
}
/** Researches actual subjects before producing independently drawn editable variants; optional outputDir saves references and partial reports. */
export function exploreIconStyles(options: IconExplorationOptions): Promise<IconExplorationReport>;

export function exportIconArchive(text: string, options?: IconExportOptions): Promise<IconArchive>;
export function refineIllustration(session: Illustrator, options: { message: string; mode?: 'style' | 'contour' | 'redraw'; provider?: string; model?: string; history?: object[]; signal?: AbortSignal; transport?: { run: Function; cancel?: Function }; progress?: Function }): Promise<DocumentState & { report: { reply: string; operations: object[]; changed: string[]; geometryPreserved: boolean; scope: object; usage: object; ms: number; attempts: number; repaired: boolean; repairError: string | null }; changed: string[]; geometryPreserved: boolean }>;

export interface ProductionStatus { valid: boolean; count: number; target: number; existing?: number; status: string; reason?: string; missing?: string[]; modified?: string[] }
export function productionStatus(job: IconProductionJob, text: string): ProductionStatus;
export function synchronizeIconJob(job: IconProductionJob, text: string): number;
export function revalidateIconJob(job: IconProductionJob, text: string, options?: { rasterize?: typeof rasterize }): Promise<ProductionStatus>;
