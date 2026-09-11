import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Database,
  DuplicateKeywordError,
  InvalidKeywordError,
  KeywordLimitError,
} from "../src/db.ts";
import { KEYWORD_LIMIT } from "../src/matcher.ts";

function tempDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "alert-bot-"));
  return new Database(join(dir, "bot.db"));
}

test("add and remove keywords persist and are case-insensitive", () => {
  const db = tempDb();
  assert.equal(db.addKeyword("  Буча  "), "Буча");
  assert.throws(() => db.addKeyword("буча"), DuplicateKeywordError);
  assert.deepEqual(
    db.listKeywords().map((item) => item.displayText),
    ["Буча"],
  );
  assert.equal(db.removeKeyword("БУЧА"), "Буча");
  assert.equal(db.removeKeyword("Буча"), null);
  db.close();
});

test("listKeywords is alphabetical in Ukrainian", () => {
  const db = tempDb();
  db.addKeyword("Чабани");
  db.addKeyword("Ірпінь");
  db.addKeyword("Буча");
  assert.deepEqual(
    db.listKeywords().map((item) => item.displayText),
    ["Буча", "Ірпінь", "Чабани"],
  );
  db.close();
});

test("rejects invalid keywords and enforces the 50-item limit", () => {
  const db = tempDb();
  assert.throws(() => db.addKeyword("x"), InvalidKeywordError);
  for (let i = 0; i < KEYWORD_LIMIT; i += 1) {
    db.addKeyword(`k${String(i).padStart(2, "0")}`);
  }
  assert.throws(() => db.addKeyword("overflow"), KeywordLimitError);
  db.close();
});

test("settings and sent-alert dedup survive writes", () => {
  const db = tempDb();
  assert.equal(db.getSettings().destChatId, null);
  db.setDestChatId(-100123);
  db.setPaused(true);
  assert.deepEqual(db.getSettings(), { destChatId: -100123, paused: true });

  assert.equal(db.getSentKeywords(1, 10), null);
  db.upsertSent(1, 10, ["буча"]);
  assert.deepEqual(db.getSentKeywords(1, 10), ["буча"]);
  db.upsertSent(1, 10, ["буча", "ракета"]);
  assert.deepEqual(db.getSentKeywords(1, 10), ["буча", "ракета"]);
  db.close();
});
