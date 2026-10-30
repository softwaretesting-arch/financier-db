/**
 * Mirror mode: with no lender logins and a read-only Atlas link, every lender is copied from Atlas. Needs two
 * throwaway databases: TEST_DATABASE_URL (this service) and TEST_ATLAS_DATABASE_URL (stands in for Atlas). Both get
 * their public schema dropped and recreated. Skipped without them.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
const atlasUrl = process.env.TEST_ATLAS_DATABASE_URL;
const KEY = "test-key-0123456789abcdef";

describe.skipIf(!url || !atlasUrl)("mirror mode: copy from Atlas when no lender login is set", () => {
  let app: import("express").Express;
  let pool: import("pg").Pool;
  const atlas = new pg.Pool({ connectionString: atlasUrl });
  const authed = (r: request.Test) => r.set("Authorization", `Bearer ${KEY}`);

  beforeAll(async () => {
    process.env.FINANCIER_DB_API_KEYS = KEY;
    process.env.ATLAS_READONLY_DATABASE_URL = atlasUrl;
    for (const k of Object.keys(process.env)) if (/^(ENFIN|CONCERT|GOODLEAP|PALMETTO|SUNRUN|AURORA)_/.test(k)) delete process.env[k];
    await atlas.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await atlas.query(readFileSync(new URL("../migrations/0001_financier_api.sql", import.meta.url), "utf8"));
    await atlas.query("CREATE TABLE ops_finance_links (financier text NOT NULL, provider_id text NOT NULL)");
    await atlas.query(`INSERT INTO financier_api_records (financier, external_id, source, status, raw, fetched_at, updated_at) VALUES
      ('GOODLEAP', '26-41-006049', 'list', 'ok', '{"loan":{"id":"26-41-006049","status":"APPROVED"}}', now(), now() - interval '2 hours'),
      ('GOODLEAP', '25-40-000001', 'list', 'ok', '{"loan":{"id":"25-40-000001"}}', now(), now() - interval '2 hours'),
      ('PALMETTO', '6a0e165820faa365c431cb6a', 'list', 'ok', '{"account":{"id":"6a0e165820faa365c431cb6a"},"documents":[{"id":"d1","type":"contract","files":[{"originalName":"c.pdf"}]}]}', now(), now() - interval '2 hours')`);
    ({ pool } = await import("../src/db"));
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/migrate")).migrate();
    app = (await import("../src/app")).createApp() as import("express").Express;
  });

  afterAll(async () => {
    await (await import("../src/atlas-link")).closeAtlas();
    await atlas.end();
    await pool?.end();
  });

  it("health shows every lender in mirror mode (no login here, Atlas linked)", async () => {
    const res = await authed(request(app).get("/api/health"));
    expect(res.body.atlasLink).toBe(true);
    expect(res.body.financiers.map((f: { mode: string }) => f.mode)).toEqual(["mirror", "mirror", "mirror", "mirror", "mirror"]);
  });

  it("a copy brings Atlas's rows over; the next copy reads only what changed", async () => {
    const { mirrorFinancier } = await import("../src/mirror");
    expect(await mirrorFinancier("GOODLEAP", null)).toEqual({ read: 2, written: 2 });
    // Rows changed in the last 5 s before the watermark are read again on purpose; nothing is rewritten.
    expect((await mirrorFinancier("GOODLEAP", null)).written).toBe(0);
    await atlas.query(`UPDATE financier_api_records SET raw = '{"loan":{"id":"26-41-006049","status":"FUNDED"}}', updated_at = now() WHERE external_id = '26-41-006049'`);
    expect((await mirrorFinancier("GOODLEAP", null)).written).toBe(1);
    // Now the watermark is past the untouched loan: the next copy reads only the changed one.
    expect(await mirrorFinancier("GOODLEAP", null)).toEqual({ read: 1, written: 0 });
    const row = await pool.query("SELECT raw->'loan'->>'status' AS s FROM financier_api_records WHERE external_id = '26-41-006049'");
    expect(row.rows[0].s).toBe("FUNDED");
    const pulls = await pool.query("SELECT trigger, found, ok FROM financier_api_pulls WHERE financier = 'GOODLEAP' ORDER BY id");
    expect(pulls.rows.map((r) => r.trigger)).toEqual(["mirror", "mirror", "mirror", "mirror"]);
  });

  it("Sync copies from Atlas (202, mode mirror) instead of refusing", async () => {
    const res = await authed(request(app).post("/api/financier-api/palmetto/pull").send({}));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true, mode: "mirror" });
    for (let i = 0; i < 50; i++) {
      const n = await pool.query("SELECT count(*)::int AS n FROM financier_api_records WHERE financier = 'PALMETTO'");
      if (n.rows[0].n === 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const page = await authed(request(app).get("/api/financier-api/palmetto/records"));
    expect(page.body.total).toBe(1);
  });

  it("lookup returns the project as Atlas has it, or says Atlas does not have it", async () => {
    await pool.query("DELETE FROM financier_api_records WHERE external_id = '25-40-000001'");
    const found = await authed(request(app).post("/api/financier-api/goodleap/lookup").send({ id: "2540000001" }));
    expect(found.body).toMatchObject({ externalId: "25-40-000001", status: "ok" });
    expect(found.body.id).toBeGreaterThan(0);
    const missing = await authed(request(app).post("/api/financier-api/goodleap/lookup").send({ id: "26-41-999999" }));
    expect(missing.body).toEqual({ id: null, externalId: "26-41-999999", status: "not_in_atlas" });
  });

  it("documents are listed from the saved record but not downloadable without the lender's login", async () => {
    const page = await authed(request(app).get("/api/financier-api/palmetto/records"));
    const id = page.body.rows[0].id;
    const list = await authed(request(app).get(`/api/financier-api/palmetto/records/${id}/documents`));
    expect(list.body.documents).toEqual([expect.objectContaining({ key: "d1:0", name: "c.pdf", downloadable: false })]);
    expect(list.body.note).toMatch(/copies Palmetto from Atlas/);
    expect((await authed(request(app).get(`/api/financier-api/palmetto/records/${id}/documents/d1:0`))).status).toBe(503);
  });

  it("the Atlas link cannot write, even if its login could", async () => {
    const { atlasReadOnly } = await import("../src/atlas-link");
    await expect(atlasReadOnly("INSERT INTO ops_finance_links VALUES ('GOODLEAP', 'x')")).rejects.toThrow(/read-only transaction/);
    const n = await atlas.query("SELECT count(*)::int AS n FROM ops_finance_links");
    expect(n.rows[0].n).toBe(0);
  });
});
