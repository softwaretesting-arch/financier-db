# financier-db

The backend of Atlas's **API** tab as its own service, with its own database. It connects straight to each lender
(EnFin, Concert, GoodLeap, Palmetto LightReach, Sunrun), saves every answer raw in Postgres, re-syncs every lender
every 15 minutes, and serves the data over a key-protected HTTP API: every project, every field, search across every
value, CSV export, documents, and lookup of a single project by its lender ID.

**Atlas is not changed.** Atlas keeps its own copy (`financier_api_*` tables in Atlas's database) and keeps syncing it.
This service keeps a second, independent copy. Either one can be the main source and the other the backup; nothing
here writes to Atlas.

The lender code in `src/financier-api/` is copied from Atlas (`artifacts/api-server/src/lib/financier-api/`, as merged
in softwaretesting-arch/AtlasCrm#400) with only its imports changed. A fix to a lender client should be made in both.

## Set it up on Replit

1. Create a Repl from this GitHub repo (Import from GitHub).
2. **Database:** add a Postgres database to the Repl (Tools → Database). Replit sets `DATABASE_URL`.
3. **Secrets** (Tools → Secrets), names in `.env.example`:
   - `FINANCIER_DB_API_KEYS`: a long random key (`openssl rand -hex 24`). Callers send it as `Authorization: Bearer <key>`.
   - The lender logins, the same values Atlas has: `ENFIN_CLIENT_ID`, `ENFIN_CLIENT_SECRET`, `ENFIN_USERNAME`,
     `ENFIN_PASSWORD`, `CONCERT_USERNAME`, `CONCERT_PASSWORD`, `GOODLEAP_CLIENT_ID`, `GOODLEAP_CLIENT_SECRET`,
     `PALMETTO_USERNAME`, `PALMETTO_PASSWORD`, `SUNRUN_USERNAME`, `SUNRUN_PASSWORD`, and for EnFin discovery
     `AURORA_API_TOKEN`, `AURORA_TENANT_ID`. Optional extras (`ENFIN_APPLICATION_NUMBERS`, `SUNRUN_DEAL_IDS`, …) are listed in `.env.example`.
   - Optional `ATLAS_READONLY_DATABASE_URL`: a **read-only** login to Atlas's database (Atlas's `atlas_analytics`
     role). Used to read the lender IDs Atlas projects are linked to, and by the one-time import below.
4. Press **Run**. The server applies its migrations, listens on port 8080 and starts the sync.
5. Check it: open `/api/healthz` (public), then `/api/health` with the key (see below).
6. **Deploy** as a **Reserved VM** (already set in `.replit`). Not Autoscale: the 15-minute sync runs inside the server,
   and Autoscale stops the process when no requests come in.

### Start with Atlas's data instead of an empty database (optional)

With `ATLAS_READONLY_DATABASE_URL` set, run once from the Repl shell:

```bash
pnpm import:atlas --dry-run
```

```bash
pnpm import:atlas
```

It copies Atlas's saved projects, the Aurora ledger and the typed-in EnFin IDs. Atlas is only read, inside READ ONLY
transactions. Running it again is safe: a project here is replaced only when Atlas's copy is newer.

## API

Every route except `/api/healthz` needs the key: `Authorization: Bearer <key>` or `X-Api-Key: <key>`. Financier codes
in paths: `enfin`, `concert`, `goodleap`, `palmetto`, `sunrun`.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/healthz` | Public. `{ ok, db: "up" }`, 503 when the database is down. For uptime checks. |
| GET | `/api/health` | Database latency, migrations, scheduler (leader, last tick), and for each lender: configured?, missing secrets, project counts, last sync. |
| GET | `/api/financier-api/summary` | The same per-lender summary Atlas's page reads. |
| GET | `/api/financier-api/:financier/records?page=&pageSize=&q=&onlyOk=1` | One page (25/50/100/200) of projects. Every field the lender returned is a column. `q` searches the lender ID and every value. GoodLeap IDs match with or without dashes. |
| GET | `/api/financier-api/:financier/csv` | Every project and every field as CSV (streamed). Lists stay one JSON cell. |
| GET | `/api/financier-api/:financier/records/:id` | One saved project, raw. |
| GET | `/api/financier-api/:financier/records/:id/documents` | Its documents (Palmetto saved; GoodLeap and EnFin live from the lender). |
| GET | `/api/financier-api/:financier/records/:id/documents/:key` | One document's bytes, fetched from the lender. Audited. |
| POST | `/api/financier-api/:financier/lookup` | `{ "id": "26-41-006049" }`: asks the lender for one project and saves it. Used when a lender's list misses a project. |
| POST | `/api/financier-api/:financier/pull` | Sync now, in the background (202). |
| POST | `/api/financier-api/enfin/ids` | `{ "ids": "CTRTPO-…, APPTPO-…" }`: add EnFin application IDs (EnFin has no list call). |
| POST | `/api/financier-api/enfin/discover` | Find EnFin IDs through Aurora, in the background (202). |
| GET | `/api/settings` | Every setting with its value and default. |
| PUT | `/api/settings/:key` | `{ "value": "15" }`: change one setting. Audited. |

```bash
curl -H "Authorization: Bearer $FINANCIER_DB_API_KEY" https://<your-repl>.replit.app/api/health
```

### Settings

Same keys and defaults as Atlas's Admin → System entries:

| Key | Default | Meaning |
|---|---|---|
| `FINANCIER_API_PULL_MINUTES` | 15 | Sync every N minutes (0 = only manual syncs). |
| `FINANCIER_API_CONCURRENCY` | 4 | Project reads in parallel per lender. |
| `FINANCIER_API_AURORA_RECRAWL_DAYS` | 7 | Re-read an Aurora project after N days. |
| `FINANCIER_API_DISCOVERY_MINUTES` | 10 | Length of one Aurora discovery slice. |
| `FINANCIER_API_ENFIN_IDS` | (empty) | EnFin application IDs to sync. |

## How it runs

- **Migrations** (`migrations/*.sql`) apply at boot, each once, recorded in `schema_migrations`. 0001–0003 are
  Atlas's 0422, 0423 and 0429 (same tables, so rows copy between the two databases). 0004 adds `financier_settings`
  and `financier_audit`.
- **Sync**: every minute the leader checks which lenders are due (last scheduled sync at least
  `FINANCIER_API_PULL_MINUTES` ago) and starts them side by side. Then it continues any Aurora discovery still waiting.
  One instance leads, using a Postgres advisory lock: two copies never sync twice. If the leader stops, another instance
  takes over within a minute.
- **Rate limits**: a lender's 429 is waited out (Retry-After) and retried. A sync that stops part-way resumes
  oldest-first on the next one.
- **Audit**: syncs, lookups, document downloads and setting changes go to `financier_audit` with the key number
  (`key#1`) and IP. The key itself is never stored.
- **Keys**: `FINANCIER_DB_API_KEYS` takes several keys separated by commas. To rotate, add the new one, move the
  callers, then remove the old one. With no key set, every route except `/api/healthz` answers 503.

## Develop

```bash
pnpm install
```

```bash
DATABASE_URL=postgresql://… FINANCIER_DB_API_KEYS=dev-key-0123456789 pnpm dev
```

```bash
pnpm run typecheck
```

```bash
TEST_DATABASE_URL=postgresql://…/financier_db_test pnpm test
```

`test/lenders.test.ts` runs the lender clients against mocked HTTP (copied from Atlas). `test/api.test.ts` runs the
HTTP API against a real, throwaway Postgres; it drops and recreates that database's `public` schema, so never point it
at a database you need. CI (`.github/workflows/ci.yml`) runs typecheck, both test files against Postgres 16, and the build.
