import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Api, TelegramClient, events, sessions, utils } from "teleproto";
import type { Bot } from "grammy";
import { formatAlert } from "./alerts.ts";
import type { Config } from "./config.ts";
import { channelUsername } from "./config.ts";
import type { Database } from "./db.ts";
import { matchKeywords, normalizeKeyword, shouldAlert } from "./matcher.ts";
import {
  DELIVERY_ERROR_COOLDOWN_MS,
  logError,
  logInfo,
  type AppState,
} from "./state.ts";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function messageText(event: events.NewMessageEvent | events.EditedMessageEvent): string {
  return event.message.text ?? event.message.message ?? "";
}

function textPreview(text: string, max = 10): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return [...flat].slice(0, max).join("");
}

function messageDate(event: events.NewMessageEvent | events.EditedMessageEvent): Date {
  const raw = event.message.date;
  const seconds = typeof raw === "number" ? raw : Number(raw);
  return new Date(seconds * 1000);
}

function channelIds(event: events.NewMessageEvent | events.EditedMessageEvent): {
  channelId: number;
  messageId: number;
} {
  const raw = event.chatId;
  return {
    channelId: raw == null ? 0 : Number(raw.toString()),
    messageId: event.message.id,
  };
}

const PROCESSED_LIMIT = 2000;
const processedPosts = new Map<number, { text: string; fingerprint: string }>();

function keywordFingerprint(keywords: Array<{ normalized: string }>): string {
  return keywords.map((item) => item.normalized).join("\n");
}

function isRepeatPost(messageId: number, text: string, fingerprint: string): boolean {
  const prev = processedPosts.get(messageId);
  if (prev?.text === text && prev.fingerprint === fingerprint) {
    return true;
  }
  if (processedPosts.has(messageId)) {
    processedPosts.delete(messageId);
  }
  processedPosts.set(messageId, { text, fingerprint });
  if (processedPosts.size > PROCESSED_LIMIT) {
    const oldest = processedPosts.keys().next().value;
    if (oldest !== undefined) {
      processedPosts.delete(oldest);
    }
  }
  return false;
}

export async function notifyOwner(
  bot: Bot,
  ownerId: number,
  text: string,
): Promise<void> {
  try {
    await bot.api.sendMessage(ownerId, text);
  } catch (error) {
    logError("failed to notify owner", error);
  }
}

export async function processChannelPost(input: {
  config: Config;
  db: Database;
  bot: Bot;
  state: AppState;
  text: string;
  date: Date;
  channelId: number;
  messageId: number;
  isEdit: boolean;
}): Promise<void> {
  const { config, db, bot, state, text, date, channelId, messageId, isEdit } = input;
  const username = channelUsername(config.channel);
  const preview = textPreview(text);

  if (!text.trim()) {
    logInfo("skip empty", { messageId, isEdit, preview });
    return;
  }

  const settings = db.getSettings();
  if (settings.paused) {
    logInfo("skip paused", { messageId, preview });
    return;
  }

  const keywords = db.listKeywords();
  if (isRepeatPost(messageId, text, keywordFingerprint(keywords))) {
    return;
  }
  if (keywords.length === 0) {
    logInfo("skip no keywords", { messageId, preview });
    return;
  }

  const matched = matchKeywords(
    text,
    keywords.map((item) => [item.normalized, item.displayText]),
  );
  if (matched.length === 0) {
    logInfo("skip no match", { messageId, preview });
    return;
  }

  const previous = db.getSentKeywords(channelId, messageId);
  if (!shouldAlert(matched, previous)) {
    logInfo("skip duplicate", { messageId, matched, preview });
    return;
  }

  if (settings.destChatId == null) {
    logInfo("matched but no dest group", { messageId, matched, preview });
    return;
  }

  const html = formatAlert({
    text,
    keywords: matched,
    messageId,
    date,
    channelUsername: username,
    isEdit: isEdit || previous !== null,
  });

  db.upsertSent(
    channelId,
    messageId,
    matched.map((item) => normalizeKeyword(item)),
  );

  try {
    await bot.api.sendMessage(settings.destChatId, html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    logInfo("alert sent", { messageId, matched, preview, dest: settings.destChatId });
  } catch (error) {
    db.deleteSent(messageId);
    logError("failed to send alert", error);
    const now = Date.now();
    if (now - state.lastDeliveryErrorAt >= DELIVERY_ERROR_COOLDOWN_MS) {
      state.lastDeliveryErrorAt = now;
      await notifyOwner(
        bot,
        config.ownerId,
        "Не можу надіслати алерт у групу. Перевірте, що бот є учасником і має право писати. Потім знову /setgroup.",
      );
    }
  }
}

export async function startListener(
  config: Config,
  db: Database,
  bot: Bot,
  state: AppState,
): Promise<TelegramClient> {
  mkdirSync(dirname(config.sessionPath), { recursive: true });
  const session = new sessions.StoreSession(config.sessionPath);
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: () => prompt("Телефон (з кодом країни, наприклад +380...): "),
    phoneCode: () => prompt("Код із Telegram: "),
    password: () => prompt("Пароль 2FA (якщо увімкнено, інакше Enter): "),
    onError: (error) => {
      logError("MTProto login error", error);
    },
  });

  const username = channelUsername(config.channel);
  const entity = await client.getEntity(username);
  const chatId = utils.getPeerId(entity);
  try {
    await client.invoke(
      new Api.channels.JoinChannel({
        channel: await client.getInputEntity(username),
      }),
    );
    logInfo("joined channel", { username, chatId });
  } catch (error) {
    logInfo("channel join skipped (already a participant or not needed)", {
      username,
      chatId,
      error: String(error),
    });
  }

  const handle = async (
    event: events.NewMessageEvent | events.EditedMessageEvent,
    isEdit: boolean,
  ) => {
    await processChannelPost({
      config,
      db,
      bot,
      state,
      text: messageText(event),
      date: messageDate(event),
      ...channelIds(event),
      isEdit,
    });
  };

  client.addEventHandler(
    (event: events.NewMessageEvent) => handle(event, false),
    new events.NewMessage({ incoming: true, chats: [chatId] }),
  );
  client.addEventHandler(
    (event: events.EditedMessageEvent) => handle(event, true),
    new events.EditedMessage({ chats: [chatId] }),
  );

  state.listenerOk = Boolean(client.connected);
  setInterval(() => {
    const ok = Boolean(client.connected);
    if (state.listenerOk && !ok) {
      logError("MTProto disconnected", null);
      void notifyOwner(
        bot,
        config.ownerId,
        "З’єднання з Telegram (MTProto) втрачено. Алерти можуть не надходити, доки процес знову не буде онлайн.",
      );
    }
    state.listenerOk = ok;
  }, 5000).unref();

  logInfo("MTProto listener started", { username, chatId });
  return client;
}
