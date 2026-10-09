import { resolve } from 'node:path';
import type { ChannelSpec, GateId, Locale, RoleId, RolloutMode } from './types';
import { readJson } from './fsutil';
import { CONFIG_DIR } from './paths';

export interface SecondaryLocaleConfig {
  code: Locale;
  label: string;
  direction: 'ltr' | 'rtl';
  aiAssist: boolean;
}

export interface PipelineConfig {
  rollout: { mode: RolloutMode; aiDrafting: boolean };
  locales: { primary: Locale; secondary: SecondaryLocaleConfig[] };
  drafting: { maxAutoRetries: number; promptTemplate: string };
  gates: Record<GateId, { label: string; role: RoleId }>;
  roles: Record<RoleId, string>;
  secondaryChecklist: string[];
  qa: { allowedLinkHosts: string[]; humanSampleSize: number; lightEditThreshold: number };
  scheduling: { stageLeadHours: number };
  audit: { secondaryFullAuditUntil: string };
}

export async function loadPipelineConfig(dir = CONFIG_DIR): Promise<PipelineConfig> {
  return readJson<PipelineConfig>(resolve(dir, 'pipeline.json'));
}

export async function loadChannelSpecs(dir = CONFIG_DIR): Promise<ChannelSpec[]> {
  const file = await readJson<{ channels: ChannelSpec[] }>(resolve(dir, 'channels.json'));
  return file.channels;
}
