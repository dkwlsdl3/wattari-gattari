import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CODEX_EXECUTION_MODES } from "../src/codex-execution.mjs";
import { defaultProviderExecutionSettings } from "../src/provider-execution.mjs";
import { defaultWagaSettingsPath, WagaSettingsStore } from "../src/waga-settings.mjs";

test("Waga settings follow XDG config conventions", () => {
  assert.equal(defaultWagaSettingsPath({ XDG_CONFIG_HOME: "/tmp/config" }, "/home/demo"), "/tmp/config/wattari-gattari/settings.json");
  assert.equal(defaultWagaSettingsPath({}, "/home/demo"), "/home/demo/.config/wattari-gattari/settings.json");
});

test("Waga settings default safely and persist the Codex execution toggle", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  const store = new WagaSettingsStore(file);

  assert.deepEqual(store.load(), { version: 2, providers: defaultProviderExecutionSettings(), codexExecutionMode: CODEX_EXECUTION_MODES.DEFAULT });
  assert.equal(store.toggleCodexExecutionMode(), CODEX_EXECUTION_MODES.YOLO);
  assert.equal(new WagaSettingsStore(file).load().codexExecutionMode, CODEX_EXECUTION_MODES.YOLO);
  assert.equal(store.toggleCodexExecutionMode(), CODEX_EXECUTION_MODES.DEFAULT);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => store.setCodexExecutionMode("unsafe"), /Unknown Codex execution mode/);
});

test("Waga settings migrate the legacy toggle and persist both provider profiles", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-settings-migrate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  fs.writeFileSync(file, '{"version":1,"codexExecutionMode":"yolo"}\n');
  const store = new WagaSettingsStore(file);
  assert.equal(store.load().codexExecutionMode, CODEX_EXECUTION_MODES.YOLO);
  const saved = store.saveProviderExecutionSettings({
    claude: { permissionMode: "acceptEdits", options: { bare: true } },
    codex: { approvalPolicy: "on-request", sandbox: "workspace-write", summary: "detailed" },
  });
  assert.equal(saved.claude.permissionMode, "acceptEdits");
  assert.equal(saved.codex.sandbox, "workspace-write");
  const loaded = new WagaSettingsStore(file).load();
  assert.equal(loaded.version, 2);
  assert.equal(loaded.providers.claude.options.bare, true);
  assert.equal(loaded.providers.codex.approvalPolicy, "on-request");
  assert.equal(loaded.providers.codex.summary, "detailed");
});

test("Waga settings reject corrupt state without overwriting it", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  fs.writeFileSync(file, '{"version":1,"codexExecutionMode":"unknown"}\n');
  const store = new WagaSettingsStore(file);
  assert.throws(() => store.load(), { code: "WAGA_SETTINGS_INVALID" });
  assert.throws(() => store.toggleCodexExecutionMode(), { code: "WAGA_SETTINGS_INVALID" });
  assert.match(fs.readFileSync(file, "utf8"), /unknown/);
});

test("Waga settings keep the last valid file when an atomic rename fails", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  const store = new WagaSettingsStore(file);
  store.setCodexExecutionMode(CODEX_EXECUTION_MODES.DEFAULT);
  const original = fs.readFileSync(file, "utf8");
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  t.mock.method(fs, "renameSync", () => { throw failure; });
  assert.throws(() => store.setCodexExecutionMode(CODEX_EXECUTION_MODES.YOLO), (error) => error === failure);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(fs.readdirSync(directory), ["settings.json"]);
});
