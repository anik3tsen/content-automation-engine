import { resolve } from 'node:path';
import type { BrandFactCard, ChannelId, ChannelSpec, Locale, ProductRecord, ToneProfile } from '../../core/types';
import { readJson } from '../../core/fsutil';
import { SAMPLE_DIR } from '../../core/paths';
import { loadChannelSpecs } from '../../core/config';
import type { ChannelLibrary, KeywordSource, ProductCatalog, Rulebook } from '../types';

/** Product catalogue backed by data/sample/products.json. */
export class FileProductCatalog implements ProductCatalog {
  constructor(private readonly dir = SAMPLE_DIR) {}

  async getMany(ids: string[]): Promise<ProductRecord[]> {
    const { products } = await readJson<{ products: ProductRecord[] }>(resolve(this.dir, 'products.json'));
    return products.filter((p) => ids.includes(p.id));
  }
}

/** Rulebook backed by data/sample/rulebook/*.json. */
export class FileRulebook implements Rulebook {
  constructor(private readonly dir = resolve(SAMPLE_DIR, 'rulebook')) {}

  async brand(brandId: string): Promise<BrandFactCard | undefined> {
    const { brands } = await readJson<{ brands: BrandFactCard[] }>(resolve(this.dir, 'brand-facts.json'));
    return brands.find((b) => b.brandId === brandId);
  }

  async tone(profile: string, locale: Locale): Promise<ToneProfile | undefined> {
    const { profiles } = await readJson<{ profiles: Record<string, Record<Locale, ToneProfile>> }>(
      resolve(this.dir, 'tone.json'),
    );
    return profiles[profile]?.[locale];
  }

  async bannedWords(locale: Locale): Promise<string[]> {
    const lists = await readJson<Record<string, string[]>>(resolve(this.dir, 'banned-words.json'));
    return lists[locale] ?? [];
  }

  async materialLexicon(): Promise<string[]> {
    const { materials } = await readJson<{ materials: string[] }>(resolve(this.dir, 'materials.json'));
    return materials;
  }

  async negativeExamples(locale: Locale): Promise<string[]> {
    const lists = await readJson<Record<string, string[]>>(resolve(this.dir, 'negative-examples.json'));
    return lists[locale] ?? [];
  }
}

/** Channel library backed by config/channels.json. */
export class FileChannelLibrary implements ChannelLibrary {
  async all(): Promise<ChannelSpec[]> {
    return loadChannelSpecs();
  }

  async get(ids: ChannelId[]): Promise<ChannelSpec[]> {
    const all = await this.all();
    return ids.map((id) => all.find((c) => c.id === id)).filter((c): c is ChannelSpec => Boolean(c));
  }
}

/** Keyword source backed by data/sample/keywords.json. */
export class FileKeywordSource implements KeywordSource {
  constructor(private readonly dir = SAMPLE_DIR) {}

  async forBrand(brandId: string): Promise<string[]> {
    const lists = await readJson<Record<string, string[]>>(resolve(this.dir, 'keywords.json'));
    return lists[brandId] ?? [];
  }
}
