import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutionStore, normalizeExecution } from "../src/execution-store.mjs";
import { executionGraph, eventContent } from "../src/web/executions.mjs";
const document = JSON.parse(fs.readFileSync(new URL("./fixtures/claude-workflow-otel.json", import.meta.url)));
const raw = value => value.resourceSpans[0].scopeSpans[0].spans;
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-execution-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new ExecutionStore(directory);
}

test("real Claude workflow trace preserves observed forks, not a guessed scan-to-edit dependency", () => {
  const { spans } = normalizeExecution(document), graph = executionGraph(spans);
  const main = graph.nodes.find(node => !node.agentId), scan = graph.nodes.find(node => node.spans.some(span => span.attributes.tool_name === "Read") && !node.spans.some(span => span.attributes.tool_name === "Edit")), fix = graph.nodes.find(node => node.spans.some(span => span.attributes.tool_name === "Edit"));
  assert.ok(main); assert.ok(scan); assert.ok(fix);
  assert.ok(graph.edges.some(edge => edge.from === main.id && edge.to === scan.id));
  assert.ok(graph.edges.some(edge => edge.from === main.id && edge.to === fix.id));
  assert.ok(!graph.edges.some(edge => edge.from === scan.id && edge.to === fix.id));
  assert.ok(spans.every(span => !["passed", "verified"].includes(span.state)));
  const bash = normalizeExecution(document, true).spans.filter(span => span.attributes.tool_name === "Bash");
  assert.match(JSON.stringify(bash[0].events), /AssertionError/);
  assert.match(JSON.stringify(bash.at(-1).events), /SUM_CHECK_OK/);
  assert.equal(bash[0].state, "returned"); assert.equal(bash.at(-1).state, "returned");
});

test("imports persist across store restart, deduplicate spans and documents, and scope listings", t => {
  const store = fixture(t), copy = structuredClone(document); raw(copy).push(...raw(copy));
  const first = store.import({ document }, "/tmp/waga-proof-one");
  const second = new ExecutionStore(store.directory).import({ document: copy }, "/tmp/waga-proof-one");
  assert.deepEqual(first, second);
  assert.equal(store.list("/tmp/waga-proof-one").length, 1); assert.deepEqual(store.list("/tmp/waga-proof-other"), []);
  assert.equal(fs.statSync(path.join(store.directory, `${first.id}.json`)).mode & 0o777, 0o600);
  assert.equal(store.list()[0].spans, undefined);
});

test("identity fields and content are excluded by default; content import is explicit and bounded", () => {
  const copy = structuredClone(document), span = raw(copy)[0];
  span.attributes.push({ key: "user.email", value: { stringValue: "private@example.invalid" } }, { key: "full_command", value: { stringValue: "PRIVATE_COMMAND" } });
  span.events = [{ name: "tool.output", attributes: [{ key: "output", value: { stringValue: "SECRET_OUTPUT" } }, { key: "user.email", value: { stringValue: "private@example.invalid" } }] }];
  copy.resourceSpans[0].resource = { attributes: [{ key: "user.email", value: { stringValue: "private@example.invalid" } }] };
  const safe = JSON.stringify(normalizeExecution(copy));
  assert.ok(!safe.includes("private@example.invalid")); assert.ok(!safe.includes("SECRET_OUTPUT")); assert.ok(!safe.includes("PRIVATE_COMMAND"));
  const full = JSON.stringify(normalizeExecution(copy, true));
  assert.ok(full.includes("SECRET_OUTPUT")); assert.ok(full.includes("PRIVATE_COMMAND")); assert.ok(!full.includes("private@example.invalid"));
});

test("missing parents and cyclic call ancestry terminate without inventing edges; incomplete spans stay unknown", () => {
  const { spans } = normalizeExecution(document);
  const copy = structuredClone(spans[0]); copy.parentSpanId = copy.spanId;
  assert.doesNotThrow(() => executionGraph([copy])); assert.deepEqual(executionGraph([copy]).edges, []);
  copy.parentSpanId = "1234567890123456"; assert.deepEqual(executionGraph([copy]).edges, []);
  const input = structuredClone(document); raw(input)[0].endTimeUnixNano = undefined;
  assert.equal(normalizeExecution(input).spans.find(span => span.spanId === raw(input)[0].spanId).state, "unknown");
  raw(input)[0].status = { code: 2 };
  assert.equal(normalizeExecution(input).spans.find(span => span.spanId === raw(input)[0].spanId).state, "error");
});

test("invalid OTLP, timestamps, too many spans and path traversal are rejected", t => {
  const store = fixture(t);
  for (const input of [{}, { resourceSpans: [] }]) assert.throws(() => normalizeExecution(input), { status: 400 });
  const copy = structuredClone(document); raw(copy)[0].traceId = "bad";
  assert.throws(() => normalizeExecution(copy), { status: 400 });
  raw(copy)[0] = structuredClone(raw(document)[0]); raw(copy)[0].endTimeUnixNano = "1";
  assert.throws(() => normalizeExecution(copy), { status: 400 });
  raw(copy).splice(0, raw(copy).length, ...Array.from({ length: 5001 }, () => raw(document)[0]));
  assert.throws(() => normalizeExecution(copy), { status: 413 });
  assert.throws(() => store.read("../../secret"), { status: 400 });
  assert.throws(() => store.read("f".repeat(64)), { status: 404 });
});

test("native Edit structured hunks display as a readable diff, with other content left intact", () => {
  const edit = normalizeExecution(document, true).spans.find(span => span.attributes.tool_name === "Edit");
  const diff = edit.events.find(event => event.content.diff).content.diff;
  assert.match(eventContent("diff", diff), /@@ -1,1 \+1,1 @@\n-export const sum.*a - b;\n\+export const sum.*a \+ b;/);
  assert.equal(eventContent("output", diff), diff);
  assert.equal(eventContent("diff", "unstructured diff"), "unstructured diff");
  assert.equal(eventContent("diff", '[{"lines":[3]}]'), '[{"lines":[3]}]');
});
