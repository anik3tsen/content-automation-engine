import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/core/engine';
import { SimulatedClock } from '../src/core/clock';
import { loadPipelineConfig } from '../src/core/config';
import { createLocalConnectors } from '../src/connectors';
import { MockModel, type MockFaults } from '../src/ai/mock-model';
import type { RolloutMode } from '../src/core/types';

/** Every test gets its own runtime folder, so tests never share state. */
export async function makeEngine(options: { faults?: MockFaults; mode?: RolloutMode; aiDrafting?: boolean } = {}) {
  process.env.CAE_RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'cae-test-'));
  const clock = new SimulatedClock(new Date('2026-10-01T08:00:00Z'));
  const connectors = createLocalConnectors(clock, { quiet: true });
  const config = await loadPipelineConfig();
  if (options.mode) config.rollout.mode = options.mode;
  if (options.aiDrafting === false) config.rollout.aiDrafting = false;
  const engine = await Engine.create({ connectors, model: new MockModel(options.faults), clock, config });
  return { engine, connectors, clock, config };
}
