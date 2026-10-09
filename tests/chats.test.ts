import assert from "node:assert/strict";
import { test } from "node:test";
import { matchChats, resolveChatCommand } from "../src/chats.ts";

const chats = [
  { chatId: -1, title: "сади" },
  { chatId: -2, title: "лівий" },
  { chatId: -3, title: "Лівий берег" },
];

test("matchChats prefers exact title then substring", () => {
  assert.deepEqual(
    matchChats("сади", chats).map((chat) => chat.chatId),
    [-1],
  );
  assert.deepEqual(
    matchChats("лів", [
      { chatId: -1, title: "сади" },
      { chatId: -2, title: "лівий" },
    ]).map((chat) => chat.chatId),
    [-2],
  );
});

test("resolveChatCommand splits group name and keyword", () => {
  const found = resolveChatCommand("сади Буча", chats);
  assert.equal(found.ok, true);
  if (found.ok) {
    assert.equal(found.chat.title, "сади");
    assert.equal(found.rest, "Буча");
  }

  const prefix = resolveChatCommand("Лівий берег Ірпінь", chats);
  assert.equal(prefix.ok, true);
  if (prefix.ok) {
    assert.equal(prefix.chat.title, "Лівий берег");
    assert.equal(prefix.rest, "Ірпінь");
  }
});

test("resolveChatCommand reports empty, missing and ambiguous groups", () => {
  assert.equal(resolveChatCommand("", chats).ok, false);
  const missing = resolveChatCommand("київ Буча", chats);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, "not_found");
  }
  const ambiguous = resolveChatCommand("лів Буча", chats);
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.reason, "ambiguous");
    assert.equal(ambiguous.matches.length, 2);
  }
});
