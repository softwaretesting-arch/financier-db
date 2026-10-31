/**
 * Background sync. Every TICK_MS the leader runs the same tick Atlas runs: each configured financier whose last
 * scheduled sync is FINANCIER_API_PULL_MINUTES old (default 15) starts a sync, side by side, then any Aurora → EnFin
 * discovery still waiting continues, then every lender in mirror mode (no login here) is copied from Atlas
 * (src/mirror.ts). One leader across instances: a Postgres advisory lock held on its own
 * connection, so a second instance (or a redeploy overlapping the old one) never double-syncs. The leader keeps the
 * lock while its process lives; if it dies, Postgres frees the lock and the next instance takes over on its next try.
 */
import type pg from "pg";
import { pool } from "./db";
import { logger } from "./logger";
import { scheduledTickWithDiscovery } from "./financier-api/store";
import { mirrorTick } from "./mirror";

const TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? 60_000);
const LOCK_KEY = "financier-db:scheduler";

export const schedulerState = {
  enabled: process.env.SCHEDULER_DISABLED !== "1",
  leader: false,
  tickMs: TICK_MS,
  lastTickAt: null as string | null,
  lastTickError: null as string | null,
  ticks: 0,
};

let lockClient: pg.PoolClient | null = null;
let timer: NodeJS.Timeout | null = null;
let ticking = false;

async function ensureLeader(): Promise<boolean> {
  if (schedulerState.leader && lockClient) return true;
  try {
    lockClient ??= await pool.connect();
    const res = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [LOCK_KEY]);
    schedulerState.leader = res.rows[0]?.ok === true;
    if (schedulerState.leader) {
      logger.info("[scheduler] this instance is the sync leader");
      await closeInterrupted();
    }
    else { lockClient.release(); lockClient = null; }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[scheduler] leader check failed");
    lockClient?.release(true); lockClient = null; schedulerState.leader = false;
  }
  return schedulerState.leader;
}

/**
 * The previous leader is gone (it released the lock by dying or stopping), so any sync it left unfinished will never
 * finish: mark those as interrupted. The next tick then starts them again at once instead of waiting out the interval
 * (direct pulls: store.ts scheduledTick; Atlas copies: mirror.ts mirrorTick, which also resumes from its cursor).
 */
export async function closeInterrupted(): Promise<void> {
  try {
    const res = await pool.query(
      `UPDATE financier_api_pulls SET finished_at = now(), message = 'Interrupted (the service restarted); started again.'
        WHERE finished_at IS NULL`);
    if (res.rowCount) logger.info({ closed: res.rowCount }, "[scheduler] closed syncs cut short by a restart");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[scheduler] closing interrupted syncs failed");
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    if (!(await ensureLeader())) return;
    await scheduledTickWithDiscovery();
    await mirrorTick();
    schedulerState.ticks++;
    schedulerState.lastTickAt = new Date().toISOString();
    schedulerState.lastTickError = null;
  } catch (err) {
    schedulerState.lastTickError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[scheduler] tick failed");
  } finally {
    ticking = false;
  }
}

export function startScheduler(): void {
  if (!schedulerState.enabled) { logger.info("[scheduler] disabled (SCHEDULER_DISABLED=1)"); return; }
  const firstDelay = Number(process.env.SCHEDULER_START_DELAY_MS ?? 15_000);
  setTimeout(() => { void tick(); timer = setInterval(() => void tick(), TICK_MS); }, firstDelay);
}

export async function stopScheduler(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]).catch(() => undefined);
    lockClient.release();
    lockClient = null;
  }
  schedulerState.leader = false;
}
