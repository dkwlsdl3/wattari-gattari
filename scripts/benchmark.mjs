#!/usr/bin/env node

import { performance } from "node:perf_hooks";

import {
  applyOverviewOrder,
  buildOverviewFrame,
  buildOverviewTree,
  reconcileOverviewOrder,
} from "../src/overview.mjs";
import { SessionBridge } from "../src/session-bridge.mjs";

const SESSION_COUNT = 1_000;
const WARMUP_RUNS = 20;
const SAMPLE_RUNS = 100;
const budgets = {
  bridgeProcessingP95Ms: 10,
  frameBuildP95Ms: 25,
};

function sessionsFor(provider) {
  return Array.from({ length: SESSION_COUNT / 2 }, (_, index) => ({
    id: `${provider}:waga-proof-${index}`,
    nativeId: `waga-proof-${index}`,
    provider,
    name: `${provider === "claude" ? "검증" : "review"} ${index} 🚦`,
    cwd: `/tmp/waga-proof-performance/project-${index % 40}`,
    status: ["idle", "working", "needs-input"][index % 3],
    updatedAt: SESSION_COUNT - index,
  }));
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function measure(operation) {
  for (let index = 0; index < WARMUP_RUNS; index += 1) await operation();
  const samples = [];
  for (let index = 0; index < SAMPLE_RUNS; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    p50Ms: percentile(samples, 0.50),
    p95Ms: percentile(samples, 0.95),
    maxMs: samples.at(-1),
  };
}

const claude = sessionsFor("claude");
const codex = sessionsFor("codex");
const bridge = new SessionBridge({
  providers: [
    { name: "claude", async list() { return claude; } },
    { name: "codex", async list() { return codex; } },
  ],
});
const allSessions = [...claude, ...codex];
const order = reconcileOverviewOrder(new Map(), allSessions);

const bridgeProcessing = await measure(() => bridge.discover());
const frameBuild = await measure(() => {
  const ordered = applyOverviewOrder(allSessions, order);
  const nodes = buildOverviewTree(ordered);
  return buildOverviewFrame({ sessions: ordered, nodes, width: 120, height: 40 });
});
const previewFrameBuild = await measure(() => buildOverviewFrame({
  sessions: allSessions, selected: 1, width: 160, height: 40,
  preview: { state: "ready", input: "프롬프트 preview\n".repeat(400), output: "응답 response\n".repeat(400), checkedAt: 0 },
}));
const result = {
  scope: "In-memory bridge processing and frame string construction; excludes provider CLI/RPC/parsing and terminal drawing",
  node: process.version,
  sessions: SESSION_COUNT,
  samples: SAMPLE_RUNS,
  bridgeProcessing,
  frameBuild,
  previewFrameBuild,
  rssMiB: process.memoryUsage().rss / 1024 / 1024,
  budgets,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
const failures = [];
if (bridgeProcessing.p95Ms > budgets.bridgeProcessingP95Ms) failures.push(`bridge processing p95 ${bridgeProcessing.p95Ms.toFixed(2)}ms > ${budgets.bridgeProcessingP95Ms}ms`);
if (frameBuild.p95Ms > budgets.frameBuildP95Ms) failures.push(`frame build p95 ${frameBuild.p95Ms.toFixed(2)}ms > ${budgets.frameBuildP95Ms}ms`);
if (previewFrameBuild.p95Ms > budgets.frameBuildP95Ms) failures.push(`preview frame p95 ${previewFrameBuild.p95Ms.toFixed(2)}ms > ${budgets.frameBuildP95Ms}ms`);
if (failures.length) {
  process.stderr.write(`Performance budget exceeded: ${failures.join(", ")}\n`);
  process.exitCode = 1;
}
