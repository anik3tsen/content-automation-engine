import type { StageRunner } from '../core/workflow';

/** Step 3. Rule: collect every approved input. The model never fetches facts itself. */
export const gatherFacts: StageRunner = async (job, { connectors, config }) => {
  const { brief } = job;
  const primary = config.locales.primary;
  const [products, brand, channels, tone, keywords, bannedWords, materialLexicon, negativeExamples] = await Promise.all([
    connectors.catalog.getMany(brief.productIds),
    connectors.rulebook.brand(brief.brandId),
    connectors.channels.get(brief.channels),
    connectors.rulebook.tone(brief.tone, primary),
    connectors.keywords.forBrand(brief.brandId),
    connectors.rulebook.bannedWords(primary),
    connectors.rulebook.materialLexicon(),
    connectors.rulebook.negativeExamples(primary),
  ]);

  const problems: string[] = [];
  const missingProducts = brief.productIds.filter((id) => !products.some((p) => p.id === id));
  if (missingProducts.length) problems.push(`products not in the catalogue: ${missingProducts.join(', ')}`);
  if (products.some((p) => p.brandId !== brief.brandId)) problems.push('a product belongs to another brand');
  if (products.some((p) => !p.available)) problems.push('a product is not available');
  if (!brand) problems.push(`no brand fact card for ${brief.brandId}`);
  if (!tone) problems.push(`no tone profile "${brief.tone}" for ${primary}`);
  if (problems.length || !brand || !tone) {
    return { outcome: 'failed', jobStatus: 'failed', note: problems.join('; ') };
  }

  job.context = { brand, products, channels, tone, keywords, bannedWords, materialLexicon, negativeExamples };

  job.secondary = brief.locales
    .filter((l) => l !== primary)
    .map((code) => {
      const conf = config.locales.secondary.find((s) => s.code === code);
      return {
        locale: code,
        direction: conf?.direction ?? 'ltr',
        status: 'waiting' as const,
        fields: {},
        checklist: Object.fromEntries(config.secondaryChecklist.map((item) => [item, false])),
        history: [],
      };
    });

  return { outcome: 'done', note: `${products.length} products, ${channels.length} channels, ${keywords.length} keywords` };
};
