import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { appendJsonl, readJsonl, writeJson, writeText } from '../../core/fsutil';
import { runtimeDir } from '../../core/paths';
import type { JobReport } from '../../core/types';
import type { Clock } from '../../core/clock';
import { KeyedMutex } from '../../core/mutex';
import type {
  AdExport,
  AdRow,
  CreativeHandoff,
  FallbackStore,
  HandoffItem,
  MetricsSink,
  Notification,
  Notifier,
  WorkspaceProvisioner,
} from '../types';
import type { Job } from '../../core/types';

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Writes the ad bulk-upload file as CSV under data/runtime/exports. */
export class CsvAdExport implements AdExport {
  async write(jobId: string, rows: AdRow[]): Promise<string> {
    const fieldNames = [...new Set(rows.flatMap((r) => Object.keys(r.fields)))];
    const header = ['channel', 'locale', ...fieldNames, 'final_url'];
    const lines = rows.map((r) =>
      [r.channel, r.locale, ...fieldNames.map((f) => r.fields[f] ?? ''), r.landingUrl].map(csvCell).join(','),
    );
    const file = resolve(runtimeDir(), 'exports', `${jobId}-ads.csv`);
    await writeText(file, [header.join(','), ...lines].join('\n') + '\n');
    return file;
  }

  async verify(ref: string): Promise<boolean> {
    return existsSync(ref);
  }
}

/** Writes the creative hand-off package as JSON under data/runtime/handoff. */
export class FileCreativeHandoff implements CreativeHandoff {
  async send(jobId: string, items: HandoffItem[]): Promise<string> {
    const file = resolve(runtimeDir(), 'handoff', `${jobId}-creative.json`);
    await writeJson(file, { jobId, items });
    return file;
  }

  async verify(ref: string): Promise<boolean> {
    return existsSync(ref);
  }
}

/** Writes the fallback pack (all approved copy) under data/runtime/fallback. */
export class FileFallbackStore implements FallbackStore {
  async write(jobId: string, pack: unknown): Promise<string> {
    const file = resolve(runtimeDir(), 'fallback', `${jobId}.json`);
    await writeJson(file, pack);
    return file;
  }
}

/** Creates a local folder and a task list for each request. */
export class LocalWorkspace implements WorkspaceProvisioner {
  async create(job: Job, deadline: string): Promise<{ folder: string; tasks: string[] }> {
    const folder = resolve(runtimeDir(), 'workspaces', job.id);
    const tasks = [
      'G1 Accept brief',
      'G2 Approve primary copy',
      ...job.brief.locales.slice(1).map((l) => `G3 Approve ${l} copy`),
      'G4 Publish',
      ...job.brief.channels.map((c) => `Deliver ${c}`),
    ];
    await writeJson(resolve(folder, 'workspace.json'), { jobId: job.id, title: job.brief.title, deadline, tasks });
    return { folder, tasks };
  }
}

/** Appends notifications to a log file and, unless quiet, prints them. */
export class LogNotifier implements Notifier {
  constructor(
    private readonly clock: Clock,
    private readonly quiet = false,
  ) {}

  async notify(n: Notification): Promise<void> {
    await appendJsonl(resolve(runtimeDir(), 'notifications.jsonl'), { at: this.clock.now().toISOString(), ...n });
    if (!this.quiet && n.level !== 'info') console.log(`  [${n.level}] ${n.message}`);
  }
}

/** Keeps one metrics row per request in a JSON-lines file, ready for a dashboard. A later report replaces the earlier row. */
export class FileMetricsSink implements MetricsSink {
  private readonly lock = new KeyedMutex();

  record(report: JobReport): Promise<void> {
    return this.lock.run('metrics', () => this.write(report));
  }

  private async write(report: JobReport): Promise<void> {
    const file = resolve(runtimeDir(), 'metrics.jsonl');
    const rows = (await readJsonl<JobReport>(file)).filter((r) => r.jobId !== report.jobId);
    await writeText(file, [...rows, report].map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
}
