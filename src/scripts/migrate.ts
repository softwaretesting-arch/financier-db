/** `pnpm migrate`: apply migrations without starting the server. */
import { migrate } from "../migrate";
import { pool } from "../db";

const out = await migrate();
console.log(`migrations: ${out.applied.length ? `applied ${out.applied.join(", ")}` : "nothing new"} (${out.total} files)`);
await pool.end();
