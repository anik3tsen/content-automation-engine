import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Brief, ChannelSpec, FactContext, Locale, Violation } from '../core/types';
import { hashOf } from '../core/ids';
import { ROOT } from '../core/paths';
import { slotValues } from './slots';

export interface PromptTemplate {
  id: string;
  version: string;
  body: string;
}

/** Prompts live as versioned markdown files. The version is stamped on every output. */
export async function loadPromptTemplate(relativePath: string): Promise<PromptTemplate> {
  const text = await readFile(resolve(ROOT, relativePath), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`Prompt ${relativePath} has no front matter`);
  const meta = Object.fromEntries(
    (match[1] ?? '').split(/\r?\n/).map((line) => line.split(':').map((part) => part.trim()) as [string, string]),
  );
  return { id: meta.id ?? 'unknown', version: meta.version ?? 'unknown', body: match[2] ?? '' };
}

export interface DraftPromptInput {
  template: PromptTemplate;
  ctx: FactContext;
  brief: Brief;
  channel: ChannelSpec;
  locale: Locale;
  attempt: number;
  reviewNotes: string[];
  feedback: Violation[];
}

/** The context block is machine-readable, so the prompt is reproducible and the mock model can read it. */
export interface DraftContext {
  channel: string;
  locale: Locale;
  variants: number;
  fields: string[];
  slots: string[];
  cta: string;
  allowedCtas: string[];
  ctaPolicy: ChannelSpec['ctaPolicy'];
  keywords: string[];
  reviewNotes: string[];
  feedback: { rule: string; field?: string; message: string }[];
  attempt: number;
}

export interface BuiltPrompt {
  system: string;
  prompt: string;
  version: string;
  inputHash: string;
  context: DraftContext;
}

const list = (items: string[]) => (items.length ? items.join('; ') : 'none');

/** Assemble the seven blocks: Role, Facts, Tone, Task, Limits, Never, Output. */
export function buildDraftPrompt(input: DraftPromptInput): BuiltPrompt {
  const { template, ctx, brief, channel, locale, attempt, reviewNotes, feedback } = input;
  const slots = Object.keys(slotValues(ctx));
  const cta = brief.cta && channel.allowedCtas.includes(brief.cta) ? brief.cta : (channel.allowedCtas[0] ?? '');
  const context: DraftContext = {
    channel: channel.id,
    locale,
    variants: channel.variants,
    fields: channel.fields.map((f) => f.name),
    slots,
    cta,
    allowedCtas: channel.allowedCtas,
    ctaPolicy: channel.ctaPolicy,
    keywords: channel.keywordLed ? ctx.keywords : [],
    reviewNotes,
    feedback: feedback.map(({ rule, field, message }) => ({ rule, field, message })),
    attempt,
  };
  const outputShape = JSON.stringify({
    variants: [Object.fromEntries(channel.fields.map((f) => [f.name, '...']))],
  });
  const values: Record<string, string> = {
    channelLabel: channel.label,
    factSlots: slots.map((s) => `- {{${s}}}`).join('\n'),
    approvedClaims: list(ctx.brand.approvedClaims),
    register: channel.register,
    toneDo: list(ctx.tone.do),
    toneDont: list(ctx.tone.dont),
    negativeExamples: list(ctx.negativeExamples),
    variants: String(channel.variants),
    locale,
    objective: brief.objective,
    audience: brief.audience,
    keyMessage: brief.keyMessage,
    offer: brief.offer || 'none',
    cta: cta || 'none',
    reviewNotes: list(reviewNotes),
    feedback: list(feedback.map((v) => `${v.field ?? 'copy'}: ${v.message}`)),
    limits: channel.fields.map((f) => `- ${f.name}: at most ${f.maxChars} characters`).join('\n'),
    ctaPolicy:
      channel.ctaPolicy === 'required'
        ? `required, one of: ${list(channel.allowedCtas)}`
        : channel.ctaPolicy === 'soft'
          ? 'soft or none'
          : 'no CTA field',
    keywords: list(context.keywords),
    bannedWords: list(ctx.bannedWords),
    outputShape,
    contextJson: JSON.stringify(context, null, 2),
  };
  const prompt = template.body.replace(/<<(\w+)>>/g, (_, key: string) => values[key] ?? '');
  return {
    system: 'You write copy drafts for people to review. Return JSON only.',
    prompt,
    version: template.version,
    inputHash: hashOf({ prompt, version: template.version }),
    context,
  };
}

/** Read the context block back out of a prompt. */
export function extractContext(prompt: string): DraftContext {
  const match = /<context>\s*([\s\S]*?)\s*<\/context>/.exec(prompt);
  if (!match?.[1]) throw new Error('Prompt has no context block');
  return JSON.parse(match[1]) as DraftContext;
}
