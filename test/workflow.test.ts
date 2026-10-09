import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from './helpers';
import { PEOPLE, editorPlaceholders, fullChecklist, handWritten, sampleBrief, selectPassing } from '../src/cli/fixtures';
import { GateError } from '../src/core/gates';
import type { Job } from '../src/core/types';

type Env = Awaited<ReturnType<typeof makeEngine>>;

async function toGates(env: Env): Promise<Job> {
  const job = await env.engine.submit(await sampleBrief(env.clock), PEOPLE.requester);
  return env.engine.decide(job.id, { gate: 'g1_accept_brief', action: 'approve', actor: PEOPLE.lead });
}

const approveG2 = (env: Env, job: Job) =>
  env.engine.decide(job.id, { gate: 'g2_approve_primary', action: 'approve', actor: PEOPLE.manager, selections: selectPassing(job, env.config) });

const approveG3 = (env: Env, job: Job) =>
  env.engine.decide(job.id, { gate: 'g3_approve_secondary', action: 'approve', actor: PEOPLE.editor, locale: 'ar', fields: editorPlaceholders(job.context!.channels, 'ar'), checklist: fullChecklist(env.config) });

const publish = (env: Env, job: Job) =>
  env.engine.decide(job.id, { gate: 'g4_publish', action: 'publish', actor: PEOPLE.manager, sampleChecked: true });

test('happy path: four gates, then published with zero errors at publish', async () => {
  const env = await makeEngine();
  let job = await env.engine.submit(await sampleBrief(env.clock), PEOPLE.requester);
  assert.equal(job.stages.g1_accept_brief.status, 'waiting');
  assert.equal(job.drafts.length, 0, 'no AI work before the brief is accepted');

  job = await env.engine.decide(job.id, { gate: 'g1_accept_brief', action: 'approve', actor: PEOPLE.lead });
  assert.ok(job.master?.hash, 'master brief is locked');
  assert.equal(job.stages.g2_approve_primary.status, 'waiting');
  assert.equal(job.stages.g3_approve_secondary.status, 'waiting', 'G3 runs in parallel with G2');

  job = await approveG2(env, job);
  assert.equal(job.stages.output.status, 'pending', 'output waits for G3');
  job = await approveG3(env, job);
  assert.equal(job.stages.prepublish_qa.status, 'done', 'QA runs before G4');
  assert.equal(job.stages.g4_publish.status, 'waiting');

  job = await publish(env, job);
  assert.equal(job.status, 'published');
  assert.equal(job.report?.errorsAtPublish, 0);
  assert.ok(job.outputs.every((o) => o.status === 'published'));
  assert.ok(job.fallbackPack);
});

test('only the named role can decide, and only at an open gate', async () => {
  const env = await makeEngine();
  const job = await env.engine.submit(await sampleBrief(env.clock), PEOPLE.requester);
  await assert.rejects(env.engine.decide(job.id, { gate: 'g1_accept_brief', action: 'approve', actor: PEOPLE.manager }), GateError);
  await assert.rejects(env.engine.decide(job.id, { gate: 'g4_publish', action: 'publish', actor: PEOPLE.manager, sampleChecked: true }), /not open/);
});

test('nobody can approve copy that fails a blocking rule', async () => {
  const env = await makeEngine();
  const job = await toGates(env);
  const selections = selectPassing(job, env.config, { homepage: { line: 'Knitwear in pure silk.' } });
  await assert.rejects(
    env.engine.decide(job.id, { gate: 'g2_approve_primary', action: 'approve', actor: PEOPLE.manager, selections }),
    /silk/,
  );
});

test('an invented material is blocked and redrafted automatically', async () => {
  const env = await makeEngine({ faults: { inventMaterial: 'silk' } });
  const job = await toGates(env);
  const home = job.drafts.find((d) => d.channel === 'homepage')!;
  assert.ok(job.counters.ruleBlocks >= 3, 'all first-attempt homepage variants were blocked');
  assert.equal(home.variants[0]?.attempt, 2, 'homepage was drafted a second time');
  assert.ok(home.variants.every((v) => v.violations.every((x) => x.severity !== 'block')));
  const audit = await env.engine.audit(job.id);
  assert.ok(audit.some((e) => e.event === 'variant blocked'));
});

test('"changes required" sends notes back to drafting', async () => {
  const env = await makeEngine();
  let job = await toGates(env);
  const before = job.drafts.find((d) => d.channel === 'homepage')!.variants[0]!.fields.headline;
  job = await env.engine.decide(job.id, { gate: 'g2_approve_primary', action: 'changes_required', actor: PEOPLE.manager, notes: 'Calmer' });
  assert.equal(job.reviewRounds, 1);
  assert.equal(job.stages.g2_approve_primary.status, 'waiting');
  assert.notEqual(job.drafts.find((d) => d.channel === 'homepage')!.variants[0]!.fields.headline, before);
});

test('the native editor can veto; nothing moves on until G3 approves', async () => {
  const env = await makeEngine();
  let job = await approveG2(env, await toGates(env));
  job = await env.engine.decide(job.id, { gate: 'g3_approve_secondary', action: 'veto', actor: PEOPLE.editor, locale: 'ar', notes: 'Wrong register' });
  assert.equal(job.secondary[0]?.status, 'returned');
  assert.equal(job.stages.output.status, 'pending');
  await assert.rejects(
    env.engine.decide(job.id, { gate: 'g3_approve_secondary', action: 'approve', actor: PEOPLE.editor, locale: 'ar', fields: editorPlaceholders(job.context!.channels, 'ar'), checklist: {} }),
    /checklist/,
  );
  job = await approveG3(env, job);
  assert.equal(job.stages.g4_publish.status, 'waiting');
});

test('G4 needs a checked sample', async () => {
  const env = await makeEngine();
  const job = await approveG3(env, await approveG2(env, await toGates(env)));
  await assert.rejects(env.engine.decide(job.id, { gate: 'g4_publish', action: 'publish', actor: PEOPLE.manager, sampleChecked: false }), /sample/);
});

test('a content store outage defers its channels only; retry publishes them', async () => {
  const env = await makeEngine();
  let job = await approveG2(env, await toGates(env));
  env.connectors.contentStore.setOutage(true);
  job = await publish(env, await approveG3(env, job));
  const deferred = job.outputs.filter((o) => o.status === 'deferred');
  assert.ok(deferred.length > 0 && deferred.every((o) => o.target === 'content-store'));
  assert.ok(job.outputs.filter((o) => o.target !== 'content-store').every((o) => o.status === 'published'));
  env.connectors.contentStore.setOutage(false);
  job = await env.engine.retryDeferred(job.id, PEOPLE.manager);
  assert.ok(job.outputs.every((o) => o.status === 'published'));
});

test('intake rejects an incomplete brief', async () => {
  const env = await makeEngine();
  const brief = { ...(await sampleBrief(env.clock)), keyMessage: '' };
  const job = await env.engine.submit(brief, PEOPLE.requester);
  assert.equal(job.status, 'rejected');
  assert.match(job.stages.intake.note ?? '', /keyMessage is required/);
});

test('shadow mode: people write the copy, the AI drafts are kept for comparison', async () => {
  const env = await makeEngine({ mode: 'shadow' });
  const job = await toGates(env);
  assert.ok(job.drafts.length > 0, 'drafts exist for comparison');
  await assert.rejects(approveG2(env, job), /write the copy/);
  const done = await env.engine.decide(job.id, { gate: 'g2_approve_primary', action: 'approve', actor: PEOPLE.manager, selections: handWritten(env.config) });
  assert.ok(done.drafts.every((d) => d.finalSource === 'human' && typeof d.editRatio === 'number'));
});

test('manual path: with AI drafting off, the workflow and gates still run', async () => {
  const env = await makeEngine({ aiDrafting: false });
  const job = await toGates(env);
  assert.equal(job.stages.draft.status, 'skipped');
  const done = await env.engine.decide(job.id, { gate: 'g2_approve_primary', action: 'approve', actor: PEOPLE.manager, selections: handWritten(env.config) });
  assert.equal(done.stages.g2_approve_primary.status, 'done');
});

test('incident: a live entry is taken down and related outputs are listed', async () => {
  const env = await makeEngine();
  const job = await publish(env, await approveG3(env, await approveG2(env, await toGates(env))));
  const after = await env.engine.revert(job.id, 'homepage', 'en', PEOPLE.manager, 'Wrong claim reported');
  assert.equal(after.incidents.length, 1);
  assert.equal(after.incidents[0]!.relatedOutputs.length, job.outputs.length - 1);
  const ref = after.outputs.find((o) => o.channel === 'homepage' && o.locale === 'en')!.ref!;
  assert.equal((await env.connectors.contentStore.get(ref))?.status, 'draft');
});
