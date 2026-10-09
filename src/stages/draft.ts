import type { PlacementDraft, Variant, Violation } from '../core/types';
import type { StageRunner } from '../core/workflow';
import { buildDraftPrompt } from '../ai/prompt';
import { resolveSlots, slotValues } from '../ai/slots';
import { hasBlocking } from '../rules/copy-rules';

function parseVariants(raw: string): Record<string, string>[] {
  const json = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as { variants?: unknown };
  if (!Array.isArray(json.variants)) throw new Error('response has no "variants" array');
  return json.variants.map((v) => {
    if (!v || typeof v !== 'object') throw new Error('a variant is not an object');
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)]));
  });
}

const uniqueViolations = (list: Violation[]) =>
  [...new Map(list.map((v) => [`${v.rule}|${v.field}|${v.message}`, v])).values()];

/**
 * Step 4. AI: write variants for each placement in the primary locale.
 * Only placements with no passing variant are drafted again on a retry.
 * The model writes fact slots. This stage fills them from the locked facts.
 */
export const draft: StageRunner = async (job, { config, model, template, audit }) => {
  if (!config.rollout.aiDrafting) return { outcome: 'skipped', note: 'AI drafting is off: people write the copy (manual path)' };
  const ctx = job.context!;
  const locale = config.locales.primary;
  const attempt = job.stages.draft.attempts;
  const values = slotValues(ctx);
  let drafted = 0;

  for (const channel of ctx.channels) {
    const existing = job.drafts.find((d) => d.channel === channel.id && d.locale === locale);
    const needsDraft = !existing || existing.variants.length === 0 || existing.variants.every((v) => hasBlocking(v.violations));
    if (!needsDraft) continue;

    const feedback = uniqueViolations((existing?.variants ?? []).flatMap((v) => v.violations).filter((v) => v.severity === 'block'));
    const built = buildDraftPrompt({ template, ctx, brief: job.brief, channel, locale, attempt, reviewNotes: job.reviewNotes, feedback });
    const trace = { promptVersion: built.version, modelId: model.id, modelVersion: model.version, inputHash: built.inputHash };

    let variants: Variant[];
    try {
      const parsed = parseVariants(await model.complete({ system: built.system, prompt: built.prompt }));
      variants = parsed.map((raw, i) => ({
        id: `${channel.id}-a${attempt}-v${i + 1}`,
        raw,
        fields: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolveSlots(v, values).text])),
        source: 'ai' as const,
        attempt,
        violations: [],
        trace,
      }));
    } catch (error) {
      variants = [{
        id: `${channel.id}-a${attempt}-error`,
        raw: {},
        fields: {},
        source: 'ai',
        attempt,
        violations: [{ rule: 'output_format', message: `model output unusable: ${(error as Error).message}`, severity: 'block' }],
        trace,
      }];
    }

    const placement: PlacementDraft = { channel: channel.id, locale, variants };
    job.drafts = [...job.drafts.filter((d) => !(d.channel === channel.id && d.locale === locale)), placement];
    drafted++;
    await audit({
      stage: 'draft',
      actorKind: 'ai',
      actor: model.id,
      event: 'variants drafted',
      details: { channel: channel.id, variants: variants.length, attempt, fixing: feedback.length, ...trace },
    });
  }
  // Optional AI draft for a secondary locale. Only when aiAssist is on for that locale and the model supports it.
  // It is written from the locked master brief and facts, never from the primary-locale drafts. The editor decides.
  for (const work of job.secondary) {
    const conf = config.locales.secondary.find((s) => s.code === work.locale);
    if (!conf?.aiAssist || work.assist || !model.supportsLocale(work.locale)) continue;
    const assist: Record<string, Record<string, string>> = {};
    for (const channel of ctx.channels) {
      const built = buildDraftPrompt({ template, ctx, brief: job.brief, channel, locale: work.locale, attempt: 1, reviewNotes: [], feedback: [] });
      work.assistTrace = { promptVersion: built.version, modelId: model.id, modelVersion: model.version, inputHash: built.inputHash };
      try {
        const first = parseVariants(await model.complete({ system: built.system, prompt: built.prompt }))[0];
        if (first) assist[channel.id] = Object.fromEntries(Object.entries(first).map(([k, v]) => [k, resolveSlots(v, values).text]));
      } catch {
        // No assist for this channel. The editor writes it.
      }
    }
    work.assist = assist;
    await audit({ stage: 'draft', actorKind: 'ai', actor: model.id, event: 'optional secondary-locale draft', details: { locale: work.locale, channels: Object.keys(assist).length } });
  }

  const order = ctx.channels.map((c) => c.id);
  job.drafts.sort((a, b) => order.indexOf(a.channel) - order.indexOf(b.channel));
  return { outcome: 'done', note: `${drafted} placement(s) drafted, attempt ${attempt}` };
};
