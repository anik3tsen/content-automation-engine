import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Job } from './types';
import { readJson, writeJson } from './fsutil';
import { runtimeDir } from './paths';

/** Jobs persist as one JSON file each. Swap this class for a database without touching the stages. */
export class JobStore {
  private dir(): string {
    return resolve(runtimeDir(), 'jobs');
  }

  async save(job: Job): Promise<void> {
    await writeJson(resolve(this.dir(), `${job.id}.json`), job);
  }

  async get(id: string): Promise<Job | undefined> {
    const file = resolve(this.dir(), `${id}.json`);
    return existsSync(file) ? readJson<Job>(file) : undefined;
  }

  async list(): Promise<Job[]> {
    if (!existsSync(this.dir())) return [];
    const files = (await readdir(this.dir())).filter((f) => f.endsWith('.json'));
    const jobs = await Promise.all(files.map((f) => readJson<Job>(resolve(this.dir(), f))));
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
