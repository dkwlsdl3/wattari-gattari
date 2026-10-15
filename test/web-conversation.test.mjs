import assert from "node:assert/strict";
import test from "node:test";
import { conversationItems, readableReply } from "../src/web/conversation.mjs";

const requestId = "148bd718-8f83-4e38-9500-b6e360295ffd";
const reply = `[WAGA REPLY ${requestId}]\n다음은 검증을 막은 tmux 문제 2건을 진단·수정하는 것입니다.`;

test("native preview and recovered exchange produce one readable answer", () => {
  const records = [{ operationId: "query", requestId, reply, at: 1 }, { operationId: "recover", requestId, reply, at: 2 }];
  const items = conversationItems({ preview: { input: "검증에서 막힘 되있는데", output: reply }, records: [...records].reverse(), inputs: new Map([["query", "그래서 다음은 뭐해야하는데"]]) });
  assert.deepEqual(items.map(row => row.role), ["user", "assistant"]);
  assert.equal(items[1].text, readableReply(reply)); assert.ok(!items[1].text.includes("WAGA REPLY"));
});

test("duplicate detection handles bounded previews without suppressing separate requests", () => {
  const text = "검증 결과를 확인했습니다. ".repeat(30);
  const records = [{ operationId: "one", requestId: "one", reply: text }, { operationId: "two", requestId: "two", reply: text }];
  const items = conversationItems({ preview: { output: text.slice(0, 100), limited: true }, records });
  assert.equal(items.length, 2);
  assert.equal(conversationItems({ preview: { output: "다른 작업의 최근 응답" }, records }).length, 3);
});

test("pending input appears immediately and unrelated native text stays intact", () => {
  const pending = { kind: "query", operationId: "pending" };
  const items = conversationItems({ pending, inputs: new Map([["pending", "첫 줄\n두 번째 줄"]]) });
  assert.equal(items[0].text, "첫 줄\n두 번째 줄");
  assert.equal(readableReply("문서에서 [WAGA REPLY example]를 설명합니다."), "문서에서 [WAGA REPLY example]를 설명합니다.");
  assert.deepEqual(conversationItems({ preview: { input: "질문", output: "<script>alert(1)</script>" } }).map(row => row.text), ["질문", "<script>alert(1)</script>"]);
});

test("a pending user instruction is shown before any native answer arrives", () => {
  const pending = { kind: "instruct", operationId: "user-task" };
  const items = conversationItems({ pending, inputs: new Map([[pending.operationId, "파일을 수정해 주세요"]]) });
  assert.deepEqual(items.map(row => [row.role, row.text]), [["user", "파일을 수정해 주세요"]]);
});

test("native history keeps repeated turns and merges only the matching completed web exchange", () => {
  const history = [
    { id: "u1", turnId: "t1", role: "user", text: "같은 질문" },
    { id: "a1", turnId: "t1", role: "assistant", text: "답변 1" },
    { id: "u2", turnId: "t2", role: "user", text: "같은 질문" },
    { id: "a2", turnId: "t2", role: "assistant", text: "답변 2" },
  ];
  const items = conversationItems({ history, records: [{ operationId: "web", turnId: "t2", reply: "답변 2" }], inputs: new Map([["web", "같은 질문"]]) });
  assert.deepEqual(items.map(row => row.text), history.map(row => row.text));
});
