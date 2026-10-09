import type { ActorKind, AuditEvent, GateId, Job, JobStatus, StageId, StageState } from './types';
import type { Connectors } from '../connectors/types';
import type { LanguageModel } from '../ai/provider';
import type { PromptTemplate } from '../ai/prompt';
import type { PipelineConfig } from './config';
import type { Clock } from './clock';

export interface StageDef {
  id: StageId;
  /** Label as shown on the workflow diagram. */
  label: string;
  kind: ActorKind;
  /** Stages that must be done (or skipped) first. */
  after: StageId[];
  description: string;
}

/**
 * The workflow. Order and dependencies live here and nowhere else.
 * G2 and G3 both depend on G1 only, so the primary and secondary locales run in parallel.
 * Output waits for both. Nothing reaches a customer without G4.
 */
export const STAGES: StageDef[] = [
  { id: 'intake', label: '1 Brief form', kind: 'rule', after: [], description: 'Required fields stop gaps before any work starts.' },
  { id: 'setup', label: '2 Set up', kind: 'rule', after: ['intake'], description: 'Create the workspace, tasks and deadline.' },
  { id: 'gather_facts', label: '3 Get facts', kind: 'rule', after: ['setup'], description: 'Collect product data, brand facts, channel specs, tone rules and keywords.' },
  { id: 'g1_accept_brief', label: 'G1 Accept brief', kind: 'human', after: ['gather_facts'], description: 'A person approves the message and audience. The master brief is locked.' },
  { id: 'draft', label: '4 AI drafts', kind: 'ai', after: ['g1_accept_brief'], description: 'The model writes variants for each placement, using fact slots only.' },
  { id: 'rule_checks', label: '5 Rule checks', kind: 'rule', after: ['draft'], description: 'Rules check limits, banned words, claims and prices. Failures go back to drafting.' },
  { id: 'g2_approve_primary', label: 'G2 Approve primary', kind: 'human', after: ['rule_checks'], description: 'A writer selects and edits. "Changes required" sends notes back to drafting.' },
  { id: 'g3_approve_secondary', label: 'G3 Approve secondary', kind: 'human', after: ['g1_accept_brief'], description: 'A native editor transcreates from the locked master brief and holds a veto.' },
  { id: 'output', label: '6 Output', kind: 'rule', after: ['g2_approve_primary', 'g3_approve_secondary'], description: 'Stage content, write the ad file, hand off to creative, write the fallback pack.' },
  { id: 'prepublish_qa', label: '7a Pre-publish QA', kind: 'rule', after: ['output'], description: 'Check the staged preview: links, limits, facts, layout direction. Pick a sample for a person.' },
  { id: 'g4_publish', label: 'G4 Publish', kind: 'human', after: ['prepublish_qa'], description: 'A person checks the sample and publishes or schedules.' },
  { id: 'postpublish_check', label: '7b Live check', kind: 'rule', after: ['g4_publish'], description: 'Confirm what is live matches what was approved.' },
  { id: 'report', label: '8 Report', kind: 'rule', after: ['postpublish_check'], description: 'Record times, rounds, edits and errors for the KPI dashboard.' },
];

export const GATES: GateId[] = ['g1_accept_brief', 'g2_approve_primary', 'g3_approve_secondary', 'g4_publish'];

export const isGate = (id: StageId): id is GateId => (GATES as StageId[]).includes(id);

export function stageDef(id: StageId): StageDef {
  const def = STAGES.find((s) => s.id === id);
  if (!def) throw new Error(`Unknown stage ${id}`);
  return def;
}

export function initialStages(): Record<StageId, StageState> {
  return Object.fromEntries(STAGES.map((s) => [s.id, { status: 'pending', attempts: 0 }])) as Record<StageId, StageState>;
}

export const placementKey = (channel: string, locale: string) => `${channel}:${locale}`;

export type AuditFn = (event: Omit<AuditEvent, 'at' | 'jobId'>) => Promise<void>;

export interface StageDeps {
  connectors: Connectors;
  model: LanguageModel;
  config: PipelineConfig;
  clock: Clock;
  template: PromptTemplate;
  audit: AuditFn;
}

export type StageResult =
  | { outcome: 'done'; note?: string }
  | { outcome: 'skipped'; note: string }
  | { outcome: 'retry'; reset: StageId[]; note: string }
  | { outcome: 'failed'; note: string; jobStatus: JobStatus };

export type StageRunner = (job: Job, deps: StageDeps) => Promise<StageResult>;
