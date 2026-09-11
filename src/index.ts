import { loadConfig } from "./config.ts";
import { Database } from "./db.ts";
import { createBot, registerBotCommands } from "./bot.ts";
import { startListener } from "./listener.ts";
import { createState, logError, logInfo } from "./state.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config.databasePath);
  const state = createState();
  const bot = createBot(config, db, state);

  logInfo("starting MTProto client (first run may ask for phone and code)");
  const client = await startListener(config, db, bot, state);

  const shutdown = async () => {
    logInfo("shutting down");
    state.listenerOk = false;
    try {
      await bot.stop();
    } catch {
      // already stopped
    }
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
    db.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  await registerBotCommands(bot);
  logInfo("bot command menu registered");

  logInfo("starting bot polling");
  await bot.start({
    drop_pending_updates: true,
    allowed_updates: ["message"],
  });
}

main().catch((error) => {
  logError("fatal", error);
  process.exit(1);
});
