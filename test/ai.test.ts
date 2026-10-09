import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSlots } from '../src/ai/slots';
import { buildDraftPrompt, extractContext, loadPromptTemplate } from '../src/ai/prompt';
import { MockModel } from '../src/ai/mock-model';
import type { Brief, ChannelSpec, FactContext } from '../src/core/types';

test('slots are filled from approved values; unknown slots become [MISSING]', () => {
  const values = { 'brand.name': 'Sample Brand', 'brand.craft': 'small-batch', 'product.category': 'knitwear' };
  assert.equal(resolveSlots('{{brand.craft|cap}} {{product.category|title}} by {{brand.name}}', values).text, 'Small-batch Knitwear by Sample Brand');
  const r = resolveSlots('in {{product.lining}}', values);
  assert.equal(r.text, 'in [MISSING: product.lining]');
  assert.deepEqual(r.missing, ['product.lining']);
});

const channel: ChannelSpec = {
  id: 'homepage', label: 'Homepage module', register: 'editorial, calm', output: 'content-store', variants: 3,
  ctaPolicy: 'required', allowedCtas: ['Discover'], keywordLed: false,
  fields: [{ name: 'headline', maxChars: 40, required: true, limitSource: 'assumed' }, { name: 'line', maxChars: 120, required: true, limitSource: 'assumed' }, { name: 'cta', maxChars: 24, required: true, limitSource: 'assumed' }],
};
const ctx: FactContext = {
  brand: { brandId: 'b', name: 'Sample Brand', approvedClaims: ['Made in Italy'], facts: { origin: 'Italy', originAdjective: 'Italian', craft: 'small-batch' } },
  products: [{ id: 'p', brandId: 'b', name: 'Sweater', category: 'knitwear', materials: ['cashmere'], composition: '100% cashmere', price: { amount: 495, currency: 'USD' }, url: '', available: true }],
  channels: [channel], tone: { do: ['Be calm'], dont: ['Shout'] }, keywords: [], bannedWords: ['cheap'], materialLexicon: ['silk', 'cashmere'], negativeExamples: [],
};
const brief = { objective: 'Launch', audience: 'Customers', keyMessage: 'New knitwear', offer: '', cta: 'Discover' } as Brief;

test('the prompt has seven blocks, a version and a reproducible context', async () => {
  const template = await loadPromptTemplate('prompts/draft.v1.md');
  const built = buildDraftPrompt({ template, ctx, brief, channel, locale: 'en', attempt: 2, reviewNotes: ['Calmer'], feedback: [{ rule: 'material_claim', field: 'line', message: '"silk" is not in the product record', severity: 'block' }] });
  for (const block of ['Role', 'Facts', 'Tone', 'Task', 'Limits', 'Never', 'Output']) assert.match(built.prompt, new RegExp(`^## ${block}$`, 'm'));
  assert.equal(built.version, 'draft.v1');
  assert.match(built.prompt, /\{\{product\.material\}\}/);
  assert.match(built.prompt, /silk" is not in the product record/);
  const context = extractContext(built.prompt);
  assert.equal(context.attempt, 2);
  assert.deepEqual(context.fields, ['headline', 'line', 'cta']);
  assert.equal(buildDraftPrompt({ template, ctx, brief, channel, locale: 'en', attempt: 2, reviewNotes: ['Calmer'], feedback: [] }).inputHash.length, 16);
});

test('the mock model answers with slots, not literal facts', async () => {
  const template = await loadPromptTemplate('prompts/draft.v1.md');
  const built = buildDraftPrompt({ template, ctx, brief, channel, locale: 'en', attempt: 1, reviewNotes: [], feedback: [] });
  const { variants } = JSON.parse(await new MockModel().complete(built)) as { variants: Record<string, string>[] };
  assert.equal(variants.length, 3);
  assert.ok(variants.every((v) => /\{\{product\.material\}\}/.test(v.line ?? '')));
  assert.ok(variants.every((v) => !/cashmere/i.test(v.line ?? '')));
});
