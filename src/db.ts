import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  KEYWORD_LIMIT,
  normalizeKeyword,
  prepareKeyword,
  validateKeyword,
} from "./matcher.ts";

export class DuplicateKeywordError extends Error {
  displayText: string;
  constructor(displayText: string) {
    super(`duplicate:${displayText}`);
    this.displayText = displayText;
  }
}

export class KeywordLimitError extends Error {
  constructor() {
    super("keyword-limit");
  }
}

export class InvalidKeywordError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type Settings = {
  destChatId: number | null;
  paused: boolean;
};

export type Keyword = {
  normalized: string;
  displayText: string;
};

export class Database {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS keywords (
        normalized TEXT PRIMARY KEY,
        display_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        dest_chat_id INTEGER,
        paused INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sent_alerts (
        channel_id INTEGER NOT NULL,
        channel_msg_id INTEGER NOT NULL,
        matched_keywords TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, channel_msg_id)
      );

      INSERT OR IGNORE INTO settings (id, dest_chat_id, paused) VALUES (1, NULL, 0);
    `);
    this.db.exec(`
      DELETE FROM sent_alerts
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM sent_alerts GROUP BY channel_msg_id
      );
    `);
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS sent_alerts_by_msg ON sent_alerts(channel_msg_id)",
    );
  }

  getSettings(): Settings {
    const row = this.db
      .prepare("SELECT dest_chat_id, paused FROM settings WHERE id = 1")
      .get() as { dest_chat_id: number | null; paused: number } | undefined;
    if (!row) {
      return { destChatId: null, paused: false };
    }
    return {
      destChatId: row.dest_chat_id == null ? null : Number(row.dest_chat_id),
      paused: Boolean(row.paused),
    };
  }

  setDestChatId(chatId: number): void {
    this.db.prepare("UPDATE settings SET dest_chat_id = ? WHERE id = 1").run(chatId);
  }

  setPaused(paused: boolean): void {
    this.db.prepare("UPDATE settings SET paused = ? WHERE id = 1").run(paused ? 1 : 0);
  }

  listKeywords(): Keyword[] {
    const rows = this.db
      .prepare("SELECT normalized, display_text FROM keywords")
      .all() as Array<{ normalized: string; display_text: string }>;
    return rows
      .map((row) => ({
        normalized: row.normalized,
        displayText: row.display_text,
      }))
      .sort((a, b) => a.displayText.localeCompare(b.displayText, "uk", { sensitivity: "base" }));
  }

  keywordCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM keywords").get() as {
      n: number;
    };
    return Number(row.n);
  }

  addKeyword(raw: string): string {
    const error = validateKeyword(raw);
    if (error) {
      throw new InvalidKeywordError(error);
    }
    const display = prepareKeyword(raw);
    const normalized = normalizeKeyword(display);
    const existing = this.listKeywords();
    const duplicate = existing.find((item) => item.normalized === normalized);
    if (duplicate) {
      throw new DuplicateKeywordError(duplicate.displayText);
    }
    if (existing.length >= KEYWORD_LIMIT) {
      throw new KeywordLimitError();
    }
    this.db
      .prepare(
        "INSERT INTO keywords (normalized, display_text, created_at) VALUES (?, ?, ?)",
      )
      .run(normalized, display, new Date().toISOString());
    return display;
  }

  removeKeyword(raw: string): string | null {
    const display = prepareKeyword(raw);
    if (!display) {
      return null;
    }
    const normalized = normalizeKeyword(display);
    const row = this.db
      .prepare("SELECT display_text FROM keywords WHERE normalized = ?")
      .get(normalized) as { display_text: string } | undefined;
    if (!row) {
      return null;
    }
    this.db.prepare("DELETE FROM keywords WHERE normalized = ?").run(normalized);
    return row.display_text;
  }

  getSentKeywords(channelId: number, messageId: number): string[] | null {
    const row = this.db
      .prepare(
        `
        SELECT matched_keywords FROM sent_alerts
        WHERE channel_msg_id = ?
           OR (channel_id = ? AND channel_msg_id = ?)
        ORDER BY sent_at DESC
        LIMIT 1
        `,
      )
      .get(messageId, channelId, messageId) as { matched_keywords: string } | undefined;
    if (!row) {
      return null;
    }
    const parsed = JSON.parse(row.matched_keywords) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((item) => String(item));
  }

  upsertSent(channelId: number, messageId: number, matchedNormalized: string[]): void {
    const payload = JSON.stringify(matchedNormalized);
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT channel_id FROM sent_alerts WHERE channel_msg_id = ?")
      .get(messageId) as { channel_id: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          `
          UPDATE sent_alerts
          SET channel_id = ?, matched_keywords = ?, sent_at = ?
          WHERE channel_msg_id = ?
          `,
        )
        .run(channelId, payload, now, messageId);
      return;
    }
    this.db
      .prepare(
        `
        INSERT INTO sent_alerts (channel_id, channel_msg_id, matched_keywords, sent_at)
        VALUES (?, ?, ?, ?)
        `,
      )
      .run(channelId, messageId, payload, now);
  }

  deleteSent(messageId: number): void {
    this.db.prepare("DELETE FROM sent_alerts WHERE channel_msg_id = ?").run(messageId);
  }
}
