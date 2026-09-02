import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("runs through an npm-link-shaped executable symlink", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-cli-link-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const linkPath = path.join(directory, "waga");
  fs.symlinkSync(cliPath, linkPath);

  const result = spawnSync(linkPath, ["--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
});
