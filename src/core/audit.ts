import { resolve } from 'node:path';
import type { AuditEvent } from './types';
import { appendJsonl, readJsonl } from './fsutil';
import { runtimeDir } from './paths';

/** Append-only audit trail: one JSON line per event, one file per job. */
export class AuditLog {
  private file(jobId: string): string {
    return resolve(runtimeDir(), 'audit', `${jobId}.jsonl`);
  }

  async append(event: AuditEvent): Promise<void> {
    await appendJsonl(this.file(event.jobId), event);
  }

  async read(jobId: string): Promise<AuditEvent[]> {
    return readJsonl<AuditEvent>(this.file(jobId));
  }
}
