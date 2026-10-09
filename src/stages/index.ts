import type { StageId } from '../core/types';
import type { StageRunner } from '../core/workflow';
import { intake } from './intake';
import { setup } from './setup';
import { gatherFacts } from './gather-facts';
import { draft } from './draft';
import { ruleChecks } from './rule-checks';
import { output } from './output';
import { prepublishQa } from './prepublish-qa';
import { postpublishCheck } from './postpublish-check';
import { report } from './report';

/** Automated stages. Human gates have no runner: they wait for a decision. */
export const RUNNERS: Partial<Record<StageId, StageRunner>> = {
  intake,
  setup,
  gather_facts: gatherFacts,
  draft,
  rule_checks: ruleChecks,
  output,
  prepublish_qa: prepublishQa,
  postpublish_check: postpublishCheck,
  report,
};
