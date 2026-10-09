import type { StageRunner } from '../core/workflow';
import { validateBrief } from '../rules/brief-rules';

/** Step 1. Rule: the request must be complete before anyone spends time on it. */
export const intake: StageRunner = async (job, { connectors, config, clock }) => {
  const channels = await connectors.channels.all();
  const problems = validateBrief(job.brief, channels, config, clock.now());
  if (problems.length > 0) {
    return { outcome: 'failed', jobStatus: 'rejected', note: problems.map((p) => p.message).join('; ') };
  }
  return { outcome: 'done', note: 'brief complete' };
};
