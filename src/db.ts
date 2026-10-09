import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ChatRef } from "./chats.ts";
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

export type Chat = ChatRef & {
  paused: boolean;
};

export type Keyword = {
  normalized: string;
  displayText: string;
};

type ChatRow = { chat_id: number; title: string; paused: number };

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

  private tableColumns(name: string): string[] {
    const rows = this.db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
      name: string;
    }>;
    return rows.map((row) => row.name);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const keywordCols = this.tableColumns("keywords");
    if (keywordCols.length === 0) {
      this.db.exec(`
        CREATE TABLE keywords (
          chat_id INTEGER NOT NULL,
          normalized TEXT NOT NULL,
          display_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (chat_id, normalized),
          FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
        );
      `);
    } else if (!keywordCols.includes("chat_id")) {
      this.migrateLegacyKeywords();
    }

    const sentCols = this.tableColumns("sent_alerts");
    if (sentCols.length === 0) {
      this.createSentAlertsTable();
    } else if (!sentCols.includes("dest_chat_id")) {
      this.migrateLegacySentAlerts();
    }

    this.db.exec("DROP INDEX IF EXISTS sent_alerts_by_msg");
    this.db.exec("DROP TABLE IF EXISTS settings");
  }

  private legacySettings(): { destChatId: number | null; paused: boolean } {
    const cols = this.tableColumns("settings");
    if (cols.length === 0) {
      return { destChatId: null, paused: false };
    }
    const row = this.db
      .prepare("SELECT dest_chat_id, paused FROM settings WHERE id = 1")
      .get() as { dest_chat_id: number | null; paused: number } | undefined;
    return {
      destChatId: row?.dest_chat_id == null ? null : Number(row.dest_chat_id),
      paused: Boolean(row?.paused),
    };
  }

  private migrateLegacyKeywords(): void {
    const { destChatId, paused } = this.legacySettings();
    const now = new Date().toISOString();
    this.db.exec(`
      CREATE TABLE keywords_v2 (
        chat_id INTEGER NOT NULL,
        normalized TEXT NOT NULL,
        display_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, normalized),
        FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
      );
    `);
    if (destChatId != null) {
      this.db
        .prepare(
          `
          INSERT INTO chats (chat_id, title, paused, created_at, updated_at)
          VALUES (?, 'група', ?, ?, ?)
          `,
        )
        .run(destChatId, paused ? 1 : 0, now, now);
      this.db
        .prepare(
          `
          INSERT INTO keywords_v2 (chat_id, normalized, display_text, created_at)
          SELECT ?, normalized, display_text, created_at FROM keywords
          `,
        )
        .run(destChatId);
    }
    this.db.exec("DROP TABLE keywords");
    this.db.exec("ALTER TABLE keywords_v2 RENAME TO keywords");
  }

  private createSentAlertsTable(): void {
    this.db.exec(`
      CREATE TABLE sent_alerts (
        dest_chat_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        channel_msg_id INTEGER NOT NULL,
        matched_keywords TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (dest_chat_id, channel_msg_id),
        FOREIGN KEY (dest_chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
      );
    `);
  }

  private migrateLegacySentAlerts(): void {
    const { destChatId } = this.legacySettings();
    this.db.exec("DROP INDEX IF EXISTS sent_alerts_by_msg");
    this.db.exec("ALTER TABLE sent_alerts RENAME TO sent_alerts_legacy");
    this.createSentAlertsTable();
    if (destChatId != null) {
      if (!this.getChat(destChatId)) {
        const now = new Date().toISOString();
        this.db
          .prepare(
            `
            INSERT INTO chats (chat_id, title, paused, created_at, updated_at)
            VALUES (?, 'група', 0, ?, ?)
            `,
          )
          .run(destChatId, now, now);
      }
      this.db
        .prepare(
          `
          INSERT OR IGNORE INTO sent_alerts
            (dest_chat_id, channel_id, channel_msg_id, matched_keywords, sent_at)
          SELECT ?, channel_id, channel_msg_id, matched_keywords, sent_at
          FROM sent_alerts_legacy
          `,
        )
        .run(destChatId);
    }
    this.db.exec("DROP TABLE sent_alerts_legacy");
  }

  listChats(): Chat[] {
    const rows = this.db
      .prepare("SELECT chat_id, title, paused FROM chats ORDER BY title COLLATE NOCASE")
      .all() as ChatRow[];
    return rows
      .map((row) => ({
        chatId: Number(row.chat_id),
        title: row.title,
        paused: Boolean(row.paused),
      }))
      .sort((a, b) => a.title.localeCompare(b.title, "uk", { sensitivity: "base" }));
  }

  getChat(chatId: number): Chat | null {
    const row = this.db
      .prepare("SELECT chat_id, title, paused FROM chats WHERE chat_id = ?")
      .get(chatId) as ChatRow | undefined;
    if (!row) {
      return null;
    }
    return {
      chatId: Number(row.chat_id),
      title: row.title,
      paused: Boolean(row.paused),
    };
  }

  upsertChat(chatId: number, title: string): void {
    const now = new Date().toISOString();
    const label = title.trim() || "група";
    this.db
      .prepare(
        `
        INSERT INTO chats (chat_id, title, paused, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          title = excluded.title,
          updated_at = excluded.updated_at
        `,
      )
      .run(chatId, label, now, now);
  }

  removeChat(chatId: number): void {
    this.db.prepare("DELETE FROM chats WHERE chat_id = ?").run(chatId);
  }

  setPaused(chatId: number, paused: boolean): void {
    this.db
      .prepare("UPDATE chats SET paused = ?, updated_at = ? WHERE chat_id = ?")
      .run(paused ? 1 : 0, new Date().toISOString(), chatId);
  }

  listKeywords(chatId: number): Keyword[] {
    const rows = this.db
      .prepare("SELECT normalized, display_text FROM keywords WHERE chat_id = ?")
      .all(chatId) as Array<{ normalized: string; display_text: string }>;
    return rows
      .map((row) => ({
        normalized: row.normalized,
        displayText: row.display_text,
      }))
      .sort((a, b) => a.displayText.localeCompare(b.displayText, "uk", { sensitivity: "base" }));
  }

  keywordCount(chatId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM keywords WHERE chat_id = ?")
      .get(chatId) as { n: number };
    return Number(row.n);
  }

  addKeyword(chatId: number, raw: string): string {
    const error = validateKeyword(raw);
    if (error) {
      throw new InvalidKeywordError(error);
    }
    const display = prepareKeyword(raw);
    const normalized = normalizeKeyword(display);
    const existing = this.listKeywords(chatId);
    const duplicate = existing.find((item) => item.normalized === normalized);
    if (duplicate) {
      throw new DuplicateKeywordError(duplicate.displayText);
    }
    if (existing.length >= KEYWORD_LIMIT) {
      throw new KeywordLimitError();
    }
    this.db
      .prepare(
        "INSERT INTO keywords (chat_id, normalized, display_text, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(chatId, normalized, display, new Date().toISOString());
    return display;
  }

  removeKeyword(chatId: number, raw: string): string | null {
    const display = prepareKeyword(raw);
    if (!display) {
      return null;
    }
    const normalized = normalizeKeyword(display);
    const row = this.db
      .prepare("SELECT display_text FROM keywords WHERE chat_id = ? AND normalized = ?")
      .get(chatId, normalized) as { display_text: string } | undefined;
    if (!row) {
      return null;
    }
    this.db
      .prepare("DELETE FROM keywords WHERE chat_id = ? AND normalized = ?")
      .run(chatId, normalized);
    return row.display_text;
  }

  getSentKeywords(destChatId: number, messageId: number): string[] | null {
    const row = this.db
      .prepare(
        `
        SELECT matched_keywords FROM sent_alerts
        WHERE dest_chat_id = ? AND channel_msg_id = ?
        `,
      )
      .get(destChatId, messageId) as { matched_keywords: string } | undefined;
    if (!row) {
      return null;
    }
    const parsed = JSON.parse(row.matched_keywords) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((item) => String(item));
  }

  upsertSent(
    destChatId: number,
    channelId: number,
    messageId: number,
    matchedNormalized: string[],
  ): void {
    const payload = JSON.stringify(matchedNormalized);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO sent_alerts
          (dest_chat_id, channel_id, channel_msg_id, matched_keywords, sent_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(dest_chat_id, channel_msg_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          matched_keywords = excluded.matched_keywords,
          sent_at = excluded.sent_at
        `,
      )
      .run(destChatId, channelId, messageId, payload, now);
  }

  deleteSent(destChatId: number, messageId: number): void {
    this.db
      .prepare("DELETE FROM sent_alerts WHERE dest_chat_id = ? AND channel_msg_id = ?")
      .run(destChatId, messageId);
  }
}
