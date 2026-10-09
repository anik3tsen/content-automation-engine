import type { QaCheck } from '../core/types';
import type { StageRunner } from '../core/workflow';
import { ServiceUnavailableError } from '../connectors/types';

/** Step 7b. Rule: confirm that what is live (or scheduled) is exactly what was approved. */
export const postpublishCheck: StageRunner = async (job, { connectors, clock }) => {
  const checks: QaCheck[] = [];
  for (const out of job.outputs) {
    if (out.status === 'deferred') {
      checks.push({ check: 'live', channel: out.channel, locale: out.locale, passed: false, severity: 'warn', message: 'not live yet: deferred until the content store returns' });
      continue;
    }
    if (out.status === 'staged') {
      checks.push({ check: 'live', channel: out.channel, locale: out.locale, passed: false, severity: 'warn', message: 'not live: staged, or taken down by an incident' });
      continue;
    }
    if (out.target === 'content-store' && out.ref) {
      try {
        const entry = await connectors.contentStore.get(out.ref);
        const statusOk = entry?.status === out.status;
        const versionOk = entry?.publishedVersionHash === out.versionHash;
        checks.push({
          check: 'live',
          channel: out.channel,
          locale: out.locale,
          passed: statusOk && versionOk,
          severity: 'block',
          message: statusOk && versionOk ? `${out.status}, approved version` : `expected ${out.status} ${out.versionHash}, found ${entry?.status} ${entry?.publishedVersionHash}`,
        });
      } catch (error) {
        if (!(error instanceof ServiceUnavailableError)) throw error;
        checks.push({ check: 'live', channel: out.channel, locale: out.locale, passed: false, severity: 'warn', message: 'cannot confirm: content store down' });
      }
      continue;
    }
    const connector = out.target === 'ad-export' ? connectors.adExport : connectors.creative;
    const ok = Boolean(out.ref && (await connector.verify(out.ref)));
    checks.push({ check: 'handoff', channel: out.channel, locale: out.locale, passed: ok, severity: 'block', message: ok ? `delivered to ${out.target}` : `missing ${out.target} file` });
  }
  const failed = checks.filter((c) => !c.passed);
  job.postCheck = {
    at: clock.now().toISOString(),
    checks,
    blocking: failed.filter((c) => c.severity === 'block').length,
    warnings: failed.filter((c) => c.severity === 'warn').length,
    humanSample: [],
  };
  if (job.postCheck.blocking) {
    await connectors.notifier.notify({ level: 'alert', jobId: job.id, message: `Live check: ${job.postCheck.blocking} output(s) do not match the approved version.` });
  }
  return { outcome: 'done', note: `${checks.length} checks, ${job.postCheck.blocking} errors at publish` };
};
