import type { StageRunner } from '../core/workflow';

/** Step 2. Rule: create the workspace, the tasks and the deadline. Content is due stageLeadHours before launch. */
export const setup: StageRunner = async (job, { connectors, config }) => {
  const launch = new Date(job.brief.launchAt);
  const deadline = new Date(launch.getTime() - config.scheduling.stageLeadHours * 3_600_000).toISOString();
  const { folder, tasks } = await connectors.workspace.create(job, deadline);
  job.workspace = { folder, tasks, deadline };
  return { outcome: 'done', note: `${tasks.length} tasks, content due ${deadline}` };
};
