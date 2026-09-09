import { runOverview } from "./overview.mjs";
import { CODEX_EXECUTION_MODES } from "./codex-execution.mjs";
import { defaultProviderExecutionSettings, normalizeAllProviderExecutionSettings, codexExecutionModeForSettings } from "./provider-execution.mjs";

let sessions = [
  { id: "claude:demo-api", nativeId: "demo-api", provider: "claude", status: "idle", name: "API contract", cwd: "/demo/wattari-gattari", updatedAt: 3 },
  { id: "codex:demo-dock", nativeId: "demo-dock", provider: "codex", status: "working", name: "Dock polish", cwd: "/demo/wattari-gattari", updatedAt: 2 },
  { id: "codex:demo-tests", nativeId: "demo-tests", provider: "codex", status: "needs-input", name: "Regression tests", cwd: "/demo/sample-app", updatedAt: 1 },
];

const bridge = {
  async discover() {
    return { sessions, warnings: [] };
  },
  async create(provider, prompt, { cwd }) {
    const nativeId = `demo-${provider}-${sessions.length + 1}`;
    sessions = [...sessions, {
      id: `${provider}:${nativeId}`,
      nativeId,
      provider,
      status: "idle",
      name: prompt,
      cwd,
      updatedAt: Date.now(),
    }];
    return { provider, nativeId };
  },
  async archive(target) {
    sessions = sessions.filter((session) => session.id !== target);
    return { target, archived: true };
  },
  async rename(target, name) {
    sessions = sessions.map((session) => session.id === target ? { ...session, name } : session);
    return { target, renamed: true, name };
  },
};

const workspace = {
  async focusOrOpen() {
    return { reused: false };
  },
  async closeSessionView() {
    return { closed: false };
  },
  async leave() {
    return { closeOverview: true };
  },
};

let providerSettings = defaultProviderExecutionSettings();
const settingsStore = {
  load: () => ({ providers: structuredClone(providerSettings), codexExecutionMode: codexExecutionModeForSettings(providerSettings.codex) }),
  toggleCodexExecutionMode: () => {
    const current = codexExecutionModeForSettings(providerSettings.codex);
    const next = current === CODEX_EXECUTION_MODES.DEFAULT ? CODEX_EXECUTION_MODES.YOLO : CODEX_EXECUTION_MODES.DEFAULT;
    providerSettings.codex = {
      ...providerSettings.codex,
      approvalPolicy: next === CODEX_EXECUTION_MODES.YOLO ? "never" : "default",
      sandbox: next === CODEX_EXECUTION_MODES.YOLO ? "danger-full-access" : "default",
    };
    return next;
  },
  saveProviderExecutionSettings: (settings) => {
    providerSettings = normalizeAllProviderExecutionSettings(settings);
    return structuredClone(providerSettings);
  },
};

process.exitCode = await runOverview({
  bridge,
  settingsStore,
  workspace,
  defaultCwd: "/demo/wattari-gattari",
  refreshMs: 60_000,
  nativeHint: "데모 화면 · 실제 provider나 세션을 사용하지 않습니다",
});
