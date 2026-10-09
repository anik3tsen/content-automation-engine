import type { Actor, AuditEvent, Brief, ChannelId, GateDecision, Job, Locale, StageId } from './types';
import type { Connectors } from '../connectors/types';
import type { LanguageModel } from '../ai/provider';
import { loadPromptTemplate, type PromptTemplate } from '../ai/prompt';
import { loadPipelineConfig, type PipelineConfig } from './config';
import { systemClock, type Clock } from './clock';
import { AuditLog } from './audit';
import { JobStore } from './job-store';
import { newId } from './ids';
import { STAGES, initialStages, isGate, stageDef, type StageDeps } from './workflow';
import { applyDecision, GateError, NotFoundError } from './gates';
import { KeyedMutex } from './mutex';
import { previewChecks } from '../stages/prepublish-qa';
import { approvedItems } from './approved';
import { RUNNERS } from '../stages';
import { ServiceUnavailableError } from '../connectors/types';

/** A rejected or failed request does not move on. */
const stopped = (job: Job): boolean => job.status === 'rejected' || job.status === 'failed';

export interface EngineOptions {
  connectors: Connectors;
  model: LanguageModel;
  clock?: Clock;
  config?: PipelineConfig;
  template?: PromptTemplate;
  store?: JobStore;
  auditLog?: AuditLog;
}

/**
 * The orchestrator. It runs every automated stage whose dependencies are met,
 * stops at each human gate, and resumes when a person decides.
 * It holds no state of its own: everything is in the Job, saved after every stage and gate.
 */
export class Engine {
  /** One decision at a time per request, so parallel gates cannot overwrite each other. */
  private readonly locks = new KeyedMutex();

  private constructor(
    private readonly connectors: Connectors,
    private readonly model: LanguageModel,
    private readonly clock: Clock,
    readonly config: PipelineConfig,
    private readonly template: PromptTemplate,
    private readonly store: JobStore,
    private readonly auditLog: AuditLog,
  ) {}

  static async create(options: EngineOptions): Promise<Engine> {
    const config = options.config ?? (await loadPipelineConfig());
    const template = options.template ?? (await loadPromptTemplate(config.drafting.promptTemplate));
    return new Engine(
      options.connectors,
      options.model,
      options.clock ?? systemClock,
      config,
      template,
      options.store ?? new JobStore(),
      options.auditLog ?? new AuditLog(),
    );
  }

  // ---------- Public API ----------

  /** Submit a request. Runs every automated stage up to the first gate. */
  async submit(brief: Brief, by: Actor): Promise<Job> {
    const now = this.clock.now().toISOString();
    const job: Job = {
      id: newId('job'),
      createdAt: now,
      updatedAt: now,
      status: 'active',
      mode: this.config.rollout.mode,
      brief,
      stages: initialStages(),
      drafts: [],
      secondary: [],
      reviewRounds: 0,
      reviewNotes: [],
      outputs: [],
      incidents: [],
      counters: { ruleBlocks: 0, sendBacks: 0 },
    };
    await this.log(job, { stage: 'system', actorKind: 'human', actor: by.name, event: 'request submitted', details: { title: brief.title } });
    return this.advance(job);
  }

  /** A person decides at a gate. Invalid decisions throw GateError and change nothing. */
  decide(jobId: string, decision: GateDecision): Promise<Job> {
    return this.locks.run(jobId, async () => {
      const job = await this.mustGet(jobId);
      const note = await applyDecision(job, decision, this.deps(job));
      await this.log(job, {
        stage: decision.gate,
        actorKind: 'human',
        actor: `${decision.actor.name} (${decision.actor.role})`,
        event: `decision: ${decision.action}`,
        details: { note },
      });
      return this.advance(job);
    });
  }

  /**
   * Stage or publish outputs that were deferred while the content store was down.
   * After G4, a recovered entry goes live only if it passes the same preview checks as pre-publish QA.
   */
  retryDeferred(jobId: string, by: Actor): Promise<Job> {
    return this.locks.run(jobId, async () => {
      const job = await this.mustGet(jobId);
      const items = approvedItems(job, this.config);
      let recovered = 0;
      let held = 0;
      for (const out of job.outputs.filter((o) => o.status === 'deferred')) {
        const item = items.find((i) => i.channel.id === out.channel && i.locale === out.locale);
        if (!item) continue;
        try {
          const entry = await this.connectors.contentStore.stage({
            jobId: job.id,
            channel: out.channel,
            locale: out.locale,
            direction: item.direction,
            fields: item.fields,
            landingUrl: job.brief.landingUrl,
            versionHash: out.versionHash,
          });
          out.ref = entry.ref;
          out.error = undefined;
          out.status = 'staged';
          if (job.publish) {
            const checks = await previewChecks(job, out, this.connectors, this.config);
            job.qa?.checks.push(...checks);
            if (checks.some((c) => !c.passed && c.severity === 'block')) {
              held++;
              await this.connectors.notifier.notify({ level: 'alert', jobId: job.id, message: `${out.channel} (${out.locale}) recovered but failed its preview checks. It stays staged.` });
              continue;
            }
            await this.connectors.contentStore.publish(entry.ref, job.publish.scheduledFor);
            out.status = job.publish.action === 'schedule' ? 'scheduled' : 'published';
          }
          recovered++;
        } catch (error) {
          if (!(error instanceof ServiceUnavailableError)) throw error;
        }
      }
      await this.log(job, { stage: 'output', actorKind: 'human', actor: by.name, event: 'retry deferred outputs', details: { recovered, held } });
      if (recovered > 0 || held > 0) {
        if (job.stages.g4_publish.status === 'waiting') this.reset(job, ['prepublish_qa', 'g4_publish']);
        else if (job.stages.report.status === 'done') this.reset(job, ['postpublish_check', 'report']);
        await this.connectors.notifier.notify({ level: 'info', jobId: job.id, message: `${recovered} deferred output(s) recovered, ${held} held` });
      }
      return this.advance(job);
    });
  }

  /**
   * Incident response after a wrong line goes live: go back to the version that was live before
   * (or take the entry down if there was none), list the other outputs of the same request to check,
   * and record the incident. Only live or scheduled entries can be reverted.
   */
  revert(jobId: string, channel: ChannelId, locale: Locale, by: Actor, reason: string): Promise<Job> {
    return this.locks.run(jobId, async () => {
      const job = await this.mustGet(jobId);
      if (!['content_manager', 'admin'].includes(by?.role)) throw new GateError('Only a content manager can revert live content');
      if (!reason?.trim()) throw new GateError('Give the reason for the revert');
      const out = job.outputs.find((o) => o.channel === channel && o.locale === locale && o.target === 'content-store' && o.ref);
      if (!out?.ref) throw new GateError(`No content-store output for ${channel} (${locale})`);
      const entry = await this.connectors.contentStore.get(out.ref);
      if (!entry) throw new GateError('Entry not found in the content store');
      if (entry.status === 'draft') throw new GateError('This entry is not live or scheduled, so there is nothing to revert');

      const earlier = entry.publishedVersions.filter((v) => v < entry.version);
      const previous = [...earlier].reverse().find((v) => entry.versions.find((x) => x.version === v)?.versionHash !== entry.versionHash);
      let action: 'revert' | 'unpublish';
      if (previous !== undefined) {
        const reverted = await this.connectors.contentStore.revert(out.ref, previous);
        out.versionHash = reverted.versionHash;
        action = 'revert';
      } else {
        await this.connectors.contentStore.unpublish(out.ref);
        out.status = 'staged';
        action = 'unpublish';
      }
      const relatedOutputs = job.outputs
        .filter((o) => !(o.channel === channel && o.locale === locale))
        .map((o) => ({ channel: o.channel, locale: o.locale, target: o.target }));
      job.incidents.push({ at: this.clock.now().toISOString(), by: by.name, channel, locale, action, reason, revertedTo: previous, relatedOutputs });
      await this.connectors.notifier.notify({
        level: 'alert',
        jobId: job.id,
        message: `Incident: ${channel} (${locale}) ${action === 'revert' ? `reverted to the copy of version ${previous}` : 'taken down'}. Check ${relatedOutputs.length} related output(s). Reason: ${reason}`,
      });
      await this.log(job, { stage: 'system', actorKind: 'human', actor: by.name, event: `incident: ${action}`, details: { channel, locale, reason } });
      return this.save(job);
    });
  }

  get(id: string): Promise<Job | undefined> {
    return this.store.get(id);
  }

  list(): Promise<Job[]> {
    return this.store.list();
  }

  audit(id: string): Promise<AuditEvent[]> {
    return this.auditLog.read(id);
  }

  // ---------- Orchestration ----------

  private async advance(job: Job): Promise<Job> {
    for (let guard = 0; guard < 100; guard++) {
      if (stopped(job)) break;
      const ready = STAGES.filter(
        (s) => job.stages[s.id].status === 'pending' && s.after.every((dep) => ['done', 'skipped'].includes(job.stages[dep].status)),
      );
      if (ready.length === 0) break;
      for (const def of ready) {
        if (isGate(def.id)) await this.openGate(job, def.id);
        else await this.runStage(job, def.id);
        await this.save(job);
        if (stopped(job)) break;
      }
    }
    return this.save(job);
  }

  private async openGate(job: Job, id: StageId): Promise<void> {
    const state = job.stages[id];
    if (id === 'g3_approve_secondary' && job.secondary.length === 0) {
      Object.assign(state, { status: 'skipped', note: 'no secondary locale on this request' });
      return;
    }
    Object.assign(state, { status: 'waiting', startedAt: this.clock.now().toISOString() });
    const gate = this.config.gates[id as keyof PipelineConfig['gates']];
    await this.connectors.notifier.notify({ level: 'info', jobId: job.id, message: `${gate.label} is waiting for: ${this.config.roles[gate.role]}` });
    await this.log(job, { stage: id, actorKind: 'system', actor: 'engine', event: 'gate opened', details: { role: gate.role } });
  }

  private async runStage(job: Job, id: StageId): Promise<void> {
    const def = stageDef(id);
    const runner = RUNNERS[id];
    if (!runner) throw new Error(`No runner for ${id}`);
    const state = job.stages[id];
    state.status = 'running';
    state.attempts++;
    state.startedAt ??= this.clock.now().toISOString();

    const result = await runner(job, this.deps(job));
    const now = this.clock.now().toISOString();
    switch (result.outcome) {
      case 'done':
        Object.assign(state, { status: 'done', endedAt: now, note: result.note });
        break;
      case 'skipped':
        Object.assign(state, { status: 'skipped', endedAt: now, note: result.note });
        break;
      case 'retry':
        state.note = result.note;
        for (const r of result.reset) job.stages[r].status = 'pending';
        break;
      case 'failed':
        Object.assign(state, { status: 'failed', endedAt: now, note: result.note });
        job.status = result.jobStatus;
        await this.connectors.notifier.notify({ level: 'alert', jobId: job.id, message: `${def.label} failed: ${result.note}` });
        break;
    }
    await this.log(job, { stage: id, actorKind: def.kind, actor: def.kind === 'ai' ? this.model.id : 'engine', event: `stage ${result.outcome}`, details: { note: result.note } });
  }

  private reset(job: Job, ids: StageId[]): void {
    for (const id of ids) job.stages[id] = { status: 'pending', attempts: 0 };
  }

  private deps(job: Job): StageDeps {
    return {
      connectors: this.connectors,
      model: this.model,
      config: this.config,
      clock: this.clock,
      template: this.template,
      audit: (event) => this.log(job, event),
    };
  }

  private async log(job: Job, event: Omit<AuditEvent, 'at' | 'jobId'>): Promise<void> {
    await this.auditLog.append({ at: this.clock.now().toISOString(), jobId: job.id, ...event });
  }

  private async save(job: Job): Promise<Job> {
    job.updatedAt = this.clock.now().toISOString();
    await this.store.save(job);
    return job;
  }

  private async mustGet(id: string): Promise<Job> {
    const job = await this.store.get(id);
    if (!job) throw new NotFoundError(`No request with id ${id}`);
    return job;
  }
}

export { GateError, NotFoundError };
