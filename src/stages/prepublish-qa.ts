import type { Job, OutputRecord, QaCheck } from '../core/types';
import type { PipelineConfig } from '../core/config';
import type { Connectors } from '../connectors/types';
import type { StageRunner } from '../core/workflow';
import { approvedItems } from '../core/approved';
import { checkCopy } from '../rules/copy-rules';
import { ServiceUnavailableError } from '../connectors/types';

/**
 * Checks on one staged content-store entry: layout direction, version, links.
 * Also used when a deferred entry is recovered after G4, so it never goes live unchecked.
 */
export async function previewChecks(job: Job, out: OutputRecord, connectors: Connectors, config: PipelineConfig): Promise<QaCheck[]> {
  if (out.target !== 'content-store' || !out.ref) return [];
  const checks: QaCheck[] = [];
  try {
    const preview = await connectors.contentStore.preview(out.ref);
    const work = job.secondary.find((s) => s.locale === out.locale);
    const expectedDir = work?.direction ?? 'ltr';
    checks.push({
      check: 'layout_direction',
      channel: out.channel,
      locale: out.locale,
      passed: preview.dir === expectedDir && preview.lang === out.locale,
      severity: 'block',
      message: `preview renders lang="${preview.lang}" dir="${preview.dir}", expected dir="${expectedDir}"`,
    });
    checks.push({
      check: 'version_match',
      channel: out.channel,
      locale: out.locale,
      passed: preview.html.includes(`data-version="${out.versionHash}"`),
      severity: 'block',
      message: 'staged entry is the approved version',
    });
    for (const link of preview.links) {
      let ok = false;
      try {
        const url = new URL(link);
        ok = url.protocol === 'https:' && config.qa.allowedLinkHosts.includes(url.host);
      } catch { ok = false; }
      checks.push({ check: 'links', channel: out.channel, locale: out.locale, passed: ok, severity: 'block', message: `${link} ${ok ? 'is allowed' : 'is not an allowed https link'}` });
    }
  } catch (error) {
    if (!(error instanceof ServiceUnavailableError)) throw error;
    checks.push({ check: 'preview', channel: out.channel, locale: out.locale, passed: false, severity: 'warn', message: 'preview unavailable: content store down' });
  }
  return checks;
}

/** Last moment of the configured day, so a date-only setting includes that whole day. */
function endOfDay(value: string): Date {
  const date = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCHours(23, 59, 59, 999);
  return date;
}

/**
 * Step 7a. Rules check the staged preview before anyone publishes:
 * the copy, the links, the layout direction and the version. Then a sample is picked for a person.
 * QA runs before G4, so the publisher approves a page that was already checked.
 */
export const prepublishQa: StageRunner = async (job, { connectors, config, clock }) => {
  const ctx = job.context!;
  const items = approvedItems(job, config);
  const checks: QaCheck[] = [];
  const add = (c: QaCheck) => checks.push(c);

  for (const item of items) {
    const banned = item.primary ? ctx.bannedWords : await connectors.rulebook.bannedWords(item.locale);
    const violations = checkCopy({ fields: item.fields, channel: item.channel, locale: item.locale, primary: item.primary, ctx, brief: job.brief, bannedWords: banned });
    for (const v of violations) {
      add({ check: `copy:${v.rule}`, channel: item.channel.id, locale: item.locale, passed: false, severity: v.severity, message: `${v.field ?? ''} ${v.message}`.trim() });
    }
    if (violations.length === 0) {
      add({ check: 'copy', channel: item.channel.id, locale: item.locale, passed: true, severity: 'block', message: 'all copy rules pass' });
    }
  }

  for (const out of job.outputs) {
    if (out.status === 'deferred') {
      add({ check: 'output', channel: out.channel, locale: out.locale, passed: false, severity: 'warn', message: 'deferred: content store unavailable. Publish from the fallback pack when it returns.' });
      continue;
    }
    checks.push(...(await previewChecks(job, out, connectors, config)));
  }

  const hoursToLaunch = (new Date(job.brief.launchAt).getTime() - clock.now().getTime()) / 3_600_000;
  add({
    check: 'lead_time',
    passed: hoursToLaunch >= config.scheduling.stageLeadHours,
    severity: 'warn',
    message: `${Math.round(hoursToLaunch)} hours to launch; content should be staged ${config.scheduling.stageLeadHours} hours ahead`,
  });

  const fullAudit = clock.now() <= endOfDay(config.audit.secondaryFullAuditUntil);
  const primaryOrder = items.filter((i) => i.primary).slice(0, config.qa.humanSampleSize);
  const secondary = items.filter((i) => !i.primary);
  const sample = [...primaryOrder, ...(fullAudit ? secondary : secondary.slice(0, 1))].map((i) => ({ channel: i.channel.id, locale: i.locale }));

  const failed = checks.filter((c) => !c.passed);
  job.qa = {
    at: clock.now().toISOString(),
    checks,
    blocking: failed.filter((c) => c.severity === 'block').length,
    warnings: failed.filter((c) => c.severity === 'warn').length,
    humanSample: sample,
  };
  if (job.qa.blocking) {
    await connectors.notifier.notify({ level: 'warn', jobId: job.id, message: `Pre-publish QA found ${job.qa.blocking} blocking issue(s). G4 cannot publish until they are fixed.` });
  }
  return { outcome: 'done', note: `${checks.length} checks, ${job.qa.blocking} blocking, ${job.qa.warnings} warnings, ${sample.length} items for a person` };
};
