import assert from "node:assert/strict";
import test from "node:test";

import {
  shutdownDialogDecision,
  stopDialogDecision,
} from "../src/session-console-keys.mjs";

test("세션 종료 확인은 두 번째 Ctrl+X만 승인한다", () => {
  assert.equal(stopDialogDecision({ ctrl: true, name: "x" }), "confirm");
});

test("세션 종료 확인 중 다른 모든 키는 취소한다", () => {
  for (const key of [
    { name: "x", ctrl: false },
    { name: "y" },
    { name: "n" },
    { name: "escape" },
    { name: "return" },
    { ctrl: true, name: "c" },
  ]) {
    assert.equal(stopDialogDecision(key), "cancel");
  }
});

test("서비스 종료 확인은 두 번째 Ctrl+Q만 승인한다", () => {
  assert.equal(shutdownDialogDecision({ ctrl: true, name: "q" }), "confirm");
});

test("서비스 종료 확인 중 다른 모든 키는 취소한다", () => {
  for (const key of [
    { name: "q", ctrl: false },
    { name: "y" },
    { name: "n" },
    { name: "escape" },
    { name: "return" },
    { ctrl: true, name: "c" },
  ]) {
    assert.equal(shutdownDialogDecision(key), "cancel");
  }
});
