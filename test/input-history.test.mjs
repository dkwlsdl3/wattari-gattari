import assert from "node:assert/strict";
import test from "node:test";

import { InputHistory } from "../src/input-history.mjs";

test("상세 입력 기록을 과거 방향으로 순회하고 현재 초안을 복원한다", () => {
  const history = new InputHistory();
  history.setEntries(["첫 입력", "둘째 입력", "셋째 입력"]);

  assert.equal(history.previous("작성 중 초안"), "셋째 입력");
  assert.equal(history.previous("셋째 입력"), "둘째 입력");
  assert.equal(history.previous("둘째 입력"), "첫 입력");
  assert.equal(history.previous("첫 입력"), "첫 입력");
  assert.equal(history.next("첫 입력"), "둘째 입력");
  assert.equal(history.next("둘째 입력"), "셋째 입력");
  assert.equal(history.next("셋째 입력"), "작성 중 초안");
});

test("같은 transcript 갱신은 현재 입력 기록 위치를 초기화하지 않는다", () => {
  const history = new InputHistory();
  history.setEntries(["첫 입력", "둘째 입력"]);

  assert.equal(history.previous("초안"), "둘째 입력");
  history.setEntries(["첫 입력", "둘째 입력"]);

  assert.equal(history.previous("둘째 입력"), "첫 입력");
  assert.equal(history.next("첫 입력"), "둘째 입력");
  assert.equal(history.next("둘째 입력"), "초안");
});
