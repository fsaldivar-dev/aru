export interface ProductionBriefOptions { style?: string; material?: MaterialPreset | ''; color?: string; accent?: string; purpose?: string; countMode?: 'additional' | 'total'; history?: { role: string; text: string }[] }
export interface ProjectContext { id?: string | null; name: string; description?: string }
export { listStyles, resolveStyle, productionStatus, synchronizeIconJob, revalidateIconJob } from './node.js';
export type Operation = { op: 'set' | 'material' | 'palette' | 'translate' | 'rename' | 'animate' | 'group' | 'ungroup' | 'duplicate' | 'reuse' | 'delete' | 'reorder' | 'add' | 'canvas' | 'smooth' | 'simplify' | 'weld' | 'connect' | 'redraw'; target?: string; [key: string]: unknown };
export type MaterialPreset = 'neon' | 'chrome' | 'glass' | 'clay' | 'fruits';
export function listMaterials(): { id: MaterialPreset; label: string; color: string; description: string; surface: string }[];
export interface DocumentState { text: string; name?: string; revision: number }
export interface Layer { path: string; parent: string | null; type: string; label: string; semantic: string | null; role: string | null; locked: boolean; hidden: boolean; bounds: number[]; [key: string]: unknown }
export interface Context { version: number; name: string; project: ProjectContext | null; revision?: number; canvas: { width: number; height: number; background: string }; selection: string[]; layers: Layer[]; resources: ResourceEntry[]; boundsMode: string; schema: object; instructions: string; tools: string[]; warnings: unknown[] }
export interface RefinementOptions { mode?: 'style' | 'contour' | 'redraw'; selection?: string[]; expectedRevision?: number }
export interface RefinementPreview { text: string; svg: string; log: unknown[]; changed: string[]; geometryPreserved: boolean; scope: object }
export interface IconExportOptions { group?: string; paths?: string[]; sizes?: number[]; formats?: ('png' | 'svg' | 'aru')[]; cellSize?: number | null; padding?: number; background?: string }
export interface IconArchive { data: Uint8Array; manifest: any; fileCount: number }
export function listIconBatches(text: string): { path: string; label: string; count: number; explicit: boolean }[];
export function prepareIconExports(text: string, options?: IconExportOptions): any;
export function buildIconArchive(text: string, options: IconExportOptions, png?: (scene: any, size: number) => Promise<Uint8Array>): Promise<IconArchive>;
export function refinementScope(text: string, options: RefinementOptions): any;
export const REFINEMENT_SYSTEM: string;
export interface Illustrator {
  setProject(project: ProjectContext | null): ProjectContext | null;
  getDocument(): DocumentState;
  load(text: string, options?: { name?: string }): DocumentState;
  replacePrepared(text: string): DocumentState;
  select(paths: string[]): string[];
  context(): Context;
  preview(operations: Operation[]): { text: string; svg: string; log: unknown[] };
  apply(operations: Operation[], options?: { expectedRevision?: number }): { text: string; revision: number; log: unknown[] };
  previewRefinement(operations: Operation[], options?: RefinementOptions): RefinementPreview;
  refine(operations: Operation[], options?: RefinementOptions): RefinementPreview & DocumentState;
  insert(fragment: string, options?: { label?: string; at?: [number, number]; scale?: number; opaque?: boolean; fit?: boolean; into?: string }): { text: string; revision: number; selection?: string[] };
  insertScene(scene: object, options?: { label?: string; at?: [number, number]; scale?: number; fit?: boolean }): { text: string; revision: number; selection: string[] };
  svg(options?: { animate?: boolean }): string;
  undo(): boolean;
  redo(): boolean;
}
export function createIllustrator(options?: { text?: string; name?: string; project?: ProjectContext | null; selection?: string[]; onChange?: (document: DocumentState) => void; measureBounds?: (node: object) => number[] }): Illustrator;
export function documentContext(text: string, options?: { name?: string; project?: ProjectContext | null; selection?: string[]; measureBounds?: (node: object) => number[] }): Context;
export function readDocument(text: string): { scene: any; errors: any[]; warnings: any[]; [key: string]: unknown };
export const EMPTY_DOCUMENT: string;
export const ANSWER_SCHEMA: object;
export function systemPrompt(options?: { illustrator?: boolean }): string;
export class AruError extends Error { details: unknown }
export interface AgentTransport { detect?(): unknown | Promise<unknown>; run?(request: any): any | Promise<any>; cancel?(request: { runId: string }): unknown | Promise<unknown> }
export interface EditorMount {
  setProject(project: ProjectContext | null): Promise<ProjectContext | null>;
  getProduction(): Promise<import('./node.js').IconProductionJob | null>;
  stopProduction(): Promise<boolean>;
  revalidateProduction(job?: import('./node.js').IconProductionJob): Promise<import('./node.js').IconProductionJob>;
  resumeProduction(job?: import('./node.js').IconProductionJob): Promise<DocumentState & { report: any }>;
  element: HTMLIFrameElement; ready: Promise<EditorMount>;
  load(text: string, name?: string): Promise<DocumentState>;
  getDocument(): Promise<DocumentState>; context(): Promise<Context>;
  select(paths: string[]): Promise<string[]>;
  apply(operations: Operation[], options?: { expectedRevision?: number }): Promise<DocumentState>;
  preview(operations: Operation[]): Promise<{ text: string; svg: string; log: unknown[] }>;
  refine(operations: Operation[], options?: RefinementOptions): Promise<DocumentState & { changed: string[]; geometryPreserved: boolean }>;
  exportIcons(options?: IconExportOptions): Promise<IconArchive>;
  insert(text: string, options?: { label?: string; into?: string }): Promise<DocumentState>;
  trace(image: { mime: string; data: string; name?: string }, reference?: Record<string, unknown>): Promise<DocumentState>;
  ask(message: string, options?: ProductionBriefOptions & {
    /** Omit to retain the existing ask behavior. */
    mode?: 'create' | 'refine' | 'consult';
    kind?: 'illustration' | 'app-icon' | 'icon-pack';
    /** Number of new icons for kind='icon-pack': integer from 1 to 1000. */
    quantity?: number;
    provider?: string; model?: string; review?: number; illustrator?: boolean;
    refine?: 'off' | 'style' | 'contour' | 'redraw';
    images?: { name?: string; mime: string; data: string }[];
  }): Promise<DocumentState & { report: any }>;
  svg(): Promise<string>; png(): Promise<string>; undo(): Promise<DocumentState>; redo(): Promise<DocumentState>; destroy(): void;
}
export function mountEditor(container: HTMLElement, options?: { text?: string; name?: string; project?: ProjectContext | null; studioUrl?: string | URL; onChange?: (document: DocumentState) => void; onProduction?: (checkpoint: { job: import('./node.js').IconProductionJob; document: DocumentState }) => void; agents?: AgentTransport; timeout?: number }): EditorMount;

export interface ResourceMetadata { key?: string; kind: 'app-icon' | 'logo' | 'ui-icon' | 'illustration' | 'character' | 'other'; brand?: string; purpose?: string; identity?: string; tags: string[]; reusable: boolean; source?: string }
export interface ResourceEntry extends ResourceMetadata { path: string; label: string; locked: boolean; hidden: boolean }
export function normalizeResource(value: Partial<ResourceMetadata>): ResourceMetadata;
export function listResources(scene: any, filters?: {tag?: string; brand?: string; kind?: string; query?: string}): ResourceEntry[];
export const RESOURCE_KINDS: Record<ResourceMetadata['kind'], string>;
