import type { ChannelSpec, GateDecision, GateId, Job, PlacementDraft, StageId } from './types';
import type { StageDeps } from './workflow';
import { placementKey } from './workflow';
import { hashOf } from './ids';
import { checkCopy, hasBlocking } from '../rules/copy-rules';
import { editRatio } from '../rules/text';
import { ServiceUnavailableError } from '../connectors/types';

/** A decision that the workflow refuses. The message says what the person must do instead. */
export class GateError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(details.length ? `${message}: ${details.join('; ')}` : message);
    this.name = 'GateError';
  }
}

/** A request id that does not exist. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** The actions each gate accepts. Anything else is refused. */
const ACTIONS: Record<GateId, string[]> = {
  g1_accept_brief: ['approve', 'reject'],
  g2_approve_primary: ['approve', 'changes_required'],
  g3_approve_secondary: ['approve', 'veto'],
  g4_publish: ['publish', 'schedule', 'send_back'],
};

const SEND_BACK_TO: StageId[] = ['g2_approve_primary', 'g3_approve_secondary'];

const joinFields = (f: Record<string, string>) => Object.keys(f).sort().map((k) => f[k]).join('\n');

/** Keep only the channel's own fields, trimmed. Unknown field names never reach an output. */
function onlyChannelFields(channel: ChannelSpec, fields: Record<string, string>): Record<string, string> {
  const names = channel.fields.map((f) => f.name);
  return Object.fromEntries(Object.entries(fields).filter(([k]) => names.includes(k)).map(([k, v]) => [k, String(v).trim()]));
}

function reset(job: Job, ids: StageId[]): void {
  for (const id of ids) job.stages[id] = { status: 'pending', attempts: 0 };
}

function close(job: Job, gate: StageId, at: string, note: string): void {
  Object.assign(job.stages[gate], { status: 'done', endedAt: at, note });
}

/**
 * Apply a person's decision at a gate. The rules here are the controls:
 * - only the named role can decide at each gate, and only while the gate is open;
 * - nobody can approve copy that fails a blocking rule;
 * - the secondary locale is approved by its native editor, with a veto;
 * - nothing is published while pre-publish QA has a blocking issue or the sample is unchecked.
 * Returns a note for the audit trail.
 */
export async function applyDecision(job: Job, d: GateDecision, deps: StageDeps): Promise<string> {
  const { config, clock, connectors } = deps;
  const now = clock.now().toISOString();
  const gate = config.gates[d.gate];

  if (!gate) throw new GateError(`Unknown gate "${String(d.gate)}"`);
  if (!ACTIONS[d.gate].includes(d.action)) throw new GateError(`${gate.label} has no action "${String(d.action)}"`);
  if (!d.actor?.role || !d.actor.name) throw new GateError('Say who is deciding: actor name and role');
  if (job.status !== 'active') throw new GateError(`This request is ${job.status}`);
  if (job.stages[d.gate].status !== 'waiting') throw new GateError(`${gate.label} is not open (it is ${job.stages[d.gate].status})`);
  if (d.actor.role !== gate.role) throw new GateError(`${gate.label} needs the role "${config.roles[gate.role]}"`);

  switch (d.gate) {
    case 'g1_accept_brief': {
      if (d.action === 'reject') {
        if (!d.notes?.trim()) throw new GateError('Say why the brief is rejected');
        job.status = 'rejected';
        Object.assign(job.stages.g1_accept_brief, { status: 'failed', endedAt: now, note: d.notes });
        return `brief rejected: ${d.notes}`;
      }
      job.master = { lockedAt: now, lockedBy: d.actor.name, hash: hashOf({ brief: job.brief, context: job.context }) };
      close(job, 'g1_accept_brief', now, `master brief locked (${job.master.hash})`);
      return `master brief locked by ${d.actor.name}`;
    }

    case 'g2_approve_primary': {
      if (d.action === 'changes_required') {
        if (!d.notes?.trim()) throw new GateError('Write the changes you need');
        job.reviewRounds++;
        job.reviewNotes.push(d.notes);
        job.drafts = [];
        reset(job, ['draft', 'rule_checks', 'g2_approve_primary']);
        return `changes required (round ${job.reviewRounds}): ${d.notes}`;
      }
      const ctx = job.context!;
      const primary = config.locales.primary;
      const manualOnly = !config.rollout.aiDrafting || job.mode === 'shadow';
      const problems: string[] = [];
      const updates: PlacementDraft[] = [];

      for (const channel of ctx.channels) {
        const key = placementKey(channel.id, primary);
        const sel = d.selections?.[key];
        const placement: PlacementDraft = job.drafts.find((p) => p.channel === channel.id && p.locale === primary) ?? { channel: channel.id, locale: primary, variants: [] };
        if (!sel) { problems.push(`${key}: no copy selected`); continue; }
        if (manualOnly && !sel.fields) { problems.push(`${key}: write the copy (${job.mode === 'shadow' ? 'shadow mode' : 'manual path'})`); continue; }

        const variant = !manualOnly && sel.variantId ? placement.variants.find((v) => v.id === sel.variantId) : undefined;
        if (!manualOnly && sel.variantId && !variant) { problems.push(`${key}: unknown variant ${sel.variantId}`); continue; }
        const final = sel.fields ?? variant?.fields;
        if (!final) { problems.push(`${key}: select a variant or write the copy`); continue; }

        const clean = onlyChannelFields(channel, final);
        const violations = checkCopy({ fields: clean, channel, locale: primary, primary: true, ctx, brief: job.brief, bannedWords: ctx.bannedWords });
        if (hasBlocking(violations)) {
          problems.push(...violations.filter((v) => v.severity === 'block').map((v) => `${key} ${v.field ?? ''}: ${v.message}`));
          continue;
        }
        const reference = variant ?? placement.variants.find((v) => !hasBlocking(v.violations));
        // The edit ratio compares the final copy with the selected variant, or in shadow mode with the best AI draft.
        const ratio = reference ? editRatio(joinFields(reference.fields), joinFields(clean)) : undefined;
        updates.push({
          ...placement,
          selectedVariantId: variant?.id,
          final: clean,
          finalSource: manualOnly || !variant ? 'human' : ratio === 0 ? 'ai-selected' : 'ai-edited',
          editRatio: ratio,
        });
      }
      if (problems.length) throw new GateError('The copy cannot be approved yet', problems);
      job.drafts = [...job.drafts.filter((p) => p.locale !== primary), ...updates];
      close(job, 'g2_approve_primary', now, `${updates.length} placements approved by ${d.actor.name}`);
      return `primary copy approved: ${updates.map((u) => `${u.channel} (${u.finalSource})`).join(', ')}`;
    }

    case 'g3_approve_secondary': {
      const work = job.secondary.find((s) => s.locale === d.locale);
      if (!work) throw new GateError(`No ${d.locale} work on this request`);
      if (d.action === 'veto') {
        if (!d.notes?.trim()) throw new GateError('Say what must change');
        work.status = 'returned';
        work.history.push({ at: now, action: 'veto', by: d.actor.name, notes: d.notes });
        await connectors.notifier.notify({ level: 'warn', jobId: job.id, message: `${d.locale} copy vetoed by ${d.actor.name}: ${d.notes}` });
        return `${d.locale} vetoed: ${d.notes}`;
      }
      const ctx = job.context!;
      const banned = await connectors.rulebook.bannedWords(d.locale);
      const problems: string[] = [];
      const cleaned: Record<string, Record<string, string>> = {};
      for (const channel of ctx.channels) {
        const fields = onlyChannelFields(channel, d.fields?.[channel.id] ?? {});
        cleaned[channel.id] = fields;
        const violations = checkCopy({ fields, channel, locale: d.locale, primary: false, ctx, brief: job.brief, bannedWords: banned });
        problems.push(...violations.filter((v) => v.severity === 'block').map((v) => `${channel.id} ${v.field ?? ''}: ${v.message}`));
      }
      const unchecked = config.secondaryChecklist.filter((item) => !d.checklist?.[item]);
      if (unchecked.length) problems.push(`checklist not complete: ${unchecked.join('; ')}`);
      if (problems.length) throw new GateError(`The ${d.locale} copy cannot be approved yet`, problems);

      work.fields = cleaned;
      work.checklist = d.checklist;
      work.editor = d.actor.name;
      work.status = 'approved';
      work.history.push({ at: now, action: 'approve', by: d.actor.name });
      if (job.secondary.every((s) => s.status === 'approved')) close(job, 'g3_approve_secondary', now, `approved by ${d.actor.name}`);
      return `${d.locale} copy approved by ${d.actor.name}`;
    }

    case 'g4_publish': {
      if (d.action === 'send_back') {
        if (!d.notes?.trim()) throw new GateError('Say what must change');
        if (!SEND_BACK_TO.includes(d.to)) throw new GateError('Send back to G2 or G3 only');
        job.counters.sendBacks++;
        if (d.to === 'g2_approve_primary') {
          job.reviewNotes.push(d.notes);
          job.drafts = job.drafts.map((p) => ({ ...p, final: undefined, finalSource: undefined, editRatio: undefined, selectedVariantId: undefined }));
        } else {
          for (const work of job.secondary) {
            work.status = 'returned';
            work.history.push({ at: now, action: 'veto', by: d.actor.name, notes: d.notes });
          }
        }
        job.qa = undefined;
        reset(job, [d.to, 'output', 'prepublish_qa', 'g4_publish']);
        return `sent back to ${config.gates[d.to].label}: ${d.notes}`;
      }
      if (!job.qa) throw new GateError('Pre-publish QA has not run');
      if (job.qa.blocking > 0) throw new GateError(`Pre-publish QA has ${job.qa.blocking} blocking issue(s). Send the copy back to fix them`);
      if (!d.sampleChecked) throw new GateError('Check the sample before you publish');
      if (d.action === 'schedule' && !(d.scheduledFor && new Date(d.scheduledFor) > clock.now())) {
        throw new GateError('Give a future date and time to schedule');
      }
      const scheduledFor = d.action === 'schedule' ? d.scheduledFor : undefined;
      const next = d.action === 'schedule' ? 'scheduled' : 'published';
      for (const out of job.outputs) {
        if (out.status === 'deferred') continue;
        if (out.target === 'content-store' && out.ref) {
          try {
            await connectors.contentStore.publish(out.ref, scheduledFor);
            out.status = next;
          } catch (error) {
            if (!(error instanceof ServiceUnavailableError)) throw error;
            out.status = 'deferred';
            out.error = error.message;
          }
        } else {
          out.status = next;
        }
      }
      job.publish = { by: d.actor.name, at: now, action: d.action, scheduledFor };
      job.status = next;
      close(job, 'g4_publish', now, `${next} by ${d.actor.name}`);
      return `${next} by ${d.actor.name}${scheduledFor ? ` for ${scheduledFor}` : ''}`;
    }
  }
}
