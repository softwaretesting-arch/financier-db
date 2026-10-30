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
import { copyRecordsFromAtlas } from "../mirror";

const dry = process.argv.includes("--dry-run");

async function copyRecords(): Promise<{ read: number; written: number }> {
  const out = await copyRecordsFromAtlas({ dryRun: dry, onProgress: (read, written) => process.stdout.write(`\rrecords: ${read} read, ${written} written`) });
  process.stdout.write("\n");
  return { read: out.read, written: out.written };
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
