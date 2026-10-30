/**
 * Boot: apply this database's migrations, start the HTTP API, start the background sync. PORT defaults to 8080
 * (Replit maps it to 80/443 when deployed). SIGTERM finishes in-flight requests and releases the sync lock.
 */
import { createApp, VERSION } from "./app";
import { migrate } from "./migrate";
import { pool } from "./db";
import { logger } from "./logger";
import { startScheduler, stopScheduler } from "./scheduler";
import { apiKeyConfigured } from "./auth";
import { closeAtlas } from "./atlas-link";

const port = Number(process.env.PORT ?? 8080);

async function main(): Promise<void> {
  const m = await migrate();
  logger.info({ applied: m.applied, total: m.total }, "[boot] migrations up to date");
  if (!apiKeyConfigured()) logger.warn("[boot] FINANCIER_DB_API_KEYS is not set: every route except /api/healthz answers 503");
  const server = createApp().listen(port, "0.0.0.0", () => logger.info({ port, version: VERSION }, "[boot] financier-db listening"));
  startScheduler();

  const shutdown = (signal: string) => {
    logger.info({ signal }, "[shutdown] stopping");
    server.close(() => {
      void stopScheduler().then(closeAtlas).then(() => pool.end()).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 25_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "[boot] failed");
  process.exit(1);
});
