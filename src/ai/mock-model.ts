import type { CompletionRequest, LanguageModel } from './provider';
import { extractContext, type DraftContext } from './prompt';

/**
 * A deterministic stand-in for a language model. It needs no network and no credentials.
 * It reads the same prompt a real model would get, and answers with fact slots, never literal facts.
 * Replace it with a class that implements LanguageModel to use a real model.
 */

type Template = Record<string, string>;

const FIRST: Record<string, Template[]> = {
  homepage: [
    {
      headline: '{{brand.name}} arrives',
      line: '{{brand.craft|cap}} {{brand.originAdjective}} {{product.category}} in pure {{product.material}}. Discover the debut collection.',
    },
    {
      headline: 'Introducing {{brand.name}}',
      line: 'Pure {{product.material}} {{product.category}}, made in {{brand.origin}} in {{brand.craft}} runs.',
    },
    {
      headline: 'The debut of {{brand.name}}',
      line: '{{brand.originAdjective}} craft, {{brand.craft}} by design. Pure {{product.material}} {{product.category}} is here.',
    },
  ],
  crm_email: [
    { subject: 'New: {{brand.name}}', preheader: '{{brand.craft|cap}} {{brand.originAdjective}} {{product.category}} in pure {{product.material}}.' },
    { subject: '{{brand.name}} has arrived', preheader: 'Pure {{product.material}} {{product.category}}, made in {{brand.origin}}.' },
    { subject: 'Meet {{brand.name}}, new this week', preheader: 'The debut collection: {{brand.craft}} {{product.category}} in pure {{product.material}}.' },
  ],
  social: [
    { caption: '{{brand.craft|cap}} {{product.category}} from {{brand.origin}}, in pure {{product.material}}. The debut collection from {{brand.name}} is here.' },
    { caption: 'Made in {{brand.origin}}, in pure {{product.material}}. Meet {{brand.name}}, new this season.' },
    { caption: '{{brand.name}} arrives with {{brand.craft}} {{product.category}} in pure {{product.material}}.' },
  ],
  search_ad: [
    {
      headline_1: '{{brand.name}} {{product.category|title}}',
      headline_2: 'Pure {{product.material|title}} {{product.category|title}}',
      description: '{{brand.craft|cap}} {{brand.originAdjective}} {{product.category}} in pure {{product.material}}. Discover {{brand.name}}.',
    },
    {
      headline_1: '{{product.material|title}} {{product.category|title}}',
      headline_2: 'New In: {{brand.name}}',
      description: 'Pure {{product.material}} {{product.category}}, made in {{brand.origin}}. Shop the debut collection.',
    },
    {
      headline_1: '{{brand.name}} Debut',
      headline_2: '{{brand.originAdjective}} {{product.material|title}} {{product.category|title}}',
      description: '{{brand.name}}: {{brand.craft}} {{product.category}} in pure {{product.material}}, made in {{brand.origin}}.',
    },
  ],
  display_banner: [{ headline: '{{brand.name}} arrives' }, { headline: 'New: {{brand.name}}' }, { headline: 'Meet {{brand.name}}' }],
};

/** Used after a reviewer selects "Changes required": calmer, shorter, craft first. */
const REVISION: Record<string, Template[]> = {
  homepage: [
    { headline: '{{brand.name}} is here', line: '{{brand.craft|cap}} {{product.category}} from {{brand.origin}}, in pure {{product.material}}.' },
    { headline: 'Meet {{brand.name}}', line: 'Quietly made in {{brand.origin}}: {{brand.craft}} {{product.category}} in pure {{product.material}}.' },
    { headline: '{{brand.name}}: the first collection', line: 'Pure {{product.material}}, made in {{brand.craft}} runs in {{brand.origin}}.' },
  ],
  crm_email: [
    { subject: 'A first look at {{brand.name}}', preheader: '{{brand.craft|cap}} {{product.category}} in pure {{product.material}}, made in {{brand.origin}}.' },
    { subject: '{{brand.name}}, chosen for you', preheader: 'Pure {{product.material}} {{product.category}} from a new {{brand.originAdjective}} house.' },
    { subject: 'Now on site: {{brand.name}}', preheader: '{{brand.craft|cap}} and {{brand.originAdjective}}: the debut collection in pure {{product.material}}.' },
  ],
};

export interface MockFaults {
  /** On the first attempt, write this material on the homepage as a literal word instead of using the slot. Drills the claim check and the redraft loop. */
  inventMaterial?: string;
}

export class MockModel implements LanguageModel {
  readonly id = 'mock-copy-model';
  readonly version = '1.0.0';

  constructor(private readonly faults: MockFaults = {}) {}

  supportsLocale(locale: string): boolean {
    return locale === 'en';
  }

  async complete(request: CompletionRequest): Promise<string> {
    const ctx = extractContext(request.prompt);
    const set = ctx.reviewNotes.length > 0 && REVISION[ctx.channel] ? REVISION[ctx.channel]! : (FIRST[ctx.channel] ?? []);
    const variants = Array.from({ length: ctx.variants }, (_, i) => this.fill(set[i % Math.max(set.length, 1)] ?? {}, ctx, i));
    return JSON.stringify({ variants });
  }

  private fill(template: Template, ctx: DraftContext, index: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const field of ctx.fields) {
      if (field === 'cta') {
        out.cta = ctx.cta || ctx.allowedCtas[index % Math.max(ctx.allowedCtas.length, 1)] || '';
        continue;
      }
      out[field] = template[field] ?? `[MISSING: ${field}]`;
    }
    const fault = this.faults.inventMaterial;
    const firstTry = ctx.attempt === 1 && ctx.feedback.length === 0 && ctx.reviewNotes.length === 0;
    if (fault && firstTry && ctx.channel === 'homepage' && out.line) {
      out.line = out.line.replace('{{product.material}}', fault);
    }
    return out;
  }
}
