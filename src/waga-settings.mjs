import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { APP_ID } from "./product.mjs";
import { CODEX_EXECUTION_MODES, isCodexExecutionMode } from "./codex-execution.mjs";
import {
  codexExecutionModeForSettings,
  codexSettingsForExecutionMode,
  defaultProviderExecutionSettings,
  normalizeAllProviderExecutionSettings,
  normalizeProviderExecutionSettings,
} from "./provider-execution.mjs";

const VERSION = 2;

function invalid(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: "WAGA_SETTINGS_INVALID" });
}

function defaultDocument() {
  return { version: VERSION, providers: defaultProviderExecutionSettings() };
}

function validate(document) {
  if (document?.version === 1 && isCodexExecutionMode(document.codexExecutionMode)) {
    const migrated = defaultDocument();
    migrated.providers.codex = codexSettingsForExecutionMode(document.codexExecutionMode, migrated.providers.codex);
    return migrated;
  }
  if (document?.version !== VERSION || !document.providers || typeof document.providers !== "object") {
    throw invalid("Waga settings file has an unsupported shape");
  }
  try {
    return { ...document, version: VERSION, providers: normalizeAllProviderExecutionSettings(document.providers) };
  } catch (error) {
    throw invalid("Waga settings file has an unsupported provider settings shape", error);
  }
}

export function defaultWagaSettingsPath(env = process.env, homeDirectory = os.homedir()) {
  const configDirectory = env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config");
  return path.join(configDirectory, APP_ID, "settings.json");
}

export class WagaSettingsStore {
  constructor(filePath = defaultWagaSettingsPath()) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new TypeError("Waga settings path must be absolute");
    this.filePath = filePath;
  }

  load() {
    const document = this.#read();
    return {
      version: document.version,
      providers: structuredClone(document.providers),
      codexExecutionMode: codexExecutionModeForSettings(document.providers.codex),
    };
  }

  setCodexExecutionMode(mode) {
    if (!isCodexExecutionMode(mode)) throw new TypeError("Unknown Codex execution mode");
    const document = this.#read();
    document.providers.codex = codexSettingsForExecutionMode(mode, document.providers.codex);
    this.#write(document);
    return mode;
  }

  toggleCodexExecutionMode() {
    const document = this.#read();
    const current = codexExecutionModeForSettings(document.providers.codex);
    const next = current === CODEX_EXECUTION_MODES.YOLO
      ? CODEX_EXECUTION_MODES.DEFAULT
      : CODEX_EXECUTION_MODES.YOLO;
    document.providers.codex = codexSettingsForExecutionMode(next, document.providers.codex);
    this.#write(document);
    return next;
  }

  setProviderExecutionSettings(provider, settings) {
    const document = this.#read();
    document.providers[provider] = normalizeProviderExecutionSettings(provider, settings);
    this.#write(document);
    return structuredClone(document.providers[provider]);
  }

  saveProviderExecutionSettings(settings) {
    const document = this.#read();
    document.providers = normalizeAllProviderExecutionSettings(settings);
    this.#write(document);
    return structuredClone(document.providers);
  }

  #read() {
    if (!fs.existsSync(this.filePath)) return defaultDocument();
    try {
      return validate(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error.code === "WAGA_SETTINGS_INVALID") throw error;
      throw invalid(`Waga settings file could not be read: ${this.filePath}`, error);
    }
  }

  #write(document) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
