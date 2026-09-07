import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mutationStatus, formatMutationStatus } from "../scripts/mutation-status.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-status-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = {
    "src/example.mjs": "export const value = 1;",
    "test/example.test.mjs": "// fixture",
    "scripts/mutation-check.mjs": "// runner fixture",
    "package.json": "{}", "package-lock.json": "{}",
    "test/mutation/cases.json": JSON.stringify({ example: { tests: ["test/example.test.mjs"], mutations: [
      { id: "change-value", file: "src/example.mjs", from: "1", to: "2" },
      { id: "not-recorded", file: "src/example.mjs", from: "1", to: "0" },
    ] } }),
  };
  function write(name, value) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  }
  for (const [name, text] of Object.entries(files)) write(name, text);
  const record = {
    group: "example", observedAt: "2026-09-07T01:00:00Z", node: process.version,
    command: ["node", "--test", "test/example.test.mjs"],
    hashes: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hash(text)])),
    baseline: { status: "survived", tests: 1 }, restoredBaseline: { status: "survived", tests: 1 },
    results: [{ id: "change-value", file: "src/example.mjs", status: "killed" }],
  };
  return { directory, record, write, inspect: (options = {}) => mutationStatus({ directory, ...options }) };
}

test("mutation status separates matched inputs, outcomes and missing case evidence without writes", (t) => {
  const f = fixture(t);
  f.write("test/mutation/example-review.json", f.record);
  const before = fs.readFileSync(path.join(f.directory, "test/mutation/example-review.json"));
  const report = f.inspect();
  assert.equal(report.errors.length, 0);
  assert.equal(report.records[0].freshness.status, "match");
  assert.deepEqual(report.records[0].outcomes, { killed: 1 });
  assert.equal(report.groups[0].cases[0].evidence[0].record, 0);
  assert.deepEqual(report.groups[0].cases[1].evidence, []);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "test/mutation/example-review.json")), before);
  const text = formatMutationStatus(report);
  assert.match(text, /기록과 일치/);
  assert.match(text, /기록 1\/2, 기록 없음 1/);
  assert.match(text, /not-recorded/);
  assert.match(text, /미실행 확정이 아닙니다/);
});

test("mutation status invalidates source, tests, lockfile, runner, manifest and Node changes", (t) => {
  const f = fixture(t);
  f.write("test/mutation/example-review.json", f.record);
  for (const name of ["src/example.mjs", "test/example.test.mjs", "package-lock.json", "scripts/mutation-check.mjs"]) f.write(name, "changed");
  f.write("test/mutation/cases.json", { example: { mutations: [{ id: "new-case", file: "src/example.mjs" }] } });
  const report = f.inspect({ node: "v99.0.0" });
  assert.equal(report.records[0].freshness.status, "changed");
  assert.deepEqual(report.records[0].freshness.changed.sort(), ["Node version", "package-lock.json", "scripts/mutation-check.mjs", "src/example.mjs", "test/example.test.mjs", "test/mutation/cases.json"].sort());
  assert.deepEqual(report.groups[0].cases[0].evidence, []);
  assert.match(formatMutationStatus(report), /변경: 6개/);
});

test("new files, partial hashes and missing environment never claim current validity", (t) => {
  const f = fixture(t);
  delete f.record.node;
  delete f.record.command;
  delete f.record.restoredBaseline;
  f.record.observedAt = "invalid";
  f.write("test/mutation/example-review.json", f.record);
  f.write("test/new.test.mjs", "new");
  const { freshness } = f.inspect().records[0];
  assert.equal(freshness.status, "insufficient");
  assert.deepEqual(freshness.unrecorded, ["test/new.test.mjs"]);
  assert.equal(freshness.gaps.length, 5);
  const text = formatMutationStatus(f.inspect());
  assert.match(text, /해시 미기록 입력: 1개/);
  assert.match(text, /한계:/);
});

test("missing inputs and symlinks are not followed or reported as matching", (t) => {
  const f = fixture(t);
  f.write("test/mutation/example-review.json", f.record);
  fs.unlinkSync(path.join(f.directory, "src/example.mjs"));
  fs.symlinkSync("/does-not-exist", path.join(f.directory, "src/example.mjs"));
  fs.unlinkSync(path.join(f.directory, "test/example.test.mjs"));
  const report = f.inspect();
  assert.equal(report.records[0].freshness.status, "changed");
  assert.deepEqual(report.records[0].freshness.changed, ["src/example.mjs"]);
  assert.deepEqual(report.records[0].freshness.missing, ["test/example.test.mjs"]);
  assert.match(formatMutationStatus(report), /삭제\/누락: test\/example.test.mjs/);
});

test("summary-only records preserve survivor and timeout categories without invented case evidence", (t) => {
  const f = fixture(t);
  f.write("test/mutation/summary-review.json", {
    observedOn: "2026-09-07", tool: { node: process.version }, testCommand: "node --test",
    sourceSha256: { "src/example.mjs": f.record.hashes["src/example.mjs"] },
    after: { killed: 10, survived: 2, timeouts: 1, errors: 0 },
  });
  const report = f.inspect();
  assert.deepEqual(report.records[0].outcomes, { killed: 10, survived: 2, "timeout-unspecified": 1, "runner-error": 0 });
  assert.equal(report.records[0].freshness.status, "insufficient");
  assert.ok(report.groups[0].cases.every((c) => !c.evidence.length));
});

test("group and nested reports keep histories separate and use full-suite outcomes", (t) => {
  const f = fixture(t);
  f.record.results[0] = { ...f.record.results[0], status: "survived", fullSuite: { status: "killed" } };
  f.write("test/mutation/groups-review.json", { ...f.record, groups: [{ ...f.record, results: [
    f.record.results[0], { id: "timeout", file: "src/example.mjs", status: "test-timeout" },
  ] }] });
  f.write("test/mutation/nested-review.json", { mutation: f.record });
  const report = f.inspect();
  assert.equal(report.records.length, 2);
  assert.deepEqual(report.records[0].outcomes, { killed: 1, "test-timeout": 1 });
  assert.deepEqual(report.records[1].outcomes, { killed: 1 });
  assert.equal(report.groups[0].cases[0].evidence.length, 2);
});

test("final mechanical replay takes precedence over Stryker aggregation", (t) => {
  const f = fixture(t);
  f.write("test/mutation/replay-review.json", {
    stryker: { node: process.version, command: "node --test" },
    after: { killed: 100 },
    finalTreeReplay: { finalClassification: { killed: 65, testTimeouts: 41, processTimeouts: 0, survived: 10, syntaxOrRunnerErrors: 0 } },
  });
  assert.deepEqual(f.inspect().records[0].outcomes, { killed: 65, survived: 10, "test-timeout": 41, "process-timeout": 0, "runner-error": 0 });
});

test("extra reports are explicit and artifact paths are never traversed", (t) => {
  const f = fixture(t);
  f.record.artifacts = "/does-not-exist/report.json";
  const file = f.write("output/report.json", f.record);
  assert.equal(f.inspect().records.length, 0);
  const report = f.inspect({ reports: [file, file] });
  assert.equal(report.records.length, 1);
  assert.equal(report.records[0].freshness.status, "match");
  const missing = f.inspect({ reports: [path.join(f.directory, "absent.json")] });
  assert.equal(missing.errors.length, 1);
  assert.match(formatMutationStatus(missing), /읽기\/형식 오류/);
});

test("malformed records remain visible as errors while healthy records survive", (t) => {
  const f = fixture(t);
  const bad = ["{", "null", { groups: [null] }, { groups: [] }, { results: {} }, { results: [{}] },
    { results: [f.record.results[0], f.record.results[0]] },
    { results: [{ id: "x", file: "src/example.mjs", status: "survived", fullSuite: { status: "bogus" } }] },
    { killed: -1 }, { hashes: [] }];
  bad.forEach((value, i) => f.write(`test/mutation/bad${i}-review.json`, value));
  f.write("test/mutation/good-review.json", f.record);
  const report = f.inspect();
  assert.equal(report.errors.length, bad.length);
  assert.equal(report.records.length, 1);
});

test("unsafe hash paths, unknown formats and unknown counts cannot certify results", (t) => {
  const f = fixture(t);
  f.record.hashes["../../outside"] = "a".repeat(64);
  f.record.hashes["src/invalid.mjs"] = "invalid";
  f.write("test/mutation/unsafe-review.json", f.record);
  f.write("test/mutation/unknown-review.json", {});
  const report = f.inspect();
  assert.ok(report.records.every((r) => r.freshness.status === "insufficient"));
  assert.match(formatMutationStatus(report), /자료 없음/);
  assert.ok(report.records[1].freshness.gaps.some((g) => g.includes("invalid hash")));
});

test("real historical record formats and current manifest are understood", () => {
  const report = mutationStatus();
  assert.deepEqual(report.errors, []);
  assert.ok(report.records.length >= 12);
  const trust = report.records.find((r) => r.source.endsWith("trust-review.json"));
  assert.equal(trust.outcomes.killed, 203);
  assert.equal(trust.outcomes.survived, 7);
  const title = report.records.find((r) => r.source.endsWith("title-review.json"));
  assert.equal(title.outcomes.killed, 8);
  // Do not assert live source freshness: it would itself kill unrelated source mutants.
  assert.equal(report.groups.find((g) => g.group === "title").cases.length, 8);
});

test("CLI prints JSON and text without launching mutations; rejects invalid input", () => {
  const run = (...args) => spawnSync(process.execPath, ["scripts/mutation-status.mjs", ...args], { cwd: root, encoding: "utf8" });
  const json = run("--json");
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).records.length, mutationStatus().records.length);
  const text = run();
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /최신성과 결과는 별개/);
  for (const args of [["--bogus"], ["--report"], ["--report", "--json"]]) {
    const bad = run(...args);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Usage:/);
  }
  const missing = run("--json", "--report", "/does-not-exist/report.json");
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).errors.length, 1);
});
