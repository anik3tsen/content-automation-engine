import type { OutputRecord } from '../core/types';
import type { StageRunner } from '../core/workflow';
import { approvedItems } from '../core/approved';
import { hashOf } from '../core/ids';
import { ServiceUnavailableError } from '../connectors/types';

/**
 * Step 6. Rule: send approved copy to each destination. No re-typing.
 * The fallback pack is written first, outside the content store.
 * Each channel is independent: if the content store is down, its channels are deferred and the others continue.
 */
export const output: StageRunner = async (job, { connectors, config, clock }) => {
  const items = approvedItems(job, config);
  const { landingUrl } = job.brief;

  job.fallbackPack = await connectors.fallback.write(job.id, {
    jobId: job.id,
    title: job.brief.title,
    launchAt: job.brief.launchAt,
    landingUrl,
    writtenAt: clock.now().toISOString(),
    items: items.map((i) => ({ channel: i.channel.id, locale: i.locale, direction: i.direction, fields: i.fields })),
  });

  const outputs: OutputRecord[] = [];
  let deferred = 0;

  for (const item of items.filter((i) => i.channel.output === 'content-store')) {
    const versionHash = hashOf(item.fields);
    try {
      const entry = await connectors.contentStore.stage({
        jobId: job.id,
        channel: item.channel.id,
        locale: item.locale,
        direction: item.direction,
        fields: item.fields,
        landingUrl,
        versionHash,
      });
      outputs.push({ channel: item.channel.id, locale: item.locale, target: 'content-store', status: 'staged', ref: entry.ref, versionHash, previewUrl: `preview://${entry.ref}` });
    } catch (error) {
      if (!(error instanceof ServiceUnavailableError)) throw error;
      deferred++;
      outputs.push({ channel: item.channel.id, locale: item.locale, target: 'content-store', status: 'deferred', versionHash, error: error.message });
    }
  }

  const adItems = items.filter((i) => i.channel.output === 'ad-export');
  if (adItems.length) {
    const file = await connectors.adExport.write(
      job.id,
      adItems.map((i) => ({ channel: i.channel.id, locale: i.locale, fields: i.fields, landingUrl })),
    );
    for (const i of adItems) outputs.push({ channel: i.channel.id, locale: i.locale, target: 'ad-export', status: 'written', ref: file, versionHash: hashOf(i.fields) });
  }

  const creativeItems = items.filter((i) => i.channel.output === 'creative-handoff');
  if (creativeItems.length) {
    const file = await connectors.creative.send(
      job.id,
      creativeItems.map((i) => ({ channel: i.channel.id, locale: i.locale, direction: i.direction, fields: i.fields })),
    );
    for (const i of creativeItems) outputs.push({ channel: i.channel.id, locale: i.locale, target: 'creative-handoff', status: 'written', ref: file, versionHash: hashOf(i.fields) });
  }

  job.outputs = outputs;
  if (deferred) {
    await connectors.notifier.notify({
      level: 'alert',
      jobId: job.id,
      message: `Content store unavailable: ${deferred} output(s) deferred. Other channels continue. Fallback pack: ${job.fallbackPack}`,
    });
  }
  return { outcome: 'done', note: `${outputs.length} outputs, ${deferred} deferred` };
};
