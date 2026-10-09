import type { StageRunner } from '../core/workflow';
import { checkCopy, hasBlocking } from '../rules/copy-rules';

/**
 * Step 5. Rules: check every variant. Rules are cheap, predictable and easy to audit.
 * A placement with no passing variant goes back to drafting with the failures as feedback,
 * up to maxAutoRetries. After that, the reviewer at G2 sees the failures and writes the copy.
 */
export const ruleChecks: StageRunner = async (job, { config, audit }) => {
  if (job.drafts.length === 0) return { outcome: 'done', note: 'nothing to check: manual path' };
  const ctx = job.context!;
  const attempts = job.stages.draft.attempts;
  let blocked = 0;

  for (const placement of job.drafts) {
    const channel = ctx.channels.find((c) => c.id === placement.channel)!;
    for (const variant of placement.variants) {
      // Check only the variants from this drafting attempt. Earlier ones were checked and counted already.
      if (variant.attempt !== attempts) continue;
      if (variant.violations.some((v) => v.rule === 'output_format')) { blocked++; continue; }
      variant.violations = checkCopy({
        fields: variant.fields,
        channel,
        locale: placement.locale,
        primary: true,
        ctx,
        brief: job.brief,
        bannedWords: ctx.bannedWords,
      });
      if (hasBlocking(variant.violations)) {
        blocked++;
        await audit({
          stage: 'rule_checks',
          actorKind: 'rule',
          actor: 'copy-rules',
          event: 'variant blocked',
          details: { variant: variant.id, violations: variant.violations.filter((v) => v.severity === 'block').map((v) => v.message) },
        });
      }
    }
  }
  job.counters.ruleBlocks += blocked;

  const failing = job.drafts.filter((d) => d.variants.every((v) => hasBlocking(v.violations)));
  if (failing.length > 0 && attempts <= config.drafting.maxAutoRetries) {
    return {
      outcome: 'retry',
      reset: ['draft', 'rule_checks'],
      note: `${failing.map((f) => f.channel).join(', ')} failed the rules; drafting again with the failures as feedback`,
    };
  }
  const note = failing.length
    ? `${failing.length} placement(s) still fail after ${attempts} attempts; the reviewer writes them at G2`
    : `all placements have a passing variant (${blocked} variant(s) blocked)`;
  return { outcome: 'done', note };
};
