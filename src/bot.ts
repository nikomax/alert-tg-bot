import { Bot, GrammyError, type Context } from "grammy";
import type { Config } from "./config.ts";
import { channelUsername } from "./config.ts";
import {
  Database,
  DuplicateKeywordError,
  InvalidKeywordError,
  KeywordLimitError,
} from "./db.ts";
import type { AppState } from "./state.ts";
import { KEYWORD_LIMIT } from "./matcher.ts";

const PRIVATE = "Цей бот особистий.";

const START_TEXT = [
  "Слідкую за каналом @chyste_nebo і надсилаю в групу пости, де є ваші ключові слова.",
  "",
  "Як почати:",
  "1. Додайте бота в групу, де мають з’являтися алерти",
  "2. У групі напишіть /setgroup",
  "3. Додайте слова: /add Буча — у групі це може зробити будь-хто",
  "",
  "Команди:",
  "/add <слово> — додати ключ",
  "/remove <слово> — видалити ключ",
  "/list — список ключів",
  "/pause — зупинити алерти",
  "/resume — відновити алерти",
  "/status — стан бота",
  "/setgroup — прив’язати групу (лише в групі)",
].join("\n");

function commandArgs(ctx: Context): string {
  const match = ctx.match;
  if (typeof match === "string") {
    return match.trim();
  }
  return (ctx.message?.text ?? "").split(/\s+/).slice(1).join(" ").trim();
}

export function createBot(config: Config, db: Database, state: AppState): Bot {
  const bot = new Bot(config.botToken);

  bot.use(async (ctx, next) => {
    const isOwner = ctx.from?.id === config.ownerId;
    if (ctx.chat?.type === "private" && !isOwner) {
      if (ctx.message) {
        await ctx.reply(PRIVATE);
      }
      return;
    }
    await next();
  });

  const pm = bot.chatType("private");
  const groups = bot.chatType(["group", "supergroup"]);

  pm.command("start", async (ctx) => {
    await ctx.reply(START_TEXT);
  });

  const addKeyword = async (ctx: Context) => {
    const raw = commandArgs(ctx);
    if (!raw) {
      await ctx.reply("Вкажіть слово: /add Буча");
      return;
    }
    try {
      const display = db.addKeyword(raw);
      await ctx.reply(`Додано: ${display}`);
    } catch (error) {
      if (error instanceof DuplicateKeywordError) {
        await ctx.reply(`Такий ключ уже є: ${error.displayText}`);
        return;
      }
      if (error instanceof KeywordLimitError) {
        await ctx.reply(`Досягнуто ліміт у ${KEYWORD_LIMIT} ключів.`);
        return;
      }
      if (error instanceof InvalidKeywordError) {
        await ctx.reply(error.message);
        return;
      }
      throw error;
    }
  };

  const removeKeyword = async (ctx: Context) => {
    const raw = commandArgs(ctx);
    if (!raw) {
      await ctx.reply("Вкажіть слово: /remove Буча");
      return;
    }
    const removed = db.removeKeyword(raw);
    if (!removed) {
      await ctx.reply(`Ключа «${raw}» немає в списку.`);
      return;
    }
    await ctx.reply(`Видалено: ${removed}`);
  };

  const listKeywords = async (ctx: Context) => {
    const keywords = db.listKeywords();
    if (keywords.length === 0) {
      await ctx.reply("Список ключових слів порожній. Додайте через /add <слово>.");
      return;
    }
    const lines = keywords.map((item) => `• ${item.displayText}`).join("\n");
    await ctx.reply(`Ключі (${keywords.length}):\n${lines}`);
  };

  pm.command("add", addKeyword);
  pm.command("remove", removeKeyword);
  pm.command("list", listKeywords);
  groups.command("add", addKeyword);
  groups.command("remove", removeKeyword);
  groups.command("list", listKeywords);

  pm.command("pause", async (ctx) => {
    if (db.getSettings().paused) {
      await ctx.reply("Алерти вже призупинені.");
      return;
    }
    db.setPaused(true);
    await ctx.reply("Алерти призупинено.");
  });

  pm.command("resume", async (ctx) => {
    if (!db.getSettings().paused) {
      await ctx.reply("Алерти уже увімкнені.");
      return;
    }
    db.setPaused(false);
    await ctx.reply("Алерти увімкнено.");
  });

  pm.command("status", async (ctx) => {
    const settings = db.getSettings();
    const count = db.keywordCount();
    const group = settings.destChatId
      ? `прив’язана (id ${settings.destChatId})`
      : "не прив’язана";
    const alerts = settings.paused ? "пауза" : "увімкнені";
    const listener = state.listenerOk ? "онлайн" : "офлайн";
    await ctx.reply(
      [
        `Канал: @${channelUsername(config.channel)}`,
        `Група: ${group}`,
        `Алерти: ${alerts}`,
        `Ключів: ${count}`,
        `MTProto: ${listener}`,
      ].join("\n"),
    );
  });

  const setGroup = async (ctx: Context) => {
    if (ctx.chat?.type === "private") {
      await ctx.reply("Додайте бота в групу й напишіть там /setgroup.");
      return;
    }
    if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
      return;
    }
    if (ctx.from?.id !== config.ownerId) {
      await ctx.reply("Прив’язати групу може лише власник бота.");
      return;
    }
    db.setDestChatId(ctx.chat.id);
    await ctx.reply("Ця група тепер отримуватиме алерти.");
  };

  pm.command("setgroup", setGroup);
  groups.command("setgroup", setGroup);

  pm.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      await ctx.reply("Невідома команда. Надішліть /start для списку команд.");
    }
  });

  bot.catch((err) => {
    if (err.error instanceof GrammyError) {
      console.error("grammY API error", err.error.description);
      return;
    }
    console.error("bot error", err.error);
  });

  return bot;
}

const PRIVATE_COMMANDS = [
  { command: "start", description: "Допомога і як почати" },
  { command: "add", description: "Додати ключове слово" },
  { command: "remove", description: "Видалити ключове слово" },
  { command: "list", description: "Список ключових слів" },
  { command: "pause", description: "Зупинити алерти" },
  { command: "resume", description: "Увімкнути алерти" },
  { command: "status", description: "Стан бота" },
  { command: "setgroup", description: "Як прив’язати групу" },
];

const GROUP_COMMANDS = [
  { command: "add", description: "Додати ключове слово" },
  { command: "remove", description: "Видалити ключове слово" },
  { command: "list", description: "Список ключових слів" },
  { command: "setgroup", description: "Прив’язати цю групу для алертів" },
];

export async function registerBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(PRIVATE_COMMANDS);
  await bot.api.setMyCommands(PRIVATE_COMMANDS, {
    scope: { type: "all_private_chats" },
  });
  await bot.api.setMyCommands(GROUP_COMMANDS, {
    scope: { type: "all_group_chats" },
  });
}
