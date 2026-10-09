import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from './helpers';
import { PEOPLE, editorPlaceholders, fullChecklist, sampleBrief, selectPassing } from '../src/cli/fixtures';
import { MockModel } from '../src/ai/mock-model';
import { Engine } from '../src/core/engine';
import { readJsonl } from '../src/core/fsutil';
import { runtimeDir } from '../src/core/paths';
import type { GateDecision, Job } from '../src/core/types';

type Env = Awaited<ReturnType<typeof makeEngine>>;

async function toGates(env: Env): Promise<Job> {
  const job = await env.engine.submit(await sampleBrief(env.clock), PEOPLE.requester);
  return env.engine.decide(job.id, { gate: 'g1_accept_brief', action: 'approve', actor: PEOPLE.lead });
}
const g2 = (env: Env, job: Job, edits = {}) =>
  env.engine.decide(job.id, { gate: 'g2_approve_primary', action: 'approve', actor: PEOPLE.manager, selections: selectPassing(job, env.config, edits) });
const g3 = (env: Env, job: Job, tag = '') =>
  env.engine.decide(job.id, { gate: 'g3_approve_secondary', action: 'approve', actor: PEOPLE.editor, locale: 'ar', fields: editorPlaceholders(job.context!.channels, 'ar', tag), checklist: fullChecklist(env.config) });
const publish = (env: Env, job: Job) => env.engine.decide(job.id, { gate: 'g4_publish', action: 'publish', actor: PEOPLE.manager, sampleChecked: true });

test('parallel decisions at G2 and G3 are both kept', async () => {
  const env = await makeEngine();
  const job = await toGates(env);
  await Promise.all([g2(env, job), g3(env, job)]);
  const saved = (await env.engine.get(job.id))!;
  assert.equal(saved.stages.g2_approve_primary.status, 'done');
  assert.equal(saved.stages.g3_approve_secondary.status, 'done');
  assert.equal(saved.stages.g4_publish.status, 'waiting');
});

test('unknown actions and send-back targets are refused', async () => {
  const env = await makeEngine();
  const job = await g3(env, await g2(env, await toGates(env)));
  const bad = (d: unknown) => env.engine.decide(job.id, d as GateDecision);
  await assert.rejects(bad({ gate: 'g4_publish', action: 'launch', actor: PEOPLE.manager, sampleChecked: true }), /no action "launch"/);
  await assert.rejects(bad({ gate: 'g4_publish', action: 'send_back', actor: PEOPLE.manager, to: 'g1_accept_brief', notes: 'x' }), /G2 or G3 only/);
  await assert.rejects(bad({ gate: 'g4_publish', action: 'publish', sampleChecked: true }), /who is deciding/);
});

test('revert never restores copy that was sent back at G4', async () => {
  const env = await makeEngine();
  let job = await g3(env, await g2(env, await toGates(env)));
  job = await env.engine.decide(job.id, { gate: 'g4_publish', action: 'send_back', actor: PEOPLE.manager, to: 'g2_approve_primary', notes: 'Shorter homepage line' });
  job = await g2(env, job, { homepage: { line: 'Small-batch knitwear in pure cashmere.' } });
  await assert.rejects(env.engine.revert(job.id, 'homepage', 'en', PEOPLE.manager, 'test'), /not live/);
  job = await publish(env, job);
  const ref = job.outputs.find((o) => o.channel === 'homepage' && o.locale === 'en')!.ref!;
  assert.equal((await env.connectors.contentStore.get(ref))!.version, 2, 'the send-back made version 2');
  job = await env.engine.revert(job.id, 'homepage', 'en', PEOPLE.manager, 'Wrong claim');
  assert.equal(job.incidents[0]!.action, 'unpublish', 'version 1 was never live, so the entry is taken down');
  assert.equal(job.counters.sendBacks, 1);
  assert.equal(job.reviewRounds, 0);
});

test('a recovered entry after G4 goes live only if it passes the preview checks', async () => {
  const env = await makeEngine();
  let job = await g2(env, await toGates(env));
  env.connectors.contentStore.setOutage(true);
  job = await publish(env, await g3(env, job));
  env.connectors.contentStore.setOutage(false);
  env.config.qa.allowedLinkHosts = ['other.example.org'];
  job = await env.engine.retryDeferred(job.id, PEOPLE.manager);
  const recovered = job.outputs.filter((o) => o.target === 'content-store');
  assert.ok(recovered.every((o) => o.status === 'staged'), 'held back: the landing link is no longer allowed');
});

test('one metrics row per request, even when the report runs again', async () => {
  const env = await makeEngine();
  let job = await g2(env, await toGates(env));
  env.connectors.contentStore.setOutage(true);
  job = await publish(env, await g3(env, job));
  env.connectors.contentStore.setOutage(false);
  await env.engine.retryDeferred(job.id, PEOPLE.manager);
  const rows = await readJsonl<{ jobId: string }>(`${runtimeDir()}/metrics.jsonl`);
  assert.equal(rows.filter((r) => r.jobId === job.id).length, 1);
});

test('first-pass acceptance is zero after a "changes required" round', async () => {
  const env = await makeEngine();
  let job = await toGates(env);
  job = await env.engine.decide(job.id, { gate: 'g2_approve_primary', action: 'changes_required', actor: PEOPLE.manager, notes: 'Calmer' });
  job = await publish(env, await g3(env, await g2(env, job)));
  assert.equal(job.report?.firstPassAcceptance, 0);
});

test('duplicate locales or channels are rejected at intake', async () => {
  const env = await makeEngine();
  const brief = { ...(await sampleBrief(env.clock)), locales: ['en', 'ar', 'ar'] };
  const job = await env.engine.submit(brief, PEOPLE.requester);
  assert.equal(job.status, 'rejected');
  assert.match(job.stages.intake.note ?? '', /locales has duplicates/);
});

test('the optional secondary-locale draft runs only when configured and supported', async () => {
  const env = await makeEngine();
  env.config.locales.secondary[0]!.aiAssist = true;
  const supportsAll = new (class extends MockModel { override supportsLocale() { return true; } })();
  const engine = await Engine.create({ connectors: env.connectors, model: supportsAll, clock: env.clock, config: env.config });
  let job = await engine.submit(await sampleBrief(env.clock), PEOPLE.requester);
  job = await engine.decide(job.id, { gate: 'g1_accept_brief', action: 'approve', actor: PEOPLE.lead });
  assert.ok(job.secondary[0]?.assist?.homepage, 'assist draft exists');
  assert.equal(job.secondary[0]?.assistTrace?.promptVersion, 'draft.v1');

  const plain = await toGates(env);
  assert.equal(plain.secondary[0]?.assist, undefined, 'the mock model does not support the secondary locale');
});
