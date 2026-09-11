import { config as loadDotenv } from "dotenv";

export type Config = {
  botToken: string;
  apiId: number;
  apiHash: string;
  ownerId: number;
  channel: string;
  sessionPath: string;
  databasePath: string;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function channelUsername(channel: string): string {
  return channel.replace(/^@/, "");
}

export function loadConfig(): Config {
  loadDotenv();
  const owner = process.env.OWNER_ID?.trim() || process.env.TELEGRAM_OWNER_ID?.trim();
  if (!owner) {
    throw new Error("Missing required environment variable: OWNER_ID");
  }
  return {
    botToken: requireEnv("BOT_TOKEN"),
    apiId: Number(requireEnv("TELEGRAM_API_ID")),
    apiHash: requireEnv("TELEGRAM_API_HASH"),
    ownerId: Number(owner),
    channel: process.env.CHANNEL?.trim() || "@chyste_nebo",
    sessionPath: process.env.SESSION_PATH?.trim() || "data/session",
    databasePath: process.env.DATABASE_PATH?.trim() || "data/bot.db",
  };
}
