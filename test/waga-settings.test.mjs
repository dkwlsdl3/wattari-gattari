import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CODEX_EXECUTION_MODES } from "../src/codex-execution.mjs";
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

  assert.deepEqual(store.load(), { codexExecutionMode: CODEX_EXECUTION_MODES.DEFAULT });
  assert.equal(store.toggleCodexExecutionMode(), CODEX_EXECUTION_MODES.YOLO);
  assert.deepEqual(new WagaSettingsStore(file).load(), { codexExecutionMode: CODEX_EXECUTION_MODES.YOLO });
  assert.equal(store.toggleCodexExecutionMode(), CODEX_EXECUTION_MODES.DEFAULT);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => store.setCodexExecutionMode("unsafe"), /Unknown Codex execution mode/);
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
