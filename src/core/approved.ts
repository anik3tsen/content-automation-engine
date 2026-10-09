import type { ChannelSpec, Job, Locale } from './types';
import type { PipelineConfig } from './config';

export interface ApprovedItem {
  channel: ChannelSpec;
  locale: Locale;
  direction: 'ltr' | 'rtl';
  primary: boolean;
  fields: Record<string, string>;
}

/** All copy that passed its gate: the primary locale from G2, each secondary locale from G3. */
export function approvedItems(job: Job, config: PipelineConfig): ApprovedItem[] {
  const ctx = job.context;
  if (!ctx) return [];
  const items: ApprovedItem[] = [];
  for (const channel of ctx.channels) {
    const primary = job.drafts.find((d) => d.channel === channel.id && d.locale === config.locales.primary);
    if (primary?.final) {
      items.push({ channel, locale: primary.locale, direction: 'ltr', primary: true, fields: primary.final });
    }
    for (const work of job.secondary) {
      const fields = work.fields[channel.id];
      if (work.status === 'approved' && fields) {
        items.push({ channel, locale: work.locale, direction: work.direction, primary: false, fields });
      }
    }
  }
  return items;
}
