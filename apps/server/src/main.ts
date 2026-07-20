import { readConfig } from "./config.js";
import { serverGameRegistry } from "./games/registry.js";
import { createRuntime } from "./runtime.js";

const config = readConfig();
const { app } = await createRuntime(config, serverGameRegistry);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "received shutdown signal");

  const forcedExit = setTimeout(() => {
    app.log.error("graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  forcedExit.unref();

  await app.close();
  clearTimeout(forcedExit);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error, "failed to start server");
  process.exitCode = 1;
}
