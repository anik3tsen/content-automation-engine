import { resolve } from 'node:path';
import type { Actor, Brief, ChannelSpec, Job } from '../core/types';
import type { PipelineConfig } from '../core/config';
import type { Clock } from '../core/clock';
import { readJson } from '../core/fsutil';
import { SAMPLE_DIR } from '../core/paths';
import { placementKey } from '../core/workflow';
import { hasBlocking } from '../rules/copy-rules';

/** The people in the demo. One per role. */
export const PEOPLE = {
  requester: { name: 'Requester', role: 'requester' },
  lead: { name: 'Content project lead', role: 'content_project_lead' },
  manager: { name: 'Content manager', role: 'content_manager' },
  editor: { name: 'Native editor', role: 'native_editor' },
} satisfies Record<string, Actor>;

/** The sample brief, with the launch date set 3 days ahead when it is empty. */
export async function sampleBrief(clock: Clock): Promise<Brief> {
  const { $comment: _, ...brief } = await readJson<Brief & { $comment?: string }>(resolve(SAMPLE_DIR, 'brief.json'));
  if (!brief.launchAt) brief.launchAt = new Date(clock.now().getTime() + 72 * 3_600_000).toISOString();
  return brief;
}

/**
 * Stand-in text for the secondary locale. The native editor writes the real copy at G3.
 * The demo never generates text in that language.
 */
export function editorPlaceholders(channels: ChannelSpec[], locale: string, tag = ''): Record<string, Record<string, string>> {
  return Object.fromEntries(
    channels.map((c) => [c.id, Object.fromEntries(c.fields.map((f) => [f.name, `[${locale}${tag}] ${f.name}`.slice(0, f.maxChars)]))]),
  );
}

export const fullChecklist = (config: PipelineConfig) => Object.fromEntries(config.secondaryChecklist.map((i) => [i, true]));

/** The reviewer selects the first variant that passes every rule. Optional edits change one field. */
export function selectPassing(
  job: Job,
  config: PipelineConfig,
  edits: Record<string, Record<string, string>> = {},
): Record<string, { variantId?: string; fields?: Record<string, string> }> {
  const out: Record<string, { variantId?: string; fields?: Record<string, string> }> = {};
  for (const placement of job.drafts.filter((d) => d.locale === config.locales.primary)) {
    const key = placementKey(placement.channel, placement.locale);
    const variant = placement.variants.find((v) => !hasBlocking(v.violations));
    if (!variant) continue;
    const edit = edits[placement.channel];
    out[key] = edit ? { variantId: variant.id, fields: { ...variant.fields, ...edit } } : { variantId: variant.id };
  }
  return out;
}

/** Copy a writer types by hand, for shadow mode and the manual path. */
export function handWritten(config: PipelineConfig): Record<string, { fields: Record<string, string> }> {
  const p = config.locales.primary;
  return {
    [placementKey('homepage', p)]: { fields: { headline: 'Sample Brand, new on site', line: 'Italian knitwear in pure cashmere, made in small batches.', cta: 'Discover' } },
    [placementKey('crm_email', p)]: { fields: { subject: 'Just arrived: Sample Brand', preheader: 'Pure cashmere knitwear from Italy.', cta: 'Shop the collection' } },
    [placementKey('social', p)]: { fields: { caption: 'Pure cashmere, made in Italy in small batches. Sample Brand is now here.' } },
    [placementKey('search_ad', p)]: { fields: { headline_1: 'Sample Brand Cashmere', headline_2: 'Cashmere Knitwear', description: 'Italian knitwear in pure cashmere. Discover Sample Brand.' } },
    [placementKey('display_banner', p)]: { fields: { headline: 'Sample Brand is here', cta: 'Discover' } },
  };
}
