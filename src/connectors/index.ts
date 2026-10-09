import type { Clock } from '../core/clock';
import type { Connectors } from './types';
import { FileChannelLibrary, FileKeywordSource, FileProductCatalog, FileRulebook } from './local/sample-data';
import { LocalContentStore } from './local/content-store';
import {
  CsvAdExport,
  FileCreativeHandoff,
  FileFallbackStore,
  FileMetricsSink,
  LocalWorkspace,
  LogNotifier,
} from './local/outputs';

export interface LocalConnectors extends Connectors {
  contentStore: LocalContentStore;
}

/**
 * The connector registry. Every connector here is a local stand-in.
 * Replace one by writing a class that implements the same interface (see src/connectors/types.ts)
 * and returning it from this function. No stage needs to change.
 */
export function createLocalConnectors(clock: Clock, options: { quiet?: boolean } = {}): LocalConnectors {
  return {
    workspace: new LocalWorkspace(),
    catalog: new FileProductCatalog(),
    rulebook: new FileRulebook(),
    channels: new FileChannelLibrary(),
    keywords: new FileKeywordSource(),
    contentStore: new LocalContentStore(clock),
    adExport: new CsvAdExport(),
    creative: new FileCreativeHandoff(),
    fallback: new FileFallbackStore(),
    notifier: new LogNotifier(clock, options.quiet),
    metrics: new FileMetricsSink(),
  };
}

export * from './types';
