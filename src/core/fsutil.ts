import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  return existsSync(file) ? readJson<T>(file) : fallback;
}

/** Write through a temp file and rename, so a crash never leaves half a file. */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

export async function writeText(file: string, text: string): Promise<void> {
  await ensureDir(dirname(file));
  await writeFile(file, text, 'utf8');
}

export async function appendJsonl(file: string, row: unknown): Promise<void> {
  await ensureDir(dirname(file));
  await appendFile(file, JSON.stringify(row) + '\n', 'utf8');
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}
