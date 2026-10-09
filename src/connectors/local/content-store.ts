import { resolve } from 'node:path';
import { readJsonOr, writeJson } from '../../core/fsutil';
import { newId } from '../../core/ids';
import { runtimeDir } from '../../core/paths';
import { KeyedMutex } from '../../core/mutex';
import type { Clock } from '../../core/clock';
import {
  ServiceUnavailableError,
  type ContentEntryInput,
  type ContentStore,
  type RenderedPreview,
  type StoredEntry,
} from '../types';

type Db = { entries: Record<string, StoredEntry> };

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A file-backed content store with staging, preview, scheduling and version history.
 * Every change runs under one lock, so concurrent requests cannot overwrite each other.
 * setOutage(true) simulates the service going down, for failure drills.
 */
export class LocalContentStore implements ContentStore {
  private outage = process.env.CONTENT_STORE_OUTAGE === '1';
  private readonly lock = new KeyedMutex();

  constructor(private readonly clock: Clock) {}

  setOutage(down: boolean): void {
    this.outage = down;
  }

  isDown(): boolean {
    return this.outage;
  }

  private file(): string {
    return resolve(runtimeDir(), 'content-store', 'entries.json');
  }

  private async load(): Promise<Db> {
    if (this.outage) throw new ServiceUnavailableError('content store');
    return readJsonOr<Db>(this.file(), { entries: {} });
  }

  /** Load, change and save as one step. */
  private change<T>(fn: (db: Db) => T): Promise<T> {
    return this.lock.run('db', async () => {
      const db = await this.load();
      const result = fn(db);
      await writeJson(this.file(), db);
      return result;
    });
  }

  private static must(db: Db, ref: string): StoredEntry {
    const entry = db.entries[ref];
    if (!entry) throw new Error(`Unknown entry ${ref}`);
    return entry;
  }

  private static nextVersion(entry: StoredEntry): number {
    return Math.max(...entry.versions.map((v) => v.version)) + 1;
  }

  stage(input: ContentEntryInput): Promise<StoredEntry> {
    return this.change((db) => {
      const at = this.clock.now().toISOString();
      const existing = Object.values(db.entries).find(
        (e) => e.jobId === input.jobId && e.channel === input.channel && e.locale === input.locale,
      );
      if (existing) {
        if (existing.versionHash !== input.versionHash) {
          const version = LocalContentStore.nextVersion(existing);
          Object.assign(existing, input, { version });
          existing.versions.push({ version, versionHash: input.versionHash, fields: input.fields, at });
        }
        return existing;
      }
      const entry: StoredEntry = {
        ...input,
        ref: newId('entry'),
        status: 'draft',
        version: 1,
        versions: [{ version: 1, versionHash: input.versionHash, fields: input.fields, at }],
        publishedVersions: [],
      };
      db.entries[entry.ref] = entry;
      return entry;
    });
  }

  async preview(ref: string): Promise<RenderedPreview> {
    const entry = LocalContentStore.must(await this.load(), ref);
    const body = Object.entries(entry.fields)
      .map(([k, v]) => `<p data-field="${escapeHtml(k)}">${escapeHtml(v)}</p>`)
      .join('');
    const html =
      `<article lang="${entry.locale}" dir="${entry.direction}" data-version="${entry.versionHash}">` +
      `${body}<a href="${escapeHtml(entry.landingUrl)}">link</a></article>`;
    return { ref, html, lang: entry.locale, dir: entry.direction, links: [entry.landingUrl] };
  }

  publish(ref: string, scheduledFor?: string): Promise<StoredEntry> {
    return this.change((db) => {
      const entry = LocalContentStore.must(db, ref);
      entry.status = scheduledFor ? 'scheduled' : 'published';
      entry.scheduledFor = scheduledFor;
      entry.publishedVersionHash = entry.versionHash;
      if (entry.publishedVersions.at(-1) !== entry.version) entry.publishedVersions.push(entry.version);
      return entry;
    });
  }

  async get(ref: string): Promise<StoredEntry | undefined> {
    return (await this.load()).entries[ref];
  }

  /** Put back the copy of an earlier version. The revert is itself a new version, so history only grows. */
  revert(ref: string, toVersion: number): Promise<StoredEntry> {
    return this.change((db) => {
      const entry = LocalContentStore.must(db, ref);
      if (entry.status === 'draft') throw new Error(`Entry ${ref} is not live`);
      const target = entry.versions.find((v) => v.version === toVersion);
      if (!target) throw new Error(`Entry ${ref} has no version ${toVersion}`);
      const version = LocalContentStore.nextVersion(entry);
      entry.versions.push({ version, versionHash: target.versionHash, fields: target.fields, at: this.clock.now().toISOString() });
      entry.version = version;
      entry.fields = target.fields;
      entry.versionHash = target.versionHash;
      entry.publishedVersionHash = target.versionHash;
      entry.publishedVersions.push(version);
      return entry;
    });
  }

  unpublish(ref: string): Promise<StoredEntry> {
    return this.change((db) => {
      const entry = LocalContentStore.must(db, ref);
      entry.status = 'draft';
      entry.scheduledFor = undefined;
      entry.publishedVersionHash = undefined;
      return entry;
    });
  }
}
