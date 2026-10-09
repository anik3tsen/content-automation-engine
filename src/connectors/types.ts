// Connector contracts. The pipeline talks only to these interfaces.
// The local adapters in ./local make the app run with no external systems.
// To connect a real system, implement the interface and register it in ./index.ts.

import type {
  BrandFactCard,
  ChannelId,
  ChannelSpec,
  Job,
  JobReport,
  Locale,
  ProductRecord,
  ToneProfile,
} from '../core/types';

/** Creates the working area for a request: folder, tasks, deadline. */
export interface WorkspaceProvisioner {
  create(job: Job, deadline: string): Promise<{ folder: string; tasks: string[] }>;
}

/** Product data. The single source for price, material and availability. */
export interface ProductCatalog {
  getMany(ids: string[]): Promise<ProductRecord[]>;
}

/** The rulebook: brand fact cards, tone rules, banned words, material lexicon, rejected phrases. */
export interface Rulebook {
  brand(brandId: string): Promise<BrandFactCard | undefined>;
  tone(profile: string, locale: Locale): Promise<ToneProfile | undefined>;
  bannedWords(locale: Locale): Promise<string[]>;
  materialLexicon(): Promise<string[]>;
  negativeExamples(locale: Locale): Promise<string[]>;
}

/** The channel specification library: limits, register, CTA policy per channel. */
export interface ChannelLibrary {
  all(): Promise<ChannelSpec[]>;
  get(ids: ChannelId[]): Promise<ChannelSpec[]>;
}

/** Search and performance keywords for a brand or category. */
export interface KeywordSource {
  forBrand(brandId: string): Promise<string[]>;
}

export interface ContentEntryInput {
  jobId: string;
  channel: ChannelId;
  locale: Locale;
  direction: 'ltr' | 'rtl';
  fields: Record<string, string>;
  landingUrl: string;
  versionHash: string;
}

export interface StoredEntry extends ContentEntryInput {
  ref: string;
  status: 'draft' | 'scheduled' | 'published';
  version: number;
  /** Every version that went live or was scheduled, oldest first. Revert goes back to the one before the current. */
  publishedVersions: number[];
  versions: { version: number; versionHash: string; fields: Record<string, string>; at: string }[];
  scheduledFor?: string;
  publishedVersionHash?: string;
}

export interface RenderedPreview {
  ref: string;
  html: string;
  lang: string;
  dir: 'ltr' | 'rtl';
  links: string[];
}

/** Where web and app content is staged, previewed, scheduled and published. Keeps version history. */
export interface ContentStore {
  stage(entry: ContentEntryInput): Promise<StoredEntry>;
  preview(ref: string): Promise<RenderedPreview>;
  publish(ref: string, scheduledFor?: string): Promise<StoredEntry>;
  get(ref: string): Promise<StoredEntry | undefined>;
  revert(ref: string, toVersion: number): Promise<StoredEntry>;
  /** Take an entry off the live site. The previous content stays in place. */
  unpublish(ref: string): Promise<StoredEntry>;
}

export interface AdRow {
  channel: ChannelId;
  locale: Locale;
  fields: Record<string, string>;
  landingUrl: string;
}

/** Produces the bulk-upload file for the ad platform. */
export interface AdExport {
  write(jobId: string, rows: AdRow[]): Promise<string>;
  /** True when the reference returned by write() is still delivered. */
  verify(ref: string): Promise<boolean>;
}

export interface HandoffItem {
  channel: ChannelId;
  locale: Locale;
  direction: 'ltr' | 'rtl';
  fields: Record<string, string>;
}

/** Sends approved copy to design and social production. */
export interface CreativeHandoff {
  send(jobId: string, items: HandoffItem[]): Promise<string>;
  /** True when the reference returned by send() is still delivered. */
  verify(ref: string): Promise<boolean>;
}

/** Keeps a copy of all approved content outside the content store, so an outage cannot block a launch. */
export interface FallbackStore {
  write(jobId: string, pack: unknown): Promise<string>;
}

export interface Notification {
  level: 'info' | 'warn' | 'alert';
  jobId: string;
  message: string;
}

/** Tells people when a gate opens, a workflow fails, or an output is deferred. */
export interface Notifier {
  notify(n: Notification): Promise<void>;
}

/** Receives the per-request metrics for the KPI dashboard. */
export interface MetricsSink {
  record(report: JobReport): Promise<void>;
}

export interface Connectors {
  workspace: WorkspaceProvisioner;
  catalog: ProductCatalog;
  rulebook: Rulebook;
  channels: ChannelLibrary;
  keywords: KeywordSource;
  contentStore: ContentStore;
  adExport: AdExport;
  creative: CreativeHandoff;
  fallback: FallbackStore;
  notifier: Notifier;
  metrics: MetricsSink;
}

/** Thrown by any connector when its system cannot be reached. */
export class ServiceUnavailableError extends Error {
  constructor(service: string) {
    super(`${service} is unavailable`);
    this.name = 'ServiceUnavailableError';
  }
}
