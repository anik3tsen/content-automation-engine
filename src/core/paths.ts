import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root, resolved from this file so the app runs from any working directory. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_DIR = resolve(ROOT, 'config');
export const SAMPLE_DIR = resolve(ROOT, 'data', 'sample');
export const PROMPTS_DIR = resolve(ROOT, 'prompts');
export const PUBLIC_DIR = resolve(ROOT, 'public');

/** Runtime state (jobs, audit trail, outputs). Override with CAE_RUNTIME_DIR, for example in tests. */
export function runtimeDir(): string {
  return process.env.CAE_RUNTIME_DIR ?? resolve(ROOT, 'data', 'runtime');
}
