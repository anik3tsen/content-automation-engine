// Scenario runner. Plays a full request through the pipeline with simulated people at each gate.
//   npm run demo                         happy path
//   npm run demo -- --scenario outage    one scenario
//   npm run demo -- --scenario all       every scenario, with pass/fail checks (used in CI)

import { relative } from 'node:path';
import type { Job, StageStatus } from '../core/types';
import { Engine } from '../core/engine';
import { loadPipelineConfig, type PipelineConfig } from '../core/config';
import { SimulatedClock } from '../core/clock';
import { ROOT } from '../core/paths';
import { STAGES } from '../core/workflow';
import { createLocalConnectors, type LocalConnectors } from '../connectors';
import { MockModel } from '../ai/mock-model';
import { PEOPLE, editorPlaceholders, fullChecklist, handWritten, sampleBrief, selectPassing } from './fixtures';

type ScenarioName = 'happy' | 'changes' | 'false-claim' | 'outage' | 'veto' | 'shadow';

interface Scenario {
  title: string;
  story: string;
  run(env: Env): Promise<Job>;
  expect(job: Job): string[];
}

interface Env {
  engine: Engine;
  connectors: LocalConnectors;
  clock: SimulatedClock;
  config: PipelineConfig;
}

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const pick = (args[args.indexOf('--scenario') + 1] ?? 'happy') as ScenarioName | 'all';
const color = !quiet && process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const say = (s = '') => { if (!quiet) console.log(s); };

const MARK: Record<StageStatus, string> = {
  done: paint('32', '[x]'),
  waiting: paint('33', '[~]'),
  pending: paint('2', '[ ]'),
  running: paint('36', '[>]'),
  failed: paint('31', '[!]'),
  skipped: paint('2', '[-]'),
};

function showStages(job: Job): void {
  say('  ' + STAGES.map((s) => `${MARK[job.stages[s.id].status]} ${s.label}`).join('  '));
}

function step(env: Env, hours: number, text: string): void {
  env.clock.advanceHours(hours);
  say(`\n${paint('1', `+${hours}h`)} ${text}`);
}

// ---------- The shared path through the gates ----------

async function acceptBrief(env: Env, job: Job): Promise<Job> {
  step(env, 2, 'G1: the content project lead accepts the brief. The master brief is locked.');
  job = await env.engine.decide(job.id, { gate: 'g1_accept_brief', action: 'approve', actor: PEOPLE.lead });
  for (const d of job.drafts) {
    const blocked = d.variants.filter((v) => v.violations.some((x) => x.severity === 'block')).length;
    const attempt = d.variants[0]?.attempt ?? 1;
    say(`  ${d.channel}: ${d.variants.length} variants${attempt > 1 ? paint('33', ` (drafted ${attempt} times: the rules sent it back)`) : ''}${blocked ? paint('31', `, ${blocked} blocked by rules`) : ''}`);
  }
  showStages(job);
  return job;
}

async function approvePrimary(env: Env, job: Job, shadow = false): Promise<Job> {
  step(env, 3, shadow ? 'G2: the writer approves hand-written copy (shadow mode: AI drafts are hidden and kept for comparison).' : 'G2: the writer selects a variant for each placement and edits one line.');
  const selections = shadow
    ? handWritten(env.config)
    : selectPassing(job, env.config, { homepage: { line: job.drafts.find((d) => d.channel === 'homepage')!.variants.find((v) => !v.violations.some((x) => x.severity === 'block'))!.fields.line!.replace(' Discover the debut collection.', ' Discover the collection.') } });
  job = await env.engine.decide(job.id, { gate: 'g2_approve_primary', action: 'approve', actor: PEOPLE.manager, selections });
  for (const d of job.drafts.filter((x) => x.final)) say(`  ${d.channel}: ${d.finalSource}, edit ratio ${d.editRatio}`);
  return job;
}

async function approveSecondary(env: Env, job: Job, tag = ''): Promise<Job> {
  step(env, 2, 'G3: the native editor transcreates from the locked master brief (not from the English drafts) and approves.');
  for (const work of job.secondary) {
    job = await env.engine.decide(job.id, {
      gate: 'g3_approve_secondary',
      action: 'approve',
      actor: PEOPLE.editor,
      locale: work.locale,
      fields: editorPlaceholders(job.context!.channels, work.locale, tag),
      checklist: fullChecklist(env.config),
    });
  }
  showStages(job);
  if (job.qa) say(`  Pre-publish QA: ${job.qa.blocking} blocking, ${job.qa.warnings} warnings, ${job.qa.humanSample.length} items for a person to check`);
  return job;
}

async function publish(env: Env, job: Job): Promise<Job> {
  step(env, 1, 'G4: the content manager checks the sample and publishes.');
  job = await env.engine.decide(job.id, { gate: 'g4_publish', action: 'publish', actor: PEOPLE.manager, sampleChecked: true });
  showStages(job);
  return job;
}

async function start(env: Env): Promise<Job> {
  say(`\n${paint('1', '+0h')} A requester submits the brief form.`);
  const job = await env.engine.submit(await sampleBrief(env.clock), PEOPLE.requester);
  showStages(job);
  return job;
}

// ---------- Scenarios ----------

const SCENARIOS: Record<ScenarioName, Scenario> = {
  happy: {
    title: 'Happy path',
    story: 'One brief becomes approved copy for five channels in two locales, with four human gates.',
    run: async (env) => publish(env, await approveSecondary(env, await approvePrimary(env, await acceptBrief(env, await start(env))))),
    expect: (job) => [
      job.status === 'published' ? '' : `status is ${job.status}`,
      job.report?.errorsAtPublish === 0 ? '' : 'errors at publish',
      job.outputs.every((o) => o.status === 'published') ? '' : 'not every output is published',
    ],
  },

  changes: {
    title: 'Changes required',
    story: 'The writer sends the drafts back with notes. The AI drafts again from the same locked facts.',
    run: async (env) => {
      let job = await acceptBrief(env, await start(env));
      step(env, 2, 'G2: the writer selects "Changes required" with notes.');
      job = await env.engine.decide(job.id, { gate: 'g2_approve_primary', action: 'changes_required', actor: PEOPLE.manager, notes: 'Calmer homepage and email. Lead with craft, not with "arrives".' });
      say(`  Round ${job.reviewRounds}. New homepage draft: "${job.drafts.find((d) => d.channel === 'homepage')?.variants[0]?.fields.headline}"`);
      return publish(env, await approveSecondary(env, await approvePrimary(env, job)));
    },
    expect: (job) => [job.reviewRounds === 1 ? '' : `review rounds ${job.reviewRounds}`, job.status === 'published' ? '' : `status ${job.status}`],
  },

  'false-claim': {
    title: 'Design for failure 1: a false material claim',
    story: 'The model writes a material that is not in the product record. A rule blocks it before any person sees it. Then the incident drill: a wrong line is found live and reverted.',
    run: async (env) => {
      let job = await acceptBrief(env, await start(env));
      const audit = await env.engine.audit(job.id);
      for (const e of audit.filter((x) => x.event === 'variant blocked')) say(paint('31', `  Rule blocked ${e.details?.variant}: ${(e.details?.violations as string[]).join('; ')}`));
      job = await publish(env, await approveSecondary(env, await approvePrimary(env, job)));
      step(env, 6, 'Incident drill: a customer reports a wrong claim on the homepage. The content manager reverts it.');
      job = await env.engine.revert(job.id, 'homepage', env.config.locales.primary, PEOPLE.manager, 'Customer reported a wrong material claim');
      const incident = job.incidents.at(-1)!;
      say(`  ${incident.action}; ${incident.relatedOutputs.length} related outputs listed for checking through the job ID`);
      return job;
    },
    expect: (job) => [
      job.counters.ruleBlocks > 0 ? '' : 'no rule block recorded',
      job.drafts.every((d) => !/\bsilk\b/i.test(Object.values(d.final ?? {}).join(' '))) ? '' : 'invented material reached approved copy',
      job.incidents.length === 1 ? '' : 'incident not recorded',
    ],
  },

  outage: {
    title: 'Design for failure 2: the content store stops before launch',
    story: 'The content store goes down. Its channels are deferred; ads and creative go on time from the same approved copy. When it returns, the deferred entries are published.',
    run: async (env) => {
      let job = await acceptBrief(env, await start(env));
      step(env, 1, paint('31', 'The content store stops responding.'));
      env.connectors.contentStore.setOutage(true);
      job = await publish(env, await approveSecondary(env, await approvePrimary(env, job)));
      say(`  Outputs: ${job.outputs.map((o) => `${o.channel}/${o.locale}=${o.status}`).join(', ')}`);
      say(`  Fallback pack: ${relative(ROOT, job.fallbackPack ?? '')}`);
      step(env, 3, 'The content store is back. The content manager retries the deferred outputs.');
      env.connectors.contentStore.setOutage(false);
      job = await env.engine.retryDeferred(job.id, PEOPLE.manager);
      say(`  Outputs: ${job.outputs.map((o) => `${o.channel}/${o.locale}=${o.status}`).join(', ')}`);
      return job;
    },
    expect: (job) => [job.outputs.every((o) => o.status === 'published') ? '' : 'deferred outputs were not recovered', job.fallbackPack ? '' : 'no fallback pack'],
  },

  veto: {
    title: 'Design for failure 3: secondary-locale copy is correct but culturally wrong',
    story: 'The native editor vetoes the copy at G3. Output waits for G3, so nothing is published in any locale until the editor approves.',
    run: async (env) => {
      let job = await approvePrimary(env, await acceptBrief(env, await start(env)));
      step(env, 2, 'G3: the native editor vetoes the first version: right grammar, wrong register for this audience.');
      job = await env.engine.decide(job.id, { gate: 'g3_approve_secondary', action: 'veto', actor: PEOPLE.editor, locale: job.secondary[0]!.locale, notes: 'Form of address is too casual for this audience. Rework the email subject.' });
      say(`  Output stage: ${job.stages.output.status} (waits for G3)`);
      return publish(env, await approveSecondary(env, job, ' v2'));
    },
    expect: (job) => [job.secondary.every((s) => s.history.some((h) => h.action === 'veto')) ? '' : 'veto not recorded', job.status === 'published' ? '' : `status ${job.status}`],
  },

  shadow: {
    title: 'Rollout: shadow mode',
    story: 'The system drafts in parallel but people work as usual. The report compares the two.',
    run: async (env) => {
      env.config.rollout.mode = 'shadow';
      return publish(env, await approveSecondary(env, await approvePrimary(env, await acceptBrief(env, await start(env)), true)));
    },
    expect: (job) => [job.mode === 'shadow' ? '' : 'mode is not shadow', job.report?.humanWrittenPlacements === 5 ? '' : 'expected 5 hand-written placements'],
  },
};

// ---------- Runner ----------

async function runScenario(name: ScenarioName): Promise<{ name: ScenarioName; job: Job; failures: string[] }> {
  const clock = new SimulatedClock(new Date());
  const connectors = createLocalConnectors(clock, { quiet });
  const config = await loadPipelineConfig();
  const model = new MockModel(name === 'false-claim' ? { inventMaterial: 'silk' } : {});
  const engine = await Engine.create({ connectors, model, clock, config });
  const scenario = SCENARIOS[name];

  say(`\n${paint('1;4', `${scenario.title}`)}\n${scenario.story}`);
  const job = await scenario.run({ engine, connectors, clock, config });
  const failures = scenario.expect(job).filter(Boolean);

  if (job.report) {
    const r = job.report;
    say(`\n  Report: errors at publish ${r.errorsAtPublish}, rule blocks ${r.ruleBlocksCaught}, review rounds ${r.reviewRounds}, first-pass acceptance ${r.firstPassAcceptance === null ? 'n/a' : `${Math.round(r.firstPassAcceptance * 100)}%`}, turnaround ${r.turnaroundHours} h`);
    say(`  Files: data/runtime/reports/${job.id}.md, data/runtime/exports/${job.id}-ads.csv, data/runtime/handoff/${job.id}-creative.json`);
  }
  return { name, job, failures };
}

const names = pick === 'all' ? (Object.keys(SCENARIOS) as ScenarioName[]) : [pick];
if (!names.every((n) => n in SCENARIOS)) {
  console.error(`Unknown scenario "${pick}". Use one of: ${Object.keys(SCENARIOS).join(', ')}, all`);
  process.exit(2);
}

const results = [];
for (const n of names) results.push(await runScenario(n));

console.log('\nScenario results');
for (const r of results) {
  console.log(`  ${r.failures.length ? 'FAIL' : 'pass'}  ${r.name.padEnd(12)} ${r.job.id}  ${r.job.status}${r.failures.length ? `  (${r.failures.join('; ')})` : ''}`);
}
console.log('\nOpen the gate UI with: npm start');
process.exit(results.some((r) => r.failures.length) ? 1 : 0);
