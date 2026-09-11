import assert from "node:assert/strict";
import { test } from "node:test";
import { Bot } from "grammy";
import { processChannelPost } from "../src/listener.ts";
import { Database } from "../src/db.ts";
import { createState } from "../src/state.ts";
import type { Config } from "../src/config.ts";

function config(): Config {
  return {
    botToken: "0:test",
    apiId: 1,
    apiHash: "hash",
    ownerId: 42,
    channel: "@chyste_nebo",
    sessionPath: "data/session",
    databasePath: ":memory:",
  };
}

test("processChannelPost sends once, skips duplicates, alerts on new keyword", async () => {
  const db = new Database(":memory:");
  db.addKeyword("Буча");
  db.setDestChatId(-1001);
  const sent: Array<{ chatId: number; text: string }> = [];
  const bot = new Bot("0:test");
  bot.api.sendMessage = (async (chatId: number, text: string) => {
    sent.push({ chatId, text });
    return { message_id: sent.length };
  }) as unknown as typeof bot.api.sendMessage;

  const base = {
    config: config(),
    db,
    bot,
    state: createState(),
    text: "На Бучу зайшов борт",
    date: new Date("2026-09-10T14:00:00.000Z"),
    channelId: -100555,
    messageId: 99,
    isEdit: false,
  };

  await processChannelPost(base);
  await processChannelPost({ ...base, isEdit: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.text ?? "", /Буча/);

  db.addKeyword("ракета");
  await processChannelPost({
    ...base,
    text: "На Бучу зайшов борт, ракета",
    isEdit: true,
  });
  assert.equal(sent.length, 2);
  assert.match(sent[1]?.text ?? "", /Оновлення поста/);
  db.close();
});

test("processChannelPost sends once when new and edit race", async () => {
  const db = new Database(":memory:");
  db.addKeyword("Чабани");
  db.setDestChatId(-1001);
  const sent: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bot = new Bot("0:test");
  bot.api.sendMessage = (async () => {
    sent.push(true);
    await gate;
    return { message_id: sent.length };
  }) as unknown as typeof bot.api.sendMessage;

  const base = {
    config: config(),
    db,
    bot,
    state: createState(),
    text: "Чабани, щось летить",
    date: new Date(),
    channelId: -100555,
    messageId: 178522,
    isEdit: false,
  };

  const first = processChannelPost(base);
  const second = processChannelPost({ ...base, isEdit: true, channelId: 555 });
  release();
  await Promise.all([first, second]);
  assert.equal(sent.length, 1);
  db.close();
});

test("identical edit of a non-matching post is ignored", async () => {
  const db = new Database(":memory:");
  db.addKeyword("Буча");
  db.setDestChatId(-1001);
  const sent: unknown[] = [];
  const bot = new Bot("0:test");
  bot.api.sendMessage = (async () => {
    sent.push(true);
    return { message_id: 1 };
  }) as unknown as typeof bot.api.sendMessage;
  const base = {
    config: config(),
    db,
    bot,
    state: createState(),
    text: "Житомир тихо",
    date: new Date(),
    channelId: -100555,
    messageId: 178578,
    isEdit: false,
  };
  await processChannelPost(base);
  await processChannelPost({ ...base, isEdit: true });
  assert.equal(sent.length, 0);
  db.close();
});

test("processChannelPost stays silent without keywords, matches, dest, or when paused", async () => {
  const db = new Database(":memory:");
  const sent: unknown[] = [];
  const bot = new Bot("0:test");
  bot.api.sendMessage = (async () => {
    sent.push(true);
    return { message_id: 1 };
  }) as unknown as typeof bot.api.sendMessage;
  const base = {
    config: config(),
    db,
    bot,
    state: createState(),
    text: "На Бучу зайшов борт",
    date: new Date(),
    channelId: 1,
    messageId: 1,
    isEdit: false,
  };

  await processChannelPost(base);
  db.addKeyword("Буча");
  await processChannelPost(base);
  db.setDestChatId(-1001);
  db.setPaused(true);
  await processChannelPost(base);
  db.setPaused(false);
  await processChannelPost({ ...base, text: "Житомир тихо" });
  assert.equal(sent.length, 0);
  db.close();
});
