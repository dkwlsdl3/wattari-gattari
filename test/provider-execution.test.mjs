import assert from "node:assert/strict";
import test from "node:test";

import {
  applyClaudeExecutionSettings,
  applyCodexExecutionSettings,
  defaultProviderExecutionSettings,
  providerExecutionRows,
  updateProviderExecutionSetting,
} from "../src/provider-execution.mjs";

test("provider execution settings expose radio groups and independent checkboxes", () => {
  const settings = defaultProviderExecutionSettings();
  const claudeRows = providerExecutionRows("claude", settings.claude);
  assert.equal(claudeRows.filter((row) => row.kind === "radio").length, 7);
  assert.equal(claudeRows.filter((row) => row.kind === "checkbox").length, 5);
  const codexRows = providerExecutionRows("codex", settings.codex);
  assert.equal(codexRows.filter((row) => row.kind === "radio").length, 18);
  assert.equal(codexRows.filter((row) => row.kind === "checkbox").length, 6);
});

test("Claude execution settings map to the official background CLI flags", () => {
  let settings = defaultProviderExecutionSettings().claude;
  settings = updateProviderExecutionSetting("claude", settings, { kind: "radio", field: "permissionMode", value: "acceptEdits" });
  settings = updateProviderExecutionSetting("claude", settings, { kind: "checkbox", field: "options", key: "bare" });
  settings = updateProviderExecutionSetting("claude", settings, { kind: "checkbox", field: "options", key: "strictMcpConfig" });
  assert.deepEqual(applyClaudeExecutionSettings(["--bg"], settings), [
    "--bg", "--permission-mode", "acceptEdits", "--bare", "--strict-mcp-config",
  ]);
});

test("Claude dangerous and restricted checkboxes resolve conflicting permission modes", () => {
  let settings = defaultProviderExecutionSettings().claude;
  settings = updateProviderExecutionSetting("claude", settings, { kind: "checkbox", field: "options", key: "dangerouslySkipPermissions" });
  assert.equal(settings.permissionMode, "default");
  assert.equal(settings.options.restricted, false);
  assert.deepEqual(applyClaudeExecutionSettings([], settings), ["--dangerously-skip-permissions"]);
});

test("Codex execution settings map approval, sandbox, reviewer, summary, and fallback fields", () => {
  let settings = defaultProviderExecutionSettings().codex;
  settings = updateProviderExecutionSetting("codex", settings, { kind: "radio", field: "approvalPolicy", value: "on-request" });
  settings = updateProviderExecutionSetting("codex", settings, { kind: "radio", field: "sandbox", value: "workspace-write" });
  settings = updateProviderExecutionSetting("codex", settings, { kind: "radio", field: "approvalsReviewer", value: "auto_review" });
  settings = updateProviderExecutionSetting("codex", settings, { kind: "radio", field: "summary", value: "detailed" });
  settings = updateProviderExecutionSetting("codex", settings, { kind: "checkbox", field: "options", key: "allowProviderModelFallback" });
  assert.deepEqual(applyCodexExecutionSettings({ cwd: "/work/sample-app" }, settings, "thread", { cwd: "/work/sample-app" }), {
    cwd: "/work/sample-app",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
    allowProviderModelFallback: true,
  });
  assert.deepEqual(applyCodexExecutionSettings({ threadId: "t", input: [] }, settings, "turn", { cwd: "/work/sample-app" }), {
    threadId: "t",
    input: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    summary: "detailed",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/work/sample-app"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  });
});

test("Codex granular approval settings use the App Server object shape", () => {
  let settings = defaultProviderExecutionSettings().codex;
  settings = updateProviderExecutionSetting("codex", settings, { kind: "radio", field: "approvalPolicy", value: "granular" });
  settings = updateProviderExecutionSetting("codex", settings, { kind: "checkbox", field: "granularApproval", key: "rules" });
  assert.deepEqual(applyCodexExecutionSettings({}, settings, "thread"), {
    approvalPolicy: {
      granular: {
        sandbox_approval: true,
        rules: false,
        skill_approval: true,
        request_permissions: true,
        mcp_elicitations: true,
      },
    },
  });
});
