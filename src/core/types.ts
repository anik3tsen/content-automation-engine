// Domain model for the content automation pipeline.
// Every stage reads and writes a Job. Nothing else carries state.

export type Locale = string;
export type ChannelId = string;

/** Who performs a step: a deterministic rule, an AI model, or a person. */
export type ActorKind = 'rule' | 'ai' | 'human';

export type RolloutMode = 'shadow' | 'assisted' | 'default';

export type RoleId =
  | 'requester'
  | 'content_project_lead'
  | 'content_manager'
  | 'native_editor'
  | 'admin';

export interface Actor {
  name: string;
  role: RoleId;
}

// ---------- Inputs ----------

/** The structured request. Required fields stop gaps at intake. */
export interface Brief {
  title: string;
  requester: string;
  brandId: string;
  productIds: string[];
  objective: string;
  audience: string;
  offer?: string;
  keyMessage: string;
  tone: string;
  cta?: string;
  channels: ChannelId[];
  locales: Locale[];
  launchAt: string;
  landingUrl: string;
}

export interface FieldSpec {
  name: string;
  maxChars: number;
  required: boolean;
  /** 'platform' = published platform limit. 'assumed' = confirm against your content model. */
  limitSource: 'platform' | 'assumed';
}

export interface ChannelSpec {
  id: ChannelId;
  label: string;
  register: string;
  output: OutputTarget;
  variants: number;
  ctaPolicy: 'required' | 'soft' | 'none';
  allowedCtas: string[];
  keywordLed: boolean;
  fields: FieldSpec[];
}

export type OutputTarget = 'content-store' | 'ad-export' | 'creative-handoff';

export interface ProductRecord {
  id: string;
  brandId: string;
  name: string;
  category: string;
  materials: string[];
  composition: string;
  price: { amount: number; currency: string };
  url: string;
  available: boolean;
}

export interface BrandFactCard {
  brandId: string;
  name: string;
  approvedClaims: string[];
  facts: Record<string, string>;
}

export interface ToneProfile {
  do: string[];
  dont: string[];
}

/** Everything the system gathered for one request. Locked at G1. */
export interface FactContext {
  brand: BrandFactCard;
  products: ProductRecord[];
  channels: ChannelSpec[];
  tone: ToneProfile;
  keywords: string[];
  bannedWords: string[];
  materialLexicon: string[];
  negativeExamples: string[];
}

// ---------- Drafts and checks ----------

export interface Violation {
  rule: string;
  field?: string;
  message: string;
  severity: 'block' | 'warn';
}

/** Provenance stamped on every AI output. */
export interface Trace {
  promptVersion: string;
  modelId: string;
  modelVersion: string;
  inputHash: string;
}

export interface Variant {
  id: string;
  /** Text as written by the model, with fact slots still in place. */
  raw: Record<string, string>;
  /** Text after fact insertion. This is what rules and people check. */
  fields: Record<string, string>;
  source: 'ai' | 'human';
  attempt: number;
  violations: Violation[];
  trace?: Trace;
}

export interface PlacementDraft {
  channel: ChannelId;
  locale: Locale;
  variants: Variant[];
  selectedVariantId?: string;
  /** Final approved text for this placement. */
  final?: Record<string, string>;
  finalSource?: 'ai-selected' | 'ai-edited' | 'human';
  /** 0 = unchanged from the selected AI variant, 1 = fully rewritten. */
  editRatio?: number;
}

export interface SecondaryLocaleWork {
  locale: Locale;
  direction: 'ltr' | 'rtl';
  status: 'waiting' | 'returned' | 'approved';
  /** Copy per channel, written by the native editor from the locked master brief. */
  fields: Record<ChannelId, Record<string, string>>;
  checklist: Record<string, boolean>;
  /** Optional AI draft for the editor, written from the master brief. Off unless aiAssist is on and the model supports the locale. */
  assist?: Record<ChannelId, Record<string, string>>;
  assistTrace?: Trace;
  editor?: string;
  history: { at: string; action: 'veto' | 'approve'; by: string; notes?: string }[];
}

// ---------- Outputs and QA ----------

export interface OutputRecord {
  channel: ChannelId;
  locale: Locale;
  target: OutputTarget;
  status: 'staged' | 'written' | 'deferred' | 'published' | 'scheduled' | 'failed';
  ref?: string;
  versionHash: string;
  previewUrl?: string;
  error?: string;
}

export interface QaCheck {
  check: string;
  channel?: ChannelId;
  locale?: Locale;
  passed: boolean;
  severity: 'block' | 'warn';
  message: string;
}

export interface QaReport {
  at: string;
  checks: QaCheck[];
  blocking: number;
  warnings: number;
  /** Items a person must look at before publishing. */
  humanSample: { channel: ChannelId; locale: Locale }[];
}

export interface JobReport {
  jobId: string;
  mode: RolloutMode;
  turnaroundHours: number | null;
  stageMinutes: Record<string, number>;
  reviewRounds: number;
  sendBacks: number;
  firstPassAcceptance: number | null;
  /** Shadow mode: how close the hand-written copy was to the best AI draft (1 = identical). */
  shadowSimilarity: number | null;
  ruleBlocksCaught: number;
  errorsAtPublish: number;
  aiAssistedPlacements: number;
  humanWrittenPlacements: number;
  outputs: { channel: ChannelId; locale: Locale; status: OutputRecord['status'] }[];
}

// ---------- Workflow state ----------

export type StageId =
  | 'intake'
  | 'setup'
  | 'gather_facts'
  | 'g1_accept_brief'
  | 'draft'
  | 'rule_checks'
  | 'g2_approve_primary'
  | 'g3_approve_secondary'
  | 'output'
  | 'prepublish_qa'
  | 'g4_publish'
  | 'postpublish_check'
  | 'report';

export type GateId = Extract<
  StageId,
  'g1_accept_brief' | 'g2_approve_primary' | 'g3_approve_secondary' | 'g4_publish'
>;

export type StageStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';

export interface StageState {
  status: StageStatus;
  attempts: number;
  startedAt?: string;
  endedAt?: string;
  note?: string;
}

export type JobStatus = 'active' | 'published' | 'scheduled' | 'rejected' | 'failed';

export interface Job {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  mode: RolloutMode;
  brief: Brief;
  stages: Record<StageId, StageState>;
  workspace?: { folder: string; tasks: string[]; deadline: string };
  context?: FactContext;
  /** The brief and facts, frozen at G1. Every later stage works from this. */
  master?: { lockedAt: string; lockedBy: string; hash: string };
  drafts: PlacementDraft[];
  secondary: SecondaryLocaleWork[];
  reviewRounds: number;
  reviewNotes: string[];
  outputs: OutputRecord[];
  fallbackPack?: string;
  qa?: QaReport;
  publish?: { by: string; at: string; action: 'publish' | 'schedule'; scheduledFor?: string };
  postCheck?: QaReport;
  report?: JobReport;
  incidents: Incident[];
  counters: { ruleBlocks: number; sendBacks: number };
}

/** A correction after publishing, for example a revert after a wrong claim went live. */
export interface Incident {
  at: string;
  by: string;
  channel: ChannelId;
  locale: Locale;
  action: 'revert' | 'unpublish';
  reason: string;
  revertedTo?: number;
  /** Other outputs from the same request, found through the job ID, to check for the same problem. */
  relatedOutputs: { channel: ChannelId; locale: Locale; target: OutputTarget }[];
}

// ---------- Gate decisions ----------

export type GateDecision =
  | { gate: 'g1_accept_brief'; action: 'approve'; actor: Actor }
  | { gate: 'g1_accept_brief'; action: 'reject'; actor: Actor; notes: string }
  | {
      gate: 'g2_approve_primary';
      action: 'approve';
      actor: Actor;
      /** key = `${channel}:${locale}` */
      selections: Record<string, { variantId?: string; fields?: Record<string, string> }>;
    }
  | { gate: 'g2_approve_primary'; action: 'changes_required'; actor: Actor; notes: string }
  | {
      gate: 'g3_approve_secondary';
      action: 'approve';
      actor: Actor;
      locale: Locale;
      fields: Record<ChannelId, Record<string, string>>;
      checklist: Record<string, boolean>;
    }
  | { gate: 'g3_approve_secondary'; action: 'veto'; actor: Actor; locale: Locale; notes: string }
  | {
      gate: 'g4_publish';
      action: 'publish' | 'schedule';
      actor: Actor;
      sampleChecked: boolean;
      scheduledFor?: string;
    }
  | {
      gate: 'g4_publish';
      action: 'send_back';
      actor: Actor;
      to: 'g2_approve_primary' | 'g3_approve_secondary';
      notes: string;
    };

// ---------- Audit ----------

export interface AuditEvent {
  at: string;
  jobId: string;
  stage: StageId | 'system';
  actorKind: ActorKind | 'system';
  actor: string;
  event: string;
  details?: Record<string, unknown>;
}
