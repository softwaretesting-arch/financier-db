/**
 * `pnpm api-key`: prints the API key this service made for itself (used when FINANCIER_DB_API_KEYS is not set).
 * Run it in the Repl shell; copy the key to whatever calls this API.
 */
import { pool } from "../db";
import { migrate } from "../migrate";
import { readOrCreateGeneratedKey } from "../auth";

await migrate();
if (process.env.FINANCIER_DB_API_KEYS?.trim()) console.log("FINANCIER_DB_API_KEYS is set: callers use that key, not a generated one.");
else console.log(await readOrCreateGeneratedKey());
await pool.end();
