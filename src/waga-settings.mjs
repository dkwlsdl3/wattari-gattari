import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { APP_ID } from "./product.mjs";
import { CODEX_EXECUTION_MODES, isCodexExecutionMode } from "./codex-execution.mjs";

const VERSION = 1;

function invalid(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: "WAGA_SETTINGS_INVALID" });
}

function validate(document) {
  if (document?.version !== VERSION || !isCodexExecutionMode(document.codexExecutionMode)) {
    throw invalid("Waga settings file has an unsupported shape");
  }
  return document;
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
    return { codexExecutionMode: this.#read().codexExecutionMode };
  }

  setCodexExecutionMode(mode) {
    if (!isCodexExecutionMode(mode)) throw new TypeError("Unknown Codex execution mode");
    const document = this.#read();
    document.codexExecutionMode = mode;
    this.#write(document);
    return mode;
  }

  toggleCodexExecutionMode() {
    const document = this.#read();
    document.codexExecutionMode = document.codexExecutionMode === CODEX_EXECUTION_MODES.YOLO
      ? CODEX_EXECUTION_MODES.DEFAULT
      : CODEX_EXECUTION_MODES.YOLO;
    this.#write(document);
    return document.codexExecutionMode;
  }

  #read() {
    if (!fs.existsSync(this.filePath)) return { version: VERSION, codexExecutionMode: CODEX_EXECUTION_MODES.DEFAULT };
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
