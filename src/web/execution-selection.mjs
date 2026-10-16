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

// Replans are attempts of the same work, not additional top-level work choices.
export function historyGroups(works, runs) {
  const groups = new Map();
  for (const work of works.filter(work => work.plan)) {
    const entries = runs.filter(run => run.workId === work.id).map(run => ({ ...run, id: `run:${run.id}` }));
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    const current = linkedRun(work, runs);
    if (!current) entries.unshift({ id: `plan:${work.id}`, title: work.plan.title, updatedAt: work.plan.updatedAt, state: 'declaration' });
    else {
      const index = entries.findIndex(entry => entry.id === `run:${current.id}`);
      entries.unshift(...entries.splice(index, 1));
    }
    groups.set(work.id, { id: work.id, title: work.plan.title, updatedAt: Math.max(work.plan.updatedAt, ...entries.map(entry => entry.updatedAt)), entries });
  }
  for (const run of runs) {
    const key = run.workId || `run:${run.id}`;
    if (groups.has(key) && works.some(work => work.id === key && work.plan)) continue;
    if (!groups.has(key)) groups.set(key, { id: key, title: run.title, updatedAt: run.updatedAt, entries: [] });
    const group = groups.get(key);
    group.entries.push({ ...run, id: `run:${run.id}` });
    group.entries.sort((a, b) => b.updatedAt - a.updatedAt);
    group.updatedAt = Math.max(...group.entries.map(entry => entry.updatedAt));
    group.title = group.entries[0].title;
  }
  return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
