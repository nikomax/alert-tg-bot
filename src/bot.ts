import { Bot, GrammyError, type Context } from "grammy";
import type { Config } from "./config.ts";
import { channelUsername } from "./config.ts";
import { resolveChatCommand } from "./chats.ts";
import {
  Database,
  DuplicateKeywordError,
  InvalidKeywordError,
  KeywordLimitError,
  type Chat,
} from "./db.ts";
import type { AppState } from "./state.ts";
import { KEYWORD_LIMIT } from "./matcher.ts";

const PRIVATE = "Цей бот особистий.";

const START_TEXT = [
  "Слідкую за каналом @chyste_nebo і надсилаю в кожну групу пости за її власним списком слів.",
  "",
  "Як почати:",
  "1. Додайте бота в групу, де мають з’являтися алерти",
  "2. У групі: /setgroup (або одразу /add Буча)",
  "3. З привату: /add сади Буча — слово лише для цієї групи",
  "",
  "У групі команди без назви чату (цей чат).",
  "У приваті вкажіть групу: /add <група> <слово>",
  "",
  "Команди:",
  "/groups — список груп",
  "/add — додати ключ",
  "/remove — видалити ключ",
  "/list — список ключів",
  "/pause /resume — пауза алертів групи",
  "/status — стан",
  "/setgroup — зареєструвати групу (писати в групі)",
].join("\n");

function commandArgs(ctx: Context): string {
  const match = ctx.match;
  if (typeof match === "string") {
    return match.trim();
  }
  return (ctx.message?.text ?? "").split(/\s+/).slice(1).join(" ").trim();
}

function isGroupChat(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

function chatNames(chats: Chat[]): string {
  return chats.map((chat) => chat.title).join(", ");
}

function resolveError(reason: "empty" | "not_found" | "ambiguous", chats: Chat[], matches: Chat[], usage: string): string {
  if (reason === "empty") {
    return usage;
  }
  if (reason === "ambiguous") {
    return `Кілька груп пасують: ${chatNames(matches)}. Уточніть назву.\n${usage}`;
  }
  if (chats.length === 0) {
    return "Немає груп. Додайте бота в чат і напишіть там /setgroup або /add.";
  }
  return `Групи не знайдено. Доступні: ${chatNames(chats)}\n${usage}`;
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

  const touchGroup = (ctx: Context): Chat | null => {
    if (!ctx.chat || !isGroupChat(ctx)) {
      return null;
    }
    db.upsertChat(ctx.chat.id, ctx.chat.title ?? "група");
    return db.getChat(ctx.chat.id);
  };

  const targetChat = async (
    ctx: Context,
    usage: string,
    opts: { restRequired?: boolean; restHint?: string } = {},
  ): Promise<{ chat: Chat; rest: string } | null> => {
    if (isGroupChat(ctx)) {
      const chat = touchGroup(ctx);
      if (!chat) {
        return null;
      }
      const rest = commandArgs(ctx);
      if (opts.restRequired && !rest) {
        await ctx.reply(opts.restHint ?? usage);
        return null;
      }
      return { chat, rest };
    }

    const chats = db.listChats();
    const resolved = resolveChatCommand(commandArgs(ctx), chats);
    if (!resolved.ok) {
      await ctx.reply(resolveError(resolved.reason, chats, resolved.matches, usage));
      return null;
    }
    if (opts.restRequired && !resolved.rest) {
      await ctx.reply(opts.restHint ?? usage);
      return null;
    }
    return { chat: resolved.chat, rest: resolved.rest };
  };

  pm.command("start", async (ctx) => {
    await ctx.reply(START_TEXT);
  });

  const listGroups = async (ctx: Context) => {
    const chats = db.listChats();
    if (chats.length === 0) {
      await ctx.reply("Немає груп. Додайте бота в чат і напишіть там /setgroup або /add.");
      return;
    }
    const lines = chats.map((chat) => {
      const count = db.keywordCount(chat.chatId);
      const alerts = chat.paused ? "пауза" : "увімкнені";
      return `• ${chat.title} — ${count} ключів, ${alerts}`;
    });
    await ctx.reply(`Групи (${chats.length}):\n${lines.join("\n")}`);
  };

  pm.command("groups", listGroups);

  const addKeyword = async (ctx: Context) => {
    const usage = isGroupChat(ctx) ? "Вкажіть слово: /add Буча" : "Вкажіть групу і слово: /add сади Буча";
    const target = await targetChat(ctx, usage, {
      restRequired: true,
      restHint: usage,
    });
    if (!target) {
      return;
    }
    try {
      const display = db.addKeyword(target.chat.chatId, target.rest);
      await ctx.reply(`Додано в «${target.chat.title}»: ${display}`);
    } catch (error) {
      if (error instanceof DuplicateKeywordError) {
        await ctx.reply(`У «${target.chat.title}» такий ключ уже є: ${error.displayText}`);
        return;
      }
      if (error instanceof KeywordLimitError) {
        await ctx.reply(`У «${target.chat.title}» досягнуто ліміт у ${KEYWORD_LIMIT} ключів.`);
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
    const usage = isGroupChat(ctx)
      ? "Вкажіть слово: /remove Буча"
      : "Вкажіть групу і слово: /remove сади Буча";
    const target = await targetChat(ctx, usage, {
      restRequired: true,
      restHint: usage,
    });
    if (!target) {
      return;
    }
    const removed = db.removeKeyword(target.chat.chatId, target.rest);
    if (!removed) {
      await ctx.reply(`У «${target.chat.title}» ключа «${target.rest}» немає.`);
      return;
    }
    await ctx.reply(`Видалено з «${target.chat.title}»: ${removed}`);
  };

  const listKeywords = async (ctx: Context) => {
    const usage = isGroupChat(ctx) ? "/list" : "Вкажіть групу: /list сади";
    const target = await targetChat(ctx, usage);
    if (!target) {
      return;
    }
    const keywords = db.listKeywords(target.chat.chatId);
    if (keywords.length === 0) {
      await ctx.reply(`Список «${target.chat.title}» порожній. Додайте через /add.`);
      return;
    }
    const lines = keywords.map((item) => `• ${item.displayText}`).join("\n");
    await ctx.reply(`Ключі «${target.chat.title}» (${keywords.length}):\n${lines}`);
  };

  pm.command("add", addKeyword);
  pm.command("remove", removeKeyword);
  pm.command("list", listKeywords);
  groups.command("add", addKeyword);
  groups.command("remove", removeKeyword);
  groups.command("list", listKeywords);

  const pauseAlerts = async (ctx: Context) => {
    const usage = isGroupChat(ctx) ? "/pause" : "Вкажіть групу: /pause сади";
    const target = await targetChat(ctx, usage);
    if (!target) {
      return;
    }
    if (target.chat.paused) {
      await ctx.reply(`Алерти «${target.chat.title}» уже призупинені.`);
      return;
    }
    db.setPaused(target.chat.chatId, true);
    await ctx.reply(`Алерти «${target.chat.title}» призупинено.`);
  };

  const resumeAlerts = async (ctx: Context) => {
    const usage = isGroupChat(ctx) ? "/resume" : "Вкажіть групу: /resume сади";
    const target = await targetChat(ctx, usage);
    if (!target) {
      return;
    }
    if (!target.chat.paused) {
      await ctx.reply(`Алерти «${target.chat.title}» уже увімкнені.`);
      return;
    }
    db.setPaused(target.chat.chatId, false);
    await ctx.reply(`Алерти «${target.chat.title}» увімкнено.`);
  };

  pm.command("pause", pauseAlerts);
  pm.command("resume", resumeAlerts);
  groups.command("pause", pauseAlerts);
  groups.command("resume", resumeAlerts);

  const status = async (ctx: Context) => {
    const listener = state.listenerOk ? "онлайн" : "офлайн";
    const channel = `@${channelUsername(config.channel)}`;

    if (ctx.chat?.type === "private" && !commandArgs(ctx)) {
      const chats = db.listChats();
      if (chats.length === 0) {
        await ctx.reply(
          [`Канал: ${channel}`, `MTProto: ${listener}`, "Групи: немає"].join("\n"),
        );
        return;
      }
      const lines = chats.map((chat) => {
        const count = db.keywordCount(chat.chatId);
        const alerts = chat.paused ? "пауза" : "увімкнені";
        return `• ${chat.title} — ${count} ключів, ${alerts}`;
      });
      await ctx.reply(
        [`Канал: ${channel}`, `MTProto: ${listener}`, `Групи (${chats.length}):`, ...lines].join(
          "\n",
        ),
      );
      return;
    }

    const usage = isGroupChat(ctx) ? "/status" : "Вкажіть групу: /status сади";
    const target = await targetChat(ctx, usage);
    if (!target) {
      return;
    }
    const count = db.keywordCount(target.chat.chatId);
    const alerts = target.chat.paused ? "пауза" : "увімкнені";
    await ctx.reply(
      [
        `Канал: ${channel}`,
        `Група: ${target.chat.title}`,
        `Алерти: ${alerts}`,
        `Ключів: ${count}`,
        `MTProto: ${listener}`,
      ].join("\n"),
    );
  };

  pm.command("status", status);
  groups.command("status", status);

  const setGroup = async (ctx: Context) => {
    if (ctx.chat?.type === "private") {
      await ctx.reply("Додайте бота в групу й напишіть там /setgroup.");
      return;
    }
    if (!ctx.chat || !isGroupChat(ctx)) {
      return;
    }
    if (ctx.from?.id !== config.ownerId) {
      await ctx.reply("Зареєструвати групу може лише власник бота.");
      return;
    }
    db.upsertChat(ctx.chat.id, ctx.chat.title ?? "група");
    await ctx.reply("Ця група отримуватиме алерти за своїм списком ключів.");
  };

  pm.command("setgroup", setGroup);
  groups.command("setgroup", setGroup);

  bot.on("my_chat_member", async (ctx) => {
    const chat = ctx.chat;
    if (chat.type !== "group" && chat.type !== "supergroup") {
      return;
    }
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === "member" || status === "administrator") {
      db.upsertChat(chat.id, chat.title ?? "група");
      return;
    }
    if (status === "left" || status === "kicked") {
      db.removeChat(chat.id);
    }
  });

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

export async function syncChatTitles(bot: Bot, db: Database): Promise<void> {
  for (const chat of db.listChats()) {
    try {
      const info = await bot.api.getChat(chat.chatId);
      const title = "title" in info ? info.title : undefined;
      if (title) {
        db.upsertChat(chat.chatId, title);
      }
    } catch {
      // бот уже не в чаті або чат недоступний
    }
  }
}

const PRIVATE_COMMANDS = [
  { command: "start", description: "Допомога і як почати" },
  { command: "groups", description: "Список груп" },
  { command: "add", description: "Додати ключ: /add <група> <слово>" },
  { command: "remove", description: "Видалити ключ: /remove <група> <слово>" },
  { command: "list", description: "Список ключів: /list <група>" },
  { command: "pause", description: "Пауза групи: /pause <група>" },
  { command: "resume", description: "Увімкнути групу: /resume <група>" },
  { command: "status", description: "Стан бота і груп" },
];

const GROUP_COMMANDS = [
  { command: "add", description: "Додати ключове слово" },
  { command: "remove", description: "Видалити ключове слово" },
  { command: "list", description: "Список ключових слів цього чату" },
  { command: "pause", description: "Зупинити алерти цього чату" },
  { command: "resume", description: "Увімкнути алерти цього чату" },
  { command: "status", description: "Стан цього чату" },
  { command: "setgroup", description: "Зареєструвати цей чат для алертів" },
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
