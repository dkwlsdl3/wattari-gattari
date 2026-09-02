export function sessionTree(state, collapsed = new Set()) {
  const nodes = [];
  for (const workspace of state?.workspaces ?? []) {
    nodes.push({
      type: "workspace",
      key: `workspace:${workspace.path}`,
      workspacePath: workspace.path,
      workspace,
    });
    if (collapsed.has(workspace.path)) continue;
    for (const session of workspace.sessions) {
      nodes.push({
        type: "session",
        key: session.id,
        workspacePath: workspace.path,
        workspace,
        session,
      });
    }
  }
  return nodes;
}

export function preserveCursor(nodes, previousKey, fallback = 0) {
  const index = nodes.findIndex((node) => node.key === previousKey);
  if (index >= 0) return index;
  return Math.max(0, Math.min(fallback, Math.max(0, nodes.length - 1)));
}
