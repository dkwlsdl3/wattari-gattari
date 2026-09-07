#!/usr/bin/env node
// Read-only evidence inspection. Never launches tests or follows artifact paths.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const labels = { changed: "재검증 필요", insufficient: "판단 자료 부족", match: "기록과 일치" };

function inventory(directory) {
  const hashes = {};
  function visit(relative) {
    const filename = path.join(directory, relative);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) { hashes[relative] = null; return; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) visit(path.join(relative, name));
    } else if (!relative.endsWith("-review.json")) hashes[relative] = digest(fs.readFileSync(filename));
  }
  for (const name of ["src", "test", "scripts", "package.json", "package-lock.json"]) visit(name);
  return hashes;
}

function normalize(document, source) {
  if (!isObject(document)) throw new Error("보고서는 JSON 객체여야 합니다");
  const parts = document.groups ?? [document.mutation ?? document];
  if (!Array.isArray(parts) || !parts.length || parts.some((part) => !isObject(part))) throw new Error("잘못된 구획 형식");
  return parts.map((part) => ({
    source, group: part.group ?? null,
    observedAt: part.observedAt ?? document.observedAt ?? document.observedOn ?? null,
    node: part.node ?? document.node ?? document.tool?.node ?? document.stryker?.node ?? null,
    command: part.command ?? document.command ?? document.testCommand ?? document.stryker?.command ?? null,
    hashes: part.hashes ?? document.hashes ?? {
      ...document.sourceSha256, ...document.testSha256, ...document.sourceHashes, ...document.testHashes,
    },
    results: part.results ?? null,
    summary: document.finalTreeReplay?.finalClassification ?? document.finalTreeReplay
      ?? document.after ?? (Number.isInteger(document.killed) ? document : null),
    baseline: part.baseline ?? null, restoredBaseline: part.restoredBaseline ?? null,
  }));
}

function outcomes(record) {
  if (record.results !== null) {
    if (!Array.isArray(record.results)) throw new Error("잘못된 변이 결과 형식");
    const counts = {}, seen = new Set();
    for (const result of record.results) {
      if (!isObject(result) || typeof result.id !== "string" || typeof result.file !== "string"
        || !["killed", "survived", "test-timeout", "process-timeout", "runner-error"].includes(result.status)) {
        throw new Error("잘못된 변이 결과");
      }
      const identity = `${result.file}:${result.id}`;
      if (seen.has(identity)) throw new Error("중복 변이 결과");
      seen.add(identity);
      const status = result.fullSuite?.status ?? result.status;
      if (!["killed", "survived", "test-timeout", "process-timeout", "runner-error"].includes(status)) {
        throw new Error("잘못된 전체 테스트 결과");
      }
      counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
  }
  if (!record.summary) return null;
  const names = {
    killed: "killed", survived: "survived", timeouts: "timeout-unspecified",
    testTimeouts: "test-timeout", processTimeouts: "process-timeout",
    errors: "runner-error", runnerErrors: "runner-error", unresolvedSyntaxOrRunnerErrors: "runner-error",
    syntaxOrRunnerErrors: "runner-error",
  };
  const counts = {};
  for (const [key, name] of Object.entries(names)) {
    const value = record.summary[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) throw new Error("잘못된 결과 개수");
    counts[name] = value;
  }
  return Object.keys(counts).length ? counts : null;
}

function compare(record, current, node) {
  if (!isObject(record.hashes)) throw new Error("잘못된 해시 형식");
  const changed = [], missing = [], gaps = [];
  for (const [name, hash] of Object.entries(record.hashes)) {
    if (!/^(src\/|test\/|scripts\/|package(?:-lock)?\.json$)/.test(name)
      || name.split("/").includes("..") || !/^[a-f0-9]{64}$/.test(hash)) {
      gaps.push(`invalid hash: ${name}`); continue;
    }
    if (!(name in current)) missing.push(name);
    else if (current[name] !== hash) changed.push(name);
  }
  // Require the complete runner input inventory, not just mutated files.
  const unrecorded = Object.keys(current).filter((name) => !(name in record.hashes));
  if (unrecorded.length) gaps.push("현재 입력 파일 일부의 해시가 없습니다");
  if (!record.node) gaps.push("Node 버전 없음");
  else if (record.node.replace(/^v/, "") !== node.replace(/^v/, "")) changed.push("Node version");
  if (!(typeof record.command === "string" && record.command.trim())
    && !(Array.isArray(record.command) && record.command.length && record.command.every((arg) => typeof arg === "string" && arg))) {
    gaps.push("실행 명령 없음/잘못됨");
  }
  if (!record.observedAt || !Number.isFinite(Date.parse(record.observedAt))) gaps.push("검증 시각 없음/잘못됨");
  if (record.baseline?.status !== "survived" || !(record.baseline?.tests > 0)
    || record.restoredBaseline?.status !== "survived" || !(record.restoredBaseline?.tests > 0)) {
    gaps.push("정상/복구 baseline 상세 증거 부족");
  }
  return {
    status: changed.length || missing.length ? "changed" : gaps.length ? "insufficient" : "match",
    recordedFiles: Object.keys(record.hashes).length,
    changed, missing, unrecorded, gaps,
  };
}

export function mutationStatus({ directory = root, reports = [], node = process.version } = {}) {
  const current = inventory(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "test/mutation/cases.json"), "utf8"));
  const files = fs.readdirSync(path.join(directory, "test/mutation")).filter((name) => name.endsWith("-review.json"))
    .sort().map((name) => path.join(directory, "test/mutation", name));
  const records = [], errors = [];
  for (const file of [...new Set([...files, ...reports.map((file) => path.resolve(file))])]) {
    try {
      const rows = normalize(JSON.parse(fs.readFileSync(file, "utf8")), path.relative(directory, file));
      const inspected = rows.map((row) => ({ ...row, outcomes: outcomes(row), freshness: compare(row, current, node) }));
      records.push(...inspected);
    } catch (error) { errors.push({ source: path.relative(directory, file), message: error.message }); }
  }
  const groups = Object.entries(manifest).map(([group, config]) => ({
    group,
    cases: config.mutations.map(({ id, file }) => ({
      id, file,
      // Historical identity evidence only: changed definitions invalidate freshness via manifest hash.
      evidence: records.flatMap((record, index) => (record.results ?? [])
        .filter((result) => result.id === id && result.file === file && (!record.group || record.group === group))
        .map((result) => ({ record: index, status: result.fullSuite?.status ?? result.status }))),
    })),
  }));
  return { records, groups, errors };
}

export function formatMutationStatus(report) {
  const lines = ["변이 검증 기록 — 최신성과 결과는 별개입니다. 구획 간 중복 결과는 합산하지 않습니다."];
  for (const row of report.records) {
    lines.push(`${row.source}${row.group ? ` [${row.group}]` : ""} | ${row.observedAt ?? "시각 불명"} | ${labels[row.freshness.status]}`);
    lines.push(`  결과: ${row.outcomes ? Object.entries(row.outcomes).map(([key, count]) => `${key}=${count}`).join(", ") : "자료 없음"}`);
    const { changed, missing, unrecorded, gaps } = row.freshness;
    if (changed.length) lines.push(`  변경: ${changed.length}개 (${changed.slice(0, 2).join(", ")}${changed.length > 2 ? ", …; 전체는 --json" : ""})`);
    else if (!missing.length) lines.push(`  기록된 파일 해시 ${row.freshness.recordedFiles}개 비교; 전체 입력 확인 여부는 아래 한계 참고`);
    if (missing.length) lines.push(`  삭제/누락: ${missing.join(", ")}`);
    if (unrecorded.length) lines.push(`  해시 미기록 입력: ${unrecorded.length}개 (--json으로 확인)`);
    if (gaps.length) lines.push(`  한계: ${gaps.join("; ")}`);
  }
  lines.push("현재 선정 사례의 개별 결과 기록 (과거 기록 포함, 현재 통과 수가 아님):");
  for (const { group, cases } of report.groups) {
    const absent = cases.filter((entry) => !entry.evidence.length);
    lines.push(`  ${group}: 기록 ${cases.length - absent.length}/${cases.length}, 기록 없음 ${absent.length}`);
    if (absent.length) lines.push(`    ${absent.map((entry) => entry.id).join(", ")}`);
  }
  for (const error of report.errors) lines.push(`읽기/형식 오류: ${error.source}: ${error.message}`);
  lines.push("기록 없음은 미실행 확정이 아닙니다. 합계만 있는 기록으로 개별 사례를 완료 처리하지 않습니다.",
    "기록과 일치는 저장된 파일·Node 기준이며 외부 환경까지 보증하지 않습니다. 테스트별 검출 기여도·전체 코드 변이 커버리지는 계산하지 않습니다.");
  return lines.join("\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), reports = [];
    let json = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--json") json = true;
      else if (args[i] === "--report" && args[i + 1] && !args[i + 1].startsWith("--")) reports.push(args[++i]);
      else throw new Error("Usage: node scripts/mutation-status.mjs [--json] [--report report.json]...");
    }
    const result = mutationStatus({ reports });
    process.stdout.write(json ? JSON.stringify(result, null, 2) + "\n" : formatMutationStatus(result));
    if (result.errors.length) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
