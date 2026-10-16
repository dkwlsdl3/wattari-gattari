// Run exactly launched from the work's current plan revision; older revisions never stand in for it.
export const linkedRun = (work, runs) => runs.find(run => run.workId === work.id && work.launches?.some(launch => launch.runId === run.id && launch.planRevision === work.plan?.revision));

// Newest registered plan wins; its linked run replaces the plan once that run exists.
export function currentTarget(works, runs) {
  const plan = works.filter(work => work.plan).sort((a, b) => b.plan.updatedAt - a.plan.updatedAt)[0];
  if (plan) { const run = linkedRun(plan, runs); return run ? `run:${run.id}` : `plan:${plan.id}`; }
  return runs[0] ? `run:${runs[0].id}` : null;
}

// A pin comes only from explicit history/work-record choice. Polls never create one.
export function chooseSelection({ pinned, ids, current }) {
  if (pinned && pinned !== current && ids.includes(pinned)) return { value: pinned, pinned };
  const value = ids.includes(current) ? current : ids[0] || "";
  return { value, pinned: null };
}

// Keep inspector position only when the same execution is still shown.
export const keepsInspector = (preserve, shown, next) => Boolean(preserve && shown && shown === next);
