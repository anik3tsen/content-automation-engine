import type { Brief, ChannelSpec, FactContext, Locale, Violation } from '../core/types';
import { formatPrice } from '../ai/slots';
import { charCount, containsTerm, findTerms } from './text';

export interface CopyRuleInput {
  fields: Record<string, string>;
  channel: ChannelSpec;
  locale: Locale;
  /** True for the primary locale. Some rules, like the material lexicon, are written for the primary language. */
  primary: boolean;
  ctx: FactContext;
  brief: Brief;
  bannedWords: string[];
}

export interface CopyRule {
  id: string;
  description: string;
  check(input: CopyRuleInput): Violation[];
}

const textOf = (fields: Record<string, string>) => Object.values(fields).join(' \n ');

const each = (
  fields: Record<string, string>,
  fn: (name: string, value: string) => Violation | Violation[] | undefined,
): Violation[] =>
  Object.entries(fields).flatMap(([name, value]) => {
    const result = fn(name, value);
    return result ? (Array.isArray(result) ? result : [result]) : [];
  });

/** Currency codes the price check recognises, in addition to the currencies in the product records. */
const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'CHF', 'JPY', 'CNY', 'INR', 'AUD', 'CAD', 'SGD', 'HKD'];
const CURRENCY_SYMBOLS = '$€£¥';

/** Discount and urgency language. "100% cashmere" is a composition, not a discount, so a bare percentage does not match. */
const DISCOUNT = /\b\d+\s?%\s*off\b|\b\d+\s?off\b|\bper ?cent off\b|\bsale\b|\bdiscount(?:s|ed)?\b|\bsave\b|\bsavings\b|\bhalf[- ]price\b|\bclearance\b|\bpromo code\b/i;

export const COPY_RULES: CopyRule[] = [
  {
    id: 'required_fields',
    description: 'Every required field of the channel has text.',
    check: ({ fields, channel }) =>
      channel.fields
        .filter((f) => f.required && !(fields[f.name] ?? '').trim())
        .map((f) => ({ rule: 'required_fields', field: f.name, message: `${f.name} is empty`, severity: 'block' as const })),
  },
  {
    id: 'character_limit',
    description: 'Each field fits its character limit, counted as the reader sees characters.',
    check: ({ fields, channel }) =>
      channel.fields.flatMap((f) => {
        const value = fields[f.name];
        if (value === undefined) return [];
        const n = charCount(value);
        return n > f.maxChars
          ? [{
              rule: 'character_limit',
              field: f.name,
              message: `${f.name} has ${n} characters; the limit is ${f.maxChars} (${f.limitSource} limit)`,
              severity: 'block' as const,
            }]
          : [];
      }),
  },
  {
    id: 'unresolved_slot',
    description: 'No fact slot is left unfilled.',
    check: ({ fields }) =>
      each(fields, (name, value) =>
        /\{\{/.test(value)
          ? { rule: 'unresolved_slot', field: name, message: 'contains an unfilled fact slot', severity: 'block' }
          : undefined,
      ),
  },
  {
    id: 'missing_fact',
    description: 'The model marked a fact as missing instead of guessing. A person must supply it.',
    check: ({ fields }) =>
      each(fields, (name, value) => {
        const m = /\[MISSING:\s*([^\]]+)\]/.exec(value);
        return m
          ? { rule: 'missing_fact', field: name, message: `fact not available: ${m[1]}`, severity: 'block' }
          : undefined;
      }),
  },
  {
    id: 'material_claim',
    description: 'Every material word must be in the product record.',
    check: ({ fields, ctx, primary }) => {
      if (!primary) return [];
      const recorded = new Set(ctx.products.flatMap((p) => p.materials.map((m) => m.toLowerCase())));
      return each(fields, (name, value) =>
        findTerms(value, ctx.materialLexicon)
          .filter((m) => !recorded.has(m.toLowerCase()))
          .map((m) => ({
            rule: 'material_claim',
            field: name,
            message: `"${m}" is not in the product record (record: ${[...recorded].join(', ') || 'none'})`,
            severity: 'block' as const,
          })),
      );
    },
  },
  {
    id: 'price_and_offer',
    description: 'Any price must match the product record, written as the price slot writes it. No discount language without an offer in the brief.',
    check: ({ fields, ctx, brief }) => {
      const allowed = new Set(ctx.products.map((p) => formatPrice(p.price)));
      const codes = [...new Set([...CURRENCY_CODES, ...ctx.products.map((p) => p.price.currency)])].join('|');
      const codeFirst = new RegExp(`\\b(${codes})\\s?(\\d[\\d,]*(?:\\.\\d+)?)`, 'gi');
      const otherForms = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s?(${codes})\\b|[${CURRENCY_SYMBOLS}]\\s?\\d`, 'gi');
      const example = [...allowed][0] ?? 'the product record';
      return each(fields, (name, value) => {
        const out: Violation[] = [];
        for (const m of value.matchAll(codeFirst)) {
          const shown = `${(m[1] ?? '').toUpperCase()} ${Number((m[2] ?? '').replace(/,/g, '')).toLocaleString('en-US')}`;
          if (!allowed.has(shown)) {
            out.push({ rule: 'price_and_offer', field: name, message: `price "${m[0]}" does not match the product record`, severity: 'block' });
          }
        }
        for (const m of value.matchAll(otherForms)) {
          out.push({ rule: 'price_and_offer', field: name, message: `price "${m[0]}" must be written as in the product record (${example})`, severity: 'block' });
        }
        if (!brief.offer && DISCOUNT.test(value)) {
          out.push({ rule: 'price_and_offer', field: name, message: 'discount language, but the brief has no offer', severity: 'block' });
        }
        return out;
      });
    },
  },
  {
    id: 'cta_policy',
    description: 'The call to action follows the channel policy.',
    check: ({ fields, channel, primary }) => {
      if (!primary || channel.ctaPolicy !== 'required' || fields.cta === undefined) return [];
      return channel.allowedCtas.includes(fields.cta)
        ? []
        : [{ rule: 'cta_policy', field: 'cta', message: `CTA "${fields.cta}" is not one of: ${channel.allowedCtas.join(', ')}`, severity: 'block' }];
    },
  },
  {
    id: 'brand_spelling',
    description: 'The brand name is spelled exactly as on the fact card.',
    check: ({ fields, ctx }) =>
      each(fields, (name, value) => {
        const brand = ctx.brand.name;
        const re = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const wrong = [...value.matchAll(re)].map((m) => m[0]).find((m) => m !== brand);
        return wrong
          ? { rule: 'brand_spelling', field: name, message: `brand written as "${wrong}", must be "${brand}"`, severity: 'block' }
          : undefined;
      }),
  },
  {
    id: 'banned_words',
    description: 'No banned word for the locale.',
    check: ({ fields, bannedWords }) =>
      each(fields, (name, value) =>
        findTerms(value, bannedWords).map((w) => ({
          rule: 'banned_words',
          field: name,
          message: `banned word "${w}"`,
          severity: 'block' as const,
        })),
      ),
  },
  {
    id: 'negative_examples',
    description: 'No phrase that editors rejected before.',
    check: ({ fields, ctx, primary }) =>
      primary
        ? each(fields, (name, value) =>
            ctx.negativeExamples
              .filter((p) => containsTerm(value, p))
              .map((p) => ({ rule: 'negative_examples', field: name, message: `rejected phrase "${p}"`, severity: 'block' as const })),
          )
        : [],
  },
  {
    id: 'house_style',
    description: 'No exclamation marks. No words in capital letters for emphasis.',
    check: ({ fields }) =>
      each(fields, (name, value) => {
        const out: Violation[] = [];
        if (value.includes('!')) out.push({ rule: 'house_style', field: name, message: 'exclamation mark', severity: 'block' });
        const shouting = value.match(/\b[A-Z]{4,}\b/g)?.filter((w) => !CURRENCY_CODES.includes(w));
        if (shouting?.length) out.push({ rule: 'house_style', field: name, message: `capitals for emphasis: ${shouting.join(', ')}`, severity: 'warn' });
        return out;
      }),
  },
  {
    id: 'keyword_coverage',
    description: 'Keyword-led channels use at least one keyword in a headline.',
    check: ({ fields, channel, ctx, primary }) => {
      if (!primary || !channel.keywordLed || ctx.keywords.length === 0) return [];
      const headlines = Object.entries(fields).filter(([k]) => k.startsWith('headline')).map(([, v]) => v);
      const hit = headlines.some((h) => ctx.keywords.some((k) => containsTerm(h, k)));
      return hit
        ? []
        : [{ rule: 'keyword_coverage', message: `no headline uses a keyword (${ctx.keywords.join(', ')})`, severity: 'warn' }];
    },
  },
];

/** Run every copy rule. Rules are cheap, predictable and easy to audit. */
export function checkCopy(input: CopyRuleInput): Violation[] {
  return COPY_RULES.flatMap((rule) => rule.check(input));
}

export const hasBlocking = (violations: Violation[]) => violations.some((v) => v.severity === 'block');

export { textOf };
