import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCopy, type CopyRuleInput } from '../src/rules/copy-rules';
import { charCount } from '../src/rules/text';
import type { Brief, ChannelSpec, FactContext } from '../src/core/types';

const homepage: ChannelSpec = {
  id: 'homepage', label: 'Homepage', register: 'calm', output: 'content-store', variants: 3,
  ctaPolicy: 'required', allowedCtas: ['Discover'], keywordLed: false,
  fields: [
    { name: 'headline', maxChars: 40, required: true, limitSource: 'assumed' },
    { name: 'line', maxChars: 120, required: true, limitSource: 'assumed' },
    { name: 'cta', maxChars: 24, required: true, limitSource: 'assumed' },
  ],
};

const ctx: FactContext = {
  brand: { brandId: 'b', name: 'Sample Brand', approvedClaims: [], facts: {} },
  products: [{ id: 'p', brandId: 'b', name: 'Sweater', category: 'knitwear', materials: ['cashmere'], composition: '100% cashmere', price: { amount: 495, currency: 'USD' }, url: '', available: true }],
  channels: [homepage],
  tone: { do: [], dont: [] },
  keywords: [],
  bannedWords: ['deal', 'cheap'],
  materialLexicon: ['silk', 'cashmere', 'wool'],
  negativeExamples: ["Don't miss out"],
};

const brief = { offer: '' } as Brief;

const run = (fields: Record<string, string>, extra: Partial<CopyRuleInput> = {}) =>
  checkCopy({ fields, channel: homepage, locale: 'en', primary: true, ctx, brief, bannedWords: ctx.bannedWords, ...extra });

const rulesHit = (fields: Record<string, string>, extra: Partial<CopyRuleInput> = {}) =>
  run(fields, extra).filter((v) => v.severity === 'block').map((v) => v.rule);

const ok = { headline: 'Sample Brand arrives', line: 'Knitwear in pure cashmere.', cta: 'Discover' };

test('clean copy passes every rule', () => {
  assert.deepEqual(run(ok), []);
});

test('characters are counted as the reader sees them', () => {
  assert.equal(charCount('café'), 4);
  assert.equal(charCount('👍🏽'), 1);
  assert.deepEqual(rulesHit({ ...ok, headline: 'x'.repeat(41) }), ['character_limit']);
});

test('a material word that is not in the product record is blocked', () => {
  assert.deepEqual(rulesHit({ ...ok, line: 'Knitwear in pure silk.' }), ['material_claim']);
});

test('prices must match the record, and discounts need an offer', () => {
  assert.deepEqual(rulesHit({ ...ok, line: 'Now USD 450.' }), ['price_and_offer']);
  assert.deepEqual(rulesHit({ ...ok, line: 'Now USD 495.' }), []);
  assert.deepEqual(rulesHit({ ...ok, line: 'Now 20% off.' }), ['price_and_offer']);
});

test('banned words match whole words only', () => {
  assert.deepEqual(rulesHit({ ...ok, line: 'A great deal.' }), ['banned_words']);
  assert.deepEqual(rulesHit({ ...ok, line: 'An ideal knit.' }), []);
});

test('brand spelling, rejected phrases, house style', () => {
  assert.deepEqual(rulesHit({ ...ok, headline: 'SAMPLE BRAND arrives' }), ['brand_spelling']);
  assert.deepEqual(rulesHit({ ...ok, line: "Don't miss out on cashmere." }), ['negative_examples']);
  assert.deepEqual(rulesHit({ ...ok, line: 'Pure cashmere!' }), ['house_style']);
});

test('missing facts and unfilled slots are blocked', () => {
  assert.deepEqual(rulesHit({ ...ok, line: 'In [MISSING: product.lining].' }), ['missing_fact']);
  assert.deepEqual(rulesHit({ ...ok, line: 'In {{product.material}}.' }), ['unresolved_slot']);
});

test('CTA must be from the allowed list in the primary locale only', () => {
  assert.deepEqual(rulesHit({ ...ok, cta: 'Buy now' }), ['cta_policy']);
  assert.deepEqual(rulesHit({ ...ok, cta: '[ar] cta' }, { primary: false, locale: 'ar' }), []);
});

test('a composition is not a discount; other currencies and discount words are caught', () => {
  assert.deepEqual(rulesHit({ ...ok, line: 'Knitwear in 100% cashmere.' }), []);
  assert.deepEqual(rulesHit({ ...ok, line: 'With SPF 50 care.' }), []);
  assert.deepEqual(rulesHit({ ...ok, line: 'Only $99.' }), ['price_and_offer']);
  assert.deepEqual(rulesHit({ ...ok, line: 'Now 495 USD.' }), ['price_and_offer']);
  assert.deepEqual(rulesHit({ ...ok, line: 'A big discount on cashmere.' }), ['price_and_offer']);
  assert.deepEqual(rulesHit({ ...ok, line: 'Now usd 495.' }), []);
});
