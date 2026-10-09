import type { Brief, ChannelSpec, Violation } from '../core/types';
import type { PipelineConfig } from '../core/config';

const REQUIRED: (keyof Brief)[] = [
  'title',
  'requester',
  'brandId',
  'objective',
  'audience',
  'keyMessage',
  'tone',
  'launchAt',
  'landingUrl',
];

/** Intake rules. A request with gaps never enters the pipeline. */
export function validateBrief(brief: Brief, channels: ChannelSpec[], config: PipelineConfig, now: Date): Violation[] {
  const out: Violation[] = [];
  const block = (field: string, message: string) => out.push({ rule: 'brief', field, message, severity: 'block' });

  for (const key of REQUIRED) {
    const value = brief[key];
    if (typeof value !== 'string' || !value.trim()) block(key, `${key} is required`);
  }
  if (!Array.isArray(brief.productIds) || brief.productIds.length === 0) block('productIds', 'at least one product is required');
  if (!Array.isArray(brief.channels) || brief.channels.length === 0) block('channels', 'at least one channel is required');
  for (const c of brief.channels ?? []) {
    if (!channels.some((spec) => spec.id === c)) block('channels', `unknown channel "${c}"`);
  }
  for (const key of ['productIds', 'channels', 'locales'] as const) {
    const list = brief[key] ?? [];
    if (new Set(list).size !== list.length) block(key, `${key} has duplicates`);
  }
  const locales = brief.locales ?? [];
  if (locales[0] !== config.locales.primary) block('locales', `the first locale must be the primary locale "${config.locales.primary}"`);
  for (const l of locales.slice(1)) {
    if (!config.locales.secondary.some((s) => s.code === l)) block('locales', `locale "${l}" is not configured`);
  }
  try {
    const url = new URL(brief.landingUrl);
    if (url.protocol !== 'https:') block('landingUrl', 'landing URL must use https');
  } catch {
    if (brief.landingUrl) block('landingUrl', 'landing URL is not a valid URL');
  }
  if (brief.launchAt) {
    const at = new Date(brief.launchAt);
    if (Number.isNaN(at.getTime())) block('launchAt', 'launch date is not a valid date');
    else if (at <= now) block('launchAt', 'launch date is in the past');
  }
  return out;
}
