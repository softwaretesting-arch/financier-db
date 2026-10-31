# financier-db

The backend of Atlas's **API** tab as its own service, with its own database. It connects straight to each lender
(EnFin, Concert, GoodLeap, Palmetto LightReach, Sunrun), saves every answer raw in Postgres, re-syncs every lender
every 15 minutes, and serves the data over a key-protected HTTP API: every project, every field, search across every
value, CSV export, documents, and lookup of a single project by its lender ID.

**Atlas is not changed.** Atlas keeps its own copy (`financier_api_*` tables in Atlas's database) and keeps syncing it.
This service keeps a second copy in its own database. Nothing here writes to Atlas. With only the Atlas link set, the
second copy follows Atlas (mirror mode). With the lender logins set, it reads the lenders itself and is fully
independent (direct mode). Either can be the main source and the other the backup.

The lender code in `src/financier-api/` is copied from Atlas (`artifacts/api-server/src/lib/financier-api/`, as merged
in softwaretesting-arch/AtlasCrm#400) with only its imports changed. A fix to a lender client should be made in both.

## Set it up on Replit

A new Repl cannot read Atlas's secrets (Replit keeps each Repl's secrets to itself), so the service is built to need
as little as possible. **No lender login has to be copied from Atlas.**

1. Create a Repl from this GitHub repo (Import from GitHub).
2. **Database:** add a Postgres database to the Repl (Tools → Database). Replit sets `DATABASE_URL` itself.
3. **One secret:** `ATLAS_READONLY_DATABASE_URL`, a **read-only** login to Atlas's database (Atlas's `atlas_analytics`
   role). With it, every lender runs in **mirror mode**: the service copies that lender's projects from Atlas every
   15 minutes (only what changed). The first copy brings everything over (3,380 projects in about a minute in testing).
4. Press **Run**. The server applies its migrations, makes its own API key, listens on port 8080 and starts copying.
5. Get the API key: run `pnpm api-key` in the Repl shell. Callers send it as `Authorization: Bearer <key>`. It is
   kept in this service's database and never written to the logs. (To choose your own key, set
   `FINANCIER_DB_API_KEYS` instead.)
6. Check it: open `/api/healthz` (public), then `/api/health` with the key. Each lender shows `"mode": "mirror"`.
7. **Deploy** as a **Reserved VM** (already set in `.replit`). Don't use Autoscale: the 15-minute sync runs inside the
   server, and Autoscale stops the process when no requests come in.

### Modes, per lender

| Mode | When | Where the data comes from |
|---|---|---|
| `direct` | That lender's login is set on this service (names in `.env.example`, same as Atlas) | The lender itself, every 15 minutes. With `ATLAS_READONLY_DATABASE_URL` also set, Atlas is the **fallback** (`fallbackFromAtlas: true`). |
| `mirror` | No login for that lender here, `ATLAS_READONLY_DATABASE_URL` set | Atlas's saved copy, every 15 minutes. |
| `off` | Neither | Nothing new; what is already saved stays readable. |

**Recommended: direct + fallback.** Paste the lender logins from Atlas's Secrets into this Repl's Secrets and keep
`ATLAS_READONLY_DATABASE_URL`. Every 15 minutes each lender is read directly, and Atlas's copy fills whatever the direct
pull missed or couldn't read. For every project, whichever side read it from the lender most recently wins. An older
Atlas copy never overwrites a fresher direct read, and a failed read on either side never replaces good data.

Adding a lender's login switches that lender to `direct` on the next tick. In plain `mirror` mode, a few things need
the lender itself and say so instead of failing silently:
- Document **downloads** answer 503.
- **Lookup** of a single ID returns Atlas's copy (`not_in_atlas` when Atlas lacks it).
- **Aurora → EnFin discovery** runs only with the Aurora secrets set.

The Atlas link only reads: every query runs in a READ ONLY transaction, so even a login that could write is refused by
Postgres. Still use a read-only login.

### Start with Atlas's data in one go (optional)

Mirror mode already does this on its first tick. To copy everything by hand, including the Aurora ledger and the typed-in
EnFin IDs, run this from the Repl shell:

```bash
pnpm import:atlas --dry-run
```

```bash
pnpm import:atlas
```

Running it again is safe: a project here is replaced only when Atlas's copy is newer.

## API

Every route except `/api/healthz` needs the key: `Authorization: Bearer <key>` or `X-Api-Key: <key>`. Financier codes
in paths: `enfin`, `concert`, `goodleap`, `palmetto`, `sunrun`.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/healthz` | Public. `{ ok, db: "up" }`, 503 when the database is down. For uptime checks. |
| GET | `/api/health` | Database latency, migrations, scheduler (leader, last tick), and for each lender: mode (direct / mirror / off), missing secrets, project counts, last sync, mirror progress. |
| GET | `/api/financier-api/summary` | The same per-lender summary Atlas's page reads. |
| GET | `/api/financier-api/:financier/records?page=&pageSize=&q=&onlyOk=1` | One page (25/50/100/200) of projects. Every field the lender returned is a column. `q` searches the lender ID and every value. GoodLeap IDs match with or without dashes. |
| GET | `/api/financier-api/:financier/csv` | Every project and every field as CSV (streamed). Lists stay one JSON cell. |
| GET | `/api/financier-api/:financier/records/:id` | One saved project, raw. |
| GET | `/api/financier-api/:financier/records/:id/documents` | Its documents (Palmetto saved; GoodLeap and EnFin live from the lender). |
| GET | `/api/financier-api/:financier/records/:id/documents/:key` | One document's bytes, fetched from the lender. Audited. |
| POST | `/api/financier-api/:financier/lookup` | `{ "id": "26-41-006049" }`: asks the lender for one project and saves it. Used when a lender's list misses a project. |
| POST | `/api/financier-api/:financier/pull` | Sync now, in the background (202). In mirror mode: copy from Atlas now. |
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
  and `financier_audit`; 0005 adds `financier_mirror_state`; 0006 adds its resume cursor.
- **Sync**: every minute the leader checks which lenders are due (last scheduled sync at least
  `FINANCIER_API_PULL_MINUTES` ago) and starts them side by side. Then it continues any Aurora discovery still waiting.
  One instance leads, using a Postgres advisory lock: two copies never sync twice. If the leader stops, another instance
  takes over within a minute.
- **Rate limits**: a lender's 429 is waited out (Retry-After) and retried. A sync that stops part-way resumes
  oldest-first on the next one.
- **Audit**: syncs, lookups, document downloads and setting changes go to `financier_audit` with the key number
  (`key#1`) and IP. The key itself is never stored.
- **Keys**: without `FINANCIER_DB_API_KEYS` the service uses the key it made for itself (`pnpm api-key`). With it, it
  uses those keys instead: several keys separated by commas. To rotate, add the new one, move the callers, then remove
  the old one. There is never a keyless mode: with no key at all every route except `/api/healthz` answers 503.
- **Mirror**: each lender's copy from Atlas reads Atlas's rows in (updated_at, id) order and saves its place after every
  batch (`financier_mirror_state`). A copy cut short by a deploy or restart resumes where it stopped on the next tick.
  Palmetto moves 25 rows at a time because its rows are large. An empty database fills in about 2 minutes (3,380
  projects in testing). Copies show in the summary as syncs with trigger `mirror`.
- **Same as Atlas?** `/api/healthz` shows `sameAsAtlas` and `copiedPercent` per lender (Atlas count at most 5 minutes
  old). `/api/health` (key) shows both counts, counted fresh.

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
HTTP API against a real, throwaway Postgres. `test/mirror.test.ts` also needs `TEST_ATLAS_DATABASE_URL`, a second
throwaway database that stands in for Atlas. Both tests drop and recreate their databases' `public` schema, so never
point them at a database you need. CI (`.github/workflows/ci.yml`) runs typecheck, both test files against Postgres 16, and the build.
