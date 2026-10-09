import type { FactContext } from '../core/types';

/**
 * Fact slots. The model writes {{product.material}}, never "cashmere".
 * The system fills each slot from approved source data after generation.
 * Optional filters: |cap (first letter upper case), |title (each word), |lower.
 */
export const SLOT_PATTERN = /\{\{\s*([a-z]+\.[A-Za-z]+)\s*(?:\|\s*(cap|title|lower)\s*)?\}\}/g;

export function formatPrice(price: { amount: number; currency: string }): string {
  return `${price.currency} ${price.amount.toLocaleString('en-US')}`;
}

/** Every fact the model may use, keyed by slot name. */
export function slotValues(ctx: FactContext): Record<string, string> {
  const first = ctx.products[0];
  const materials = [...new Set(ctx.products.flatMap((p) => p.materials))];
  const values: Record<string, string> = { 'brand.name': ctx.brand.name };
  for (const [key, value] of Object.entries(ctx.brand.facts)) values[`brand.${key}`] = value;
  if (first) {
    values['product.name'] = first.name;
    values['product.category'] = first.category;
    values['product.composition'] = first.composition;
    values['product.price'] = formatPrice(first.price);
  }
  if (materials.length > 0) values['product.material'] = materials.join(' and ');
  return values;
}

function applyFilter(value: string, filter?: string): string {
  if (filter === 'cap') return value.charAt(0).toUpperCase() + value.slice(1);
  if (filter === 'title') return value.replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  if (filter === 'lower') return value.toLowerCase();
  return value;
}

/** Replace slots with approved values. An unknown slot becomes [MISSING: name], which the rules then block. */
export function resolveSlots(text: string, values: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(SLOT_PATTERN, (_, key: string, filter?: string) => {
    const value = values[key];
    if (value === undefined) {
      missing.push(key);
      return `[MISSING: ${key}]`;
    }
    return applyFilter(value, filter);
  });
  return { text: out, missing };
}
