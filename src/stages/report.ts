import { resolve } from 'node:path';
import type { JobReport } from '../core/types';
import type { StageRunner } from '../core/workflow';
import { writeText } from '../core/fsutil';
import { runtimeDir } from '../core/paths';

const hoursBetween = (a: string, b: string) => Math.round(((new Date(b).getTime() - new Date(a).getTime()) / 3_600_000) * 10) / 10;

/** Step 8. Rule: record what happened, for the KPI dashboard. Quality measures come first. */
export const report: StageRunner = async (job, { connectors, config, clock }) => {
  const stageMinutes: Record<string, number> = {};
  for (const [id, s] of Object.entries(job.stages)) {
    if (s.startedAt && s.endedAt) stageMinutes[id] = Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60_000);
  }
  const primary = job.drafts.filter((d) => d.final);
  const aiBased = primary.filter((d) => d.finalSource !== 'human');
  const light = aiBased.filter((d) => (d.editRatio ?? 0) <= config.qa.lightEditThreshold);
  // First pass means the first round. After "changes required", no placement counts as accepted first time.
  const firstPass = aiBased.length ? (job.reviewRounds > 0 ? 0 : Math.round((light.length / aiBased.length) * 100) / 100) : null;
  // Shadow mode: how close the hand-written copy came to the best AI draft.
  const compared = primary.filter((d) => d.finalSource === 'human' && typeof d.editRatio === 'number');
  const shadowSimilarity = compared.length
    ? Math.round((compared.reduce((sum, d) => sum + (1 - (d.editRatio ?? 1)), 0) / compared.length) * 100) / 100
    : null;

  const result: JobReport = {
    jobId: job.id,
    mode: job.mode,
    turnaroundHours: job.publish ? hoursBetween(job.createdAt, job.publish.at) : null,
    stageMinutes,
    reviewRounds: job.reviewRounds,
    sendBacks: job.counters.sendBacks,
    firstPassAcceptance: firstPass,
    shadowSimilarity,
    ruleBlocksCaught: job.counters.ruleBlocks,
    errorsAtPublish: job.postCheck?.blocking ?? 0,
    aiAssistedPlacements: aiBased.length,
    humanWrittenPlacements: primary.length - aiBased.length,
    outputs: job.outputs.map((o) => ({ channel: o.channel, locale: o.locale, status: o.status })),
  };
  job.report = result;
  await connectors.metrics.record(result);

  const lines = [
    `# Report: ${job.brief.title}`,
    '',
    `Job ${job.id}, rollout mode "${job.mode}", generated ${clock.now().toISOString()}`,
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Errors at publish | ${result.errorsAtPublish} |`,
    `| Rule blocks caught before review | ${result.ruleBlocksCaught} |`,
    `| Review rounds ("changes required" at G2) | ${result.reviewRounds} |`,
    `| Sent back from G4 | ${result.sendBacks} |`,
    `| First-pass acceptance (light edits only) | ${result.firstPassAcceptance === null ? 'n/a' : `${Math.round(result.firstPassAcceptance * 100)}%`} |`,
    `| Turnaround, request to publish | ${result.turnaroundHours === null ? 'n/a' : `${result.turnaroundHours} h`} |`,
    `| Placements: AI-assisted / human-written | ${result.aiAssistedPlacements} / ${result.humanWrittenPlacements} |`,
    `| Shadow mode: similarity of hand-written copy to the best AI draft | ${result.shadowSimilarity === null ? 'n/a' : `${Math.round(result.shadowSimilarity * 100)}%`} |`,
    '',
    '## Time in each stage (minutes)',
    '',
    ...Object.entries(stageMinutes).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Outputs',
    '',
    ...result.outputs.map((o) => `- ${o.channel} (${o.locale}): ${o.status}`),
    '',
  ];
  await writeText(resolve(runtimeDir(), 'reports', `${job.id}.md`), lines.join('\n'));
  return { outcome: 'done', note: `errors at publish ${result.errorsAtPublish}, review rounds ${result.reviewRounds}` };
};
