import { rm } from 'node:fs/promises';
import { runtimeDir } from '../core/paths';

await rm(runtimeDir(), { recursive: true, force: true });
console.log(`Removed ${runtimeDir()}`);
