import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  Database,
  DuplicateKeywordError,
  InvalidKeywordError,
  KeywordLimitError,
} from "../src/db.ts";
import { KEYWORD_LIMIT } from "../src/matcher.ts";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "alert-bot-")), "bot.db");
}

function tempDb(): Database {
  return new Database(tempPath());
}

test("add and remove keywords persist per chat and are case-insensitive", () => {
  const db = tempDb();
  db.upsertChat(-1, "сади");
  db.upsertChat(-2, "лівий");
  assert.equal(db.addKeyword(-1, "  Буча  "), "Буча");
  assert.throws(() => db.addKeyword(-1, "буча"), DuplicateKeywordError);
  assert.equal(db.addKeyword(-2, "буча"), "буча");
  assert.deepEqual(
    db.listKeywords(-1).map((item) => item.displayText),
    ["Буча"],
  );
  assert.equal(db.removeKeyword(-1, "БУЧА"), "Буча");
  assert.equal(db.removeKeyword(-1, "Буча"), null);
  assert.equal(db.listKeywords(-2).length, 1);
  db.close();
});

test("listKeywords is alphabetical in Ukrainian", () => {
  const db = tempDb();
  db.upsertChat(-1, "сади");
  db.addKeyword(-1, "Чабани");
  db.addKeyword(-1, "Ірпінь");
  db.addKeyword(-1, "Буча");
  assert.deepEqual(
    db.listKeywords(-1).map((item) => item.displayText),
    ["Буча", "Ірпінь", "Чабани"],
  );
  db.close();
});

test("rejects invalid keywords and enforces the 50-item limit per chat", () => {
  const db = tempDb();
  db.upsertChat(-1, "сади");
  db.upsertChat(-2, "лівий");
  assert.throws(() => db.addKeyword(-1, "x"), InvalidKeywordError);
  for (let i = 0; i < KEYWORD_LIMIT; i += 1) {
    db.addKeyword(-1, `k${String(i).padStart(2, "0")}`);
  }
  assert.throws(() => db.addKeyword(-1, "overflow"), KeywordLimitError);
  assert.equal(db.addKeyword(-2, "overflow"), "overflow");
  db.close();
});

test("chat pause and sent-alert dedup are per destination", () => {
  const db = tempDb();
  db.upsertChat(-100123, "сади");
  db.upsertChat(-100124, "лівий");
  db.setPaused(-100123, true);
  assert.equal(db.getChat(-100123)?.paused, true);
  assert.equal(db.getChat(-100124)?.paused, false);

  assert.equal(db.getSentKeywords(-100123, 10), null);
  db.upsertSent(-100123, 1, 10, ["буча"]);
  assert.deepEqual(db.getSentKeywords(-100123, 10), ["буча"]);
  assert.equal(db.getSentKeywords(-100124, 10), null);
  db.upsertSent(-100123, 1, 10, ["буча", "ракета"]);
  assert.deepEqual(db.getSentKeywords(-100123, 10), ["буча", "ракета"]);
  db.close();
});

test("migrates legacy global keywords onto dest chat", () => {
  const path = tempPath();
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE keywords (
      normalized TEXT PRIMARY KEY,
      display_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      dest_chat_id INTEGER,
      paused INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO settings (id, dest_chat_id, paused) VALUES (1, -1001, 1);
    INSERT INTO keywords VALUES ('буча', 'Буча', '2026-01-01T00:00:00.000Z');
    CREATE TABLE sent_alerts (
      channel_id INTEGER NOT NULL,
      channel_msg_id INTEGER NOT NULL,
      matched_keywords TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, channel_msg_id)
    );
    INSERT INTO sent_alerts VALUES (-100555, 10, '["буча"]', '2026-01-01T00:00:00.000Z');
  `);
  raw.close();

  const db = new Database(path);
  const chats = db.listChats();
  assert.equal(chats.length, 1);
  assert.equal(chats[0]?.chatId, -1001);
  assert.equal(chats[0]?.paused, true);
  assert.deepEqual(
    db.listKeywords(-1001).map((item) => item.displayText),
    ["Буча"],
  );
  assert.deepEqual(db.getSentKeywords(-1001, 10), ["буча"]);
  db.close();
});
