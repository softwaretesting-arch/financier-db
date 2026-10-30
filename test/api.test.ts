/**
 * The HTTP API against a real Postgres: migrations, health, the API key, records (every field, search), CSV, lookup
 * rules, settings and the audit trail. Needs TEST_DATABASE_URL pointing at an empty throwaway database (the test drops
 * and recreates its public schema); skipped without it.
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/financier_db_test pnpm test
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

const url = process.env.TEST_DATABASE_URL;
const KEY = "test-key-0123456789abcdef";

describe.skipIf(!url)("financier-db API (real Postgres)", () => {
  let app: import("express").Express;
  let pool: import("pg").Pool;

  beforeAll(async () => {
    process.env.FINANCIER_DB_API_KEYS = KEY;
    for (const k of Object.keys(process.env)) if (/^(ENFIN|CONCERT|GOODLEAP|PALMETTO|SUNRUN|AURORA)_/.test(k)) delete process.env[k];
    ({ pool } = await import("../src/db"));
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const { migrate } = await import("../src/migrate");
    const first = await migrate();
    expect(first.applied).toHaveLength(first.total);
    expect((await migrate()).applied).toEqual([]);
    await pool.query(`INSERT INTO financier_api_records (financier, external_id, source, status, raw, fetched_at) VALUES
      ('GOODLEAP', '26-41-006049', 'list', 'ok', '{"loan":{"id":"26-41-006049","borrower":{"address":{"city":"Tracy","street":"1 Example Way"}},"tags":["Sam","Example"]}}', now()),
      ('GOODLEAP', '25-40-000001', 'list', 'ok', '{"loan":{"id":"25-40-000001","solarOnly":true},"notes":[{"text":"hi"}]}', now() - interval '1 day'),
      ('PALMETTO', '6a0e165820faa365c431cb6a', 'list', 'ok', '{"account":{"id":"6a0e165820faa365c431cb6a","address":{"city":"Fresno"}}}', now())`);
    app = (await import("../src/app")).createApp() as import("express").Express;
  });

  afterAll(async () => { await pool?.end(); });

  const authed = (r: request.Test) => r.set("Authorization", `Bearer ${KEY}`);

  it("healthz is public and says the database is up", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: "financier-db", db: "up" });
  });

  it("every other route needs the key: none → 401, wrong → 401, X-Api-Key works too", async () => {
    expect((await request(app).get("/api/health")).status).toBe(401);
    expect((await request(app).get("/api/financier-api/summary").set("Authorization", "Bearer wrong-key-wrong-key")).status).toBe(401);
    expect((await request(app).get("/api/financier-api/summary").set("X-Api-Key", KEY)).status).toBe(200);
  });

  it("with no key configured the service refuses (503) instead of running open", async () => {
    const saved = process.env.FINANCIER_DB_API_KEYS;
    process.env.FINANCIER_DB_API_KEYS = "";
    expect((await request(app).get("/api/financier-api/summary").set("X-Api-Key", KEY)).status).toBe(503);
    process.env.FINANCIER_DB_API_KEYS = saved;
  });

  it("health reports the database, migrations, scheduler and all five financiers", async () => {
    const res = await authed(request(app).get("/api/health"));
    expect(res.status).toBe(200);
    expect(res.body.db).toMatchObject({ ok: true, migrations: { applied: 5, latest: "0005_mirror_state.sql" } });
    expect(res.body.financiers.map((f: { financier: string }) => f.financier)).toEqual(["ENFIN", "CONCERT", "GOODLEAP", "PALMETTO", "SUNRUN"]);
    const gl = res.body.financiers.find((f: { financier: string }) => f.financier === "GOODLEAP");
    expect(gl).toMatchObject({ configured: false, records: 2, ok: 2 });
    expect(gl.missing.length).toBeGreaterThan(0);
    expect(res.body.scheduler).toMatchObject({ pullMinutes: 15 });
  });

  it("a page shows every field the lender returned on any project, even ones only other pages have", async () => {
    const res = await authed(request(app).get("/api/financier-api/goodleap/records?q=Tracy"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, pages: 1 });
    expect(res.body.rows[0].externalId).toBe("26-41-006049");
    // loan.solarOnly and notes exist only on the other loan; they are still columns.
    expect(res.body.columns).toEqual(expect.arrayContaining(["loan.borrower.address.city", "loan.tags[0]", "loan.solarOnly", "notes"]));
  });

  it("search finds a GoodLeap id typed without dashes, and any value inside the record", async () => {
    const dashless = await authed(request(app).get("/api/financier-api/goodleap/records?q=2641006049"));
    expect(dashless.body.rows.map((r: { externalId: string }) => r.externalId)).toEqual(["26-41-006049"]);
    const palmetto = await authed(request(app).get("/api/financier-api/palmetto/records?q=Fresno"));
    expect(palmetto.body.total).toBe(1);
  });

  it("CSV has the Atlas columns then every lender field, one row per project", async () => {
    const res = await authed(request(app).get("/api/financier-api/goodleap/csv"));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    const lines = res.text.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]!.split(",").slice(0, 4)).toEqual(["_id", "_status", "_source", "_fetchedAt"]);
    expect(lines[0]).toContain("loan.solarOnly");
  });

  it("one record by id, and an unknown financier or record is a 404", async () => {
    const list = await authed(request(app).get("/api/financier-api/palmetto/records"));
    const id = list.body.rows[0].id;
    const one = await authed(request(app).get(`/api/financier-api/palmetto/records/${id}`));
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ financier: "PALMETTO", externalId: "6a0e165820faa365c431cb6a" });
    expect((await authed(request(app).get("/api/financier-api/aurora/records"))).status).toBe(404);
    expect((await authed(request(app).get("/api/financier-api/palmetto/records/999999"))).status).toBe(404);
  });

  it("lookup refuses text that is not a lender id (400), and an unconfigured lender (503)", async () => {
    expect((await authed(request(app).post("/api/financier-api/goodleap/lookup").send({ id: "1900 Village Drive" }))).status).toBe(400);
    expect((await authed(request(app).post("/api/financier-api/goodleap/lookup").send({ id: "26-41-999999" }))).status).toBe(503);
  });

  it("a bad JSON body is a 400, not a 500", async () => {
    const res = await authed(request(app).post("/api/financier-api/goodleap/lookup").set("Content-Type", "application/json").send("{nope"));
    expect(res.status).toBe(400);
  });

  it("settings: listed with defaults, validated, saved, read by the sync, and audited", async () => {
    const list = await authed(request(app).get("/api/settings"));
    expect(list.body.settings.find((s: { key: string }) => s.key === "FINANCIER_API_PULL_MINUTES")).toMatchObject({ value: "15", changed: false });
    expect((await authed(request(app).put("/api/settings/FINANCIER_API_PULL_MINUTES").send({ value: "5000" }))).status).toBe(400);
    expect((await authed(request(app).put("/api/settings/NOPE").send({ value: "1" }))).status).toBe(400);
    const ok = await authed(request(app).put("/api/settings/FINANCIER_API_PULL_MINUTES").send({ value: "30" }));
    expect(ok.body).toEqual({ key: "FINANCIER_API_PULL_MINUTES", value: "30" });
    const { getBookingRuleInt } = await import("../src/settings");
    expect(await getBookingRuleInt("FINANCIER_API_PULL_MINUTES")).toBe(30);
    await new Promise((r) => setTimeout(r, 100));
    const audit = await pool.query("SELECT action, target, actor FROM financier_audit WHERE action = 'setting_change'");
    expect(audit.rows).toEqual([{ action: "setting_change", target: "FINANCIER_API_PULL_MINUTES", actor: "key#1" }]);
  });

  it("EnFin ids typed in are normalized, saved as a setting and as records to sync", async () => {
    const res = await authed(request(app).post("/api/financier-api/enfin/ids").send({ ids: "ctrtpo-2606931317, nope" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: ["CTRTPO-2606931317"], rejected: ["nope"], ids: ["CTRTPO-2606931317"] });
    const rows = await pool.query("SELECT external_id, status FROM financier_api_records WHERE financier = 'ENFIN'");
    expect(rows.rows).toEqual([{ external_id: "CTRTPO-2606931317", status: "pending" }]);
  });

  it("a sync of an unconfigured lender says what is missing", async () => {
    const res = await authed(request(app).post("/api/financier-api/sunrun/pull").send({}));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Sunrun is not configured/);
  });

  it("with no key secret the service makes one, keeps it, and it cannot be read or changed through the API", async () => {
    const saved = process.env.FINANCIER_DB_API_KEYS;
    process.env.FINANCIER_DB_API_KEYS = "";
    const { loadApiKey, readOrCreateGeneratedKey } = await import("../src/auth");
    expect(await loadApiKey()).toBe("generated");
    const key = await readOrCreateGeneratedKey();
    expect(key).toMatch(/^fdb_[0-9a-f]{48}$/);
    expect(await readOrCreateGeneratedKey()).toBe(key);
    expect((await request(app).get("/api/health").set("X-Api-Key", key)).status).toBe(200);
    expect((await request(app).get("/api/health").set("X-Api-Key", KEY)).status).toBe(401);
    const list = await request(app).get("/api/settings").set("X-Api-Key", key);
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect((await request(app).put("/api/settings/_generated_api_key").set("X-Api-Key", key).send({ value: "x".repeat(20) })).status).toBe(400);
    process.env.FINANCIER_DB_API_KEYS = saved;
  });
});
