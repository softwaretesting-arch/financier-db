/**
 * One-time (and safe to repeat) copy of what Atlas already saved, so this database starts full instead of waiting for
 * the first syncs. Reads Atlas over ATLAS_READONLY_DATABASE_URL in READ ONLY transactions; writes only to this
 * service's DATABASE_URL. Atlas is never changed.
 *
 *   ATLAS_READONLY_DATABASE_URL=… DATABASE_URL=… pnpm import:atlas            # records + Aurora ledger + EnFin ids
 *   … pnpm import:atlas --dry-run                                              # counts only
 *
 * A record already here is replaced only when Atlas's copy is newer (updated_at), so running it after this service
 * has synced keeps the fresher data.
 */
import { pool } from "../db";
import { migrate } from "../migrate";
import { atlasReadOnly, closeAtlas, atlasConfigured } from "../atlas-link";
import { getBookingRuleList, setSetting } from "../settings";

const BATCH = 100;
const dry = process.argv.includes("--dry-run");

interface RecordRow { id: string; financier: string; external_id: string; source: string; aurora_project_id: string | null; status: string; error: string | null; raw: unknown; fetched_at: Date | null; created_at: Date; updated_at: Date }

async function copyRecords(): Promise<{ read: number; written: number }> {
  let after = "0", read = 0, written = 0;
  for (;;) {
    const rows = await atlasReadOnly<RecordRow>(
      `SELECT id::text, financier, external_id, source, aurora_project_id, status, error, raw, fetched_at, created_at, updated_at
         FROM financier_api_records WHERE financier_api_records.id > $1::bigint ORDER BY financier_api_records.id LIMIT ${BATCH}`, [after]);
    if (!rows.length) break;
    read += rows.length;
    after = rows[rows.length - 1]!.id;
    if (dry) continue;
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(r.financier, r.external_id, r.source, r.aurora_project_id, r.status, r.error, r.raw === null ? null : JSON.stringify(r.raw), r.fetched_at, r.created_at, r.updated_at);
      const b = i * 10;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::jsonb, $${b + 8}, $${b + 9}, $${b + 10})`;
    });
    const res = await pool.query(
      `INSERT INTO financier_api_records (financier, external_id, source, aurora_project_id, status, error, raw, fetched_at, created_at, updated_at)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (financier, external_id) DO UPDATE SET
         source = excluded.source, aurora_project_id = coalesce(financier_api_records.aurora_project_id, excluded.aurora_project_id),
         status = excluded.status, error = excluded.error, raw = excluded.raw, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at
       WHERE financier_api_records.updated_at < excluded.updated_at`, values);
    written += res.rowCount ?? 0;
    process.stdout.write(`\rrecords: ${read} read, ${written} written`);
  }
  process.stdout.write("\n");
  return { read, written };
}

interface AuroraRow { aurora_project_id: string; crawled_at: Date | null; designs: number; financings: number; enfin_ids: unknown; error: string | null; created_at: Date; updated_at: Date }

async function copyAurora(): Promise<{ read: number; written: number }> {
  let after = "", read = 0, written = 0;
  for (;;) {
    const rows = await atlasReadOnly<AuroraRow>(
      `SELECT aurora_project_id, crawled_at, designs, financings, enfin_ids, error, created_at, updated_at
         FROM financier_api_aurora_projects WHERE aurora_project_id > $1 ORDER BY aurora_project_id LIMIT 500`, [after]);
    if (!rows.length) break;
    read += rows.length;
    after = rows[rows.length - 1]!.aurora_project_id;
    if (dry) continue;
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(r.aurora_project_id, r.crawled_at, r.designs, r.financings, JSON.stringify(r.enfin_ids ?? []), r.error, r.created_at, r.updated_at);
      const b = i * 8;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::jsonb, $${b + 6}, $${b + 7}, $${b + 8})`;
    });
    const res = await pool.query(
      `INSERT INTO financier_api_aurora_projects (aurora_project_id, crawled_at, designs, financings, enfin_ids, error, created_at, updated_at)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (aurora_project_id) DO UPDATE SET crawled_at = excluded.crawled_at, designs = excluded.designs,
         financings = excluded.financings, enfin_ids = excluded.enfin_ids, error = excluded.error, updated_at = excluded.updated_at
       WHERE financier_api_aurora_projects.updated_at < excluded.updated_at`, values);
    written += res.rowCount ?? 0;
  }
  return { read, written };
}

/** EnFin ids typed into Atlas (app_settings FINANCIER_API_ENFIN_IDS), merged into this service's setting. */
async function copyEnfinIds(): Promise<number> {
  const rows = await atlasReadOnly<{ value: string | null }>("SELECT value FROM app_settings WHERE key = 'FINANCIER_API_ENFIN_IDS' LIMIT 1").catch(() => []);
  const atlasIds = (rows[0]?.value ?? "").split(/[\s,;]+/).filter(Boolean);
  if (!atlasIds.length || dry) return atlasIds.length;
  const mine = await getBookingRuleList("FINANCIER_API_ENFIN_IDS");
  await setSetting("FINANCIER_API_ENFIN_IDS", [...new Set([...mine, ...atlasIds])].join(","), "import-from-atlas");
  return atlasIds.length;
}

async function main(): Promise<void> {
  if (!atlasConfigured()) throw new Error("Set ATLAS_READONLY_DATABASE_URL (a read-only login to Atlas's database).");
  await migrate();
  const t = Date.now();
  const records = await copyRecords();
  const aurora = await copyAurora();
  const enfinIds = await copyEnfinIds();
  const counts = await pool.query<{ financier: string; n: number }>("SELECT financier, count(*)::int AS n FROM financier_api_records GROUP BY 1 ORDER BY 1");
  console.log(JSON.stringify({ dryRun: dry, records, aurora, enfinIds, nowInThisDatabase: Object.fromEntries(counts.rows.map((r) => [r.financier, r.n])), seconds: Math.round((Date.now() - t) / 1000) }, null, 2));
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
  .finally(async () => { await closeAtlas(); await pool.end(); });
