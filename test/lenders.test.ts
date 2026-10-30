/**
 * Lender clients and pure helpers, copied from Atlas's src/test/financier-api.test.ts (same wire contracts, same id
 * rules, same flattening). The Atlas tests that need Atlas's login or its mocked database are replaced by
 * test/api.test.ts, which runs against a real Postgres.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { columnsOf, csvLine, flatten, flattenForCsv, toCsv } from "../src/financier-api/flatten";
import { enfinGetProject, enfinEnvIds, enfinListApplications, normalizeEnfinId } from "../src/financier-api/enfin";
import { concertCustomerBundle, concertListCustomers } from "../src/financier-api/concert";
import { goodleapListLoans, goodleapLoanBundle, GOODLEAP_ORG_KEY, normalizeGoodleapId } from "../src/financier-api/goodleap";
import { sunrunDealBundle, sunrunReadIds } from "../src/financier-api/sunrun";
import { enfinIdsInFinancing } from "../src/financier-api/aurora-discovery";
import { fetchJson, forgetToken, retryAfterSeconds } from "../src/financier-api/http";
import { asProvider, FINANCIER_API_PROVIDERS } from "../src/financier-api/types";
import { PROVIDER_CLIENTS } from "../src/financier-api/providers";
import { lookupIdShape, withEveryField } from "../src/financier-api/store";
import { goodleapCaseAttachments, palmettoSavedDocuments } from "../src/financier-api/detail";

beforeEach(() => { vi.clearAllMocks(); });

describe("financier codes", () => {
  it("every financier has a client and only those codes are known", () => {
    for (const code of FINANCIER_API_PROVIDERS) expect(PROVIDER_CLIENTS[code].code).toBe(code);
    expect(asProvider("goodleap")).toBe("GOODLEAP");
    expect(asProvider("aurora")).toBeNull();
  });
});



describe("every listed project is saved before its detail read (production Palmetto stalled near 500 of 2,384)", () => {
  it("each lender with a list shapes its list row like the saved record", () => {
    expect(PROVIDER_CLIENTS.PALMETTO.listRaw!({ id: "a1" })).toEqual({ account: { id: "a1" } });
    expect(PROVIDER_CLIENTS.CONCERT.listRaw!({ customerId: 5 })).toEqual({ list: { customerId: 5 } });
    expect(PROVIDER_CLIENTS.SUNRUN.listRaw!({ Id: "810" })).toEqual({ serviceContract: { Id: "810" } });
    expect(PROVIDER_CLIENTS.GOODLEAP.listRaw!({ id: "AB-CD-111111", _organizationId: "org-a" })).toEqual({ loan: { id: "AB-CD-111111" }, organizationId: "org-a" });
    expect(PROVIDER_CLIENTS.ENFIN.listRaw).toBeUndefined();
  });
});

describe("search reaches the lender for a missing id (GoodLeap 26-41-006049, owner Nav 2026-10-30)", () => {
  it("only lender-shaped ids are asked of the lender, normalized", () => {
    expect(lookupIdShape("GOODLEAP", "2641006049")).toBe("26-41-006049");
    expect(lookupIdShape("GOODLEAP", "26-41-006049")).toBe("26-41-006049");
    expect(lookupIdShape("GOODLEAP", "1900 Village Drive")).toBeNull();
    expect(lookupIdShape("ENFIN", "ctrtpo-26101037512")).toBe("CTRTPO-26101037512");
    expect(lookupIdShape("PALMETTO", "6a0e165820faa365c431cb6a")).toBe("6a0e165820faa365c431cb6a");
    expect(lookupIdShape("PALMETTO", "Fresno")).toBeNull();
    expect(lookupIdShape("CONCERT", "123456")).toBe("123456");
  });

});

describe("project detail documents (owner Nav, 2026-10-30)", () => {
  it("Palmetto: one row per saved file, keyed document:index, archived documents left out", () => {
    const docs = palmettoSavedDocuments({ documents: [
      { id: "d1", type: "contract", status: "approved", meta: { createdAt: "2026-05-21T00:00:00Z" }, files: [{ originalName: "contract.pdf", sizeKB: 3900 }, { originalName: "page2.pdf", sizeKB: 10 }] },
      { id: "d2", type: "utilityBill", archived: true, files: [{ originalName: "old.pdf" }] },
    ] });
    expect(docs.map((d) => [d.key, d.name, d.type, d.status, d.sizeKB, d.downloadable])).toEqual([
      ["d1:0", "contract.pdf", "contract", "approved", 3900, true], ["d1:1", "page2.pdf", "contract", "approved", 10, true],
    ]);
    expect(palmettoSavedDocuments({ documents: { _error: "x" } })).toEqual([]);
  });

  it("GoodLeap: attachments named on review cases are listed, never as downloads", () => {
    const docs = goodleapCaseAttachments({ cases: [{ name: "Income check", createdAt: "2026-10-01", attachments: [{ id: "a1", name: "paystub.pdf", status: "RECEIVED" }] }] });
    expect(docs).toEqual([{ key: "case:a1", name: "paystub.pdf", type: "Income check", status: "RECEIVED", sizeKB: null, createdAt: "2026-10-01", downloadable: false }]);
  });

});

describe("flatten: raw lender JSON → spreadsheet cells", () => {
  it("dots objects, indexes arrays, keeps zero / false / null / empty apart", () => {
    const cells = flatten({ appDetails: { CTRNum: "CTRTPO-1", appStatus: "Funded" }, financeDetails: { term: 25, monthlyPayment: 0, ach: false, note: null }, docs: [{ id: 1 }, { id: 2 }], empty: [], none: {} });
    expect(cells).toEqual({
      "appDetails.CTRNum": "CTRTPO-1", "appDetails.appStatus": "Funded", "financeDetails.term": 25, "financeDetails.monthlyPayment": 0,
      "financeDetails.ach": false, "financeDetails.note": null, "docs[0].id": 1, "docs[1].id": 2, empty: "[]", none: "{}",
    });
    expect(columnsOf([{ b: 1, a: 2 }, { c: 3, a: 4 }])).toEqual(["b", "a", "c"]);
    expect(toCsv(["a", "b"], [{ a: 'x,"y"', b: null }])).toBe('a,b\r\n"x,""y""",\r\n');
  });
});

describe("CSV: lists stay one JSON cell so wide lenders stay a few hundred columns (Palmetto, 2026-10-29)", () => {
  it("objects become dotted columns, lists become one JSON cell, empty values keep their shape", () => {
    const raw = { account: { id: "a1", address: { city: "Fresno" } }, activity: [{ type: "x" }, { type: "y" }], adders: [], meta: {} };
    expect(flattenForCsv(raw)).toEqual({ "account.id": "a1", "account.address.city": "Fresno", activity: '[{"type":"x"},{"type":"y"}]', adders: "[]", meta: "{}" });
    expect(csvLine(["account.id", "activity", "missing"], flattenForCsv(raw))).toBe('a1,"[{""type"":""x""},{""type"":""y""}]",\r\n');
  });
});

describe("id rules", () => {
  it("EnFin ids are CTRTPO-/APPTPO- numbers; GoodLeap bare ids fold to XX-XX-XXXXXX", () => {
    expect(normalizeEnfinId(" ctrtpo-2606931317 ")).toBe("CTRTPO-2606931317");
    expect(normalizeEnfinId("CONCERT:12")).toBeNull();
    process.env.ENFIN_APPLICATION_NUMBERS = "CTRTPO-2606931317, nope, APPTPO-1234567";
    expect(enfinEnvIds()).toEqual(["CTRTPO-2606931317", "APPTPO-1234567"]);
    delete process.env.ENFIN_APPLICATION_NUMBERS;
    expect(normalizeGoodleapId("2541023591")).toBe("25-41-023591");
    expect(normalizeGoodleapId("25-41-023591")).toBe("25-41-023591");
  });


  it("any lender: a 429 is waited out (Retry-After) and retried instead of failing the row (Palmetto, 2026-10-29)", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1
      ? new Response('{"message":"Rate limit exceeded. Please try again later."}', { status: 429, headers: { "retry-after": "1" } })
      : Response.json({ id: "acct-1" }))));
    const t0 = Date.now();
    const out = await fetchJson<{ id: string }>("https://rl.example.test/api/accounts/acct-1");
    expect(out.body).toEqual({ id: "acct-1" });
    expect(n).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    vi.unstubAllGlobals();
  });

  it("retry-after: header seconds, header date, or Aurora's body text; otherwise null", () => {
    expect(retryAfterSeconds("7", "")).toBe(7);
    expect(retryAfterSeconds(new Date(Date.now() + 30_000).toUTCString(), "")).toBeGreaterThanOrEqual(29);
    expect(retryAfterSeconds(null, '{"errors":[{"message":"Retry after 20 seconds"}]}')).toBe(20);
    expect(retryAfterSeconds(null, "slow down")).toBeNull();
  });

  it("finds the EnFin application id on an Aurora financing (financier.external.request_id) and anywhere in the detail", () => {
    const found = enfinIdsInFinancing({ financier: { provider: "enfin", status: "approved", external: { request_id: "CTRTPO-2606931317" } }, name: "EnFin PPA" });
    expect(found).toEqual({ requestId: "CTRTPO-2606931317", provider: "enfin", scanned: ["CTRTPO-2606931317"] });
    expect(enfinIdsInFinancing({ financier: { provider: "goodleap" }, notes: "see APPTPO-99887766" }).scanned).toEqual(["APPTPO-99887766"]);
  });
});

describe("direct lender clients (fetch mocked)", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const saved = { ...process.env };
  beforeEach(() => {
    calls.length = 0;
    forgetToken("ENFIN"); forgetToken("CONCERT");
    Object.assign(process.env, { ENFIN_CLIENT_ID: "id", ENFIN_CLIENT_SECRET: "s", ENFIN_USERNAME: "u", ENFIN_PASSWORD: "p", CONCERT_USERNAME: "cu", CONCERT_PASSWORD: "cp" });
  });
  afterEach(() => { vi.unstubAllGlobals(); process.env = { ...saved }; });

  function answer(routes: Record<string, unknown | ((url: string) => unknown)>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) return new Response("not found", { status: 404 });
      const v = routes[key];
      return new Response(JSON.stringify(typeof v === "function" ? (v as (u: string) => unknown)(url) : v), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  it("EnFin: password grant, then POST getProjectInformation with appId + organizationName; non-SUCCESS is not found", async () => {
    answer({ "/services/oauth2/token": { access_token: "tok" }, getProjectInformation: (u: string) => (u ? { status: "SUCCESS", appDetails: { CTRNum: "CTRTPO-1", appStatus: "Funded" } } : {}) });
    const a = await enfinGetProject("CTRTPO-1");
    expect(a.status).toBe("ok");
    expect(a.raw).toMatchObject({ appDetails: { CTRNum: "CTRTPO-1" } });
    const token = calls[0]!;
    expect(token.url).toBe("https://enfincorp.my.salesforce.com/services/oauth2/token");
    expect(String(token.init.body)).toContain("grant_type=password");
    const info = calls[1]!;
    expect(info.url).toBe("https://enfincorp.my.salesforce.com/services/apexrest/enfin/getProjectInformation");
    expect((info.init.headers as Record<string, string>).authorization).toBe("OAuth tok");
    expect(JSON.parse(String(info.init.body))).toEqual({ appId: "CTRTPO-1", organizationName: "Elevation Energy Solutions" });
    // Second call reuses the cached token.
    calls.length = 0;
    answer({ getProjectInformation: { status: "NO_RECORD", reason: "no match" } });
    const miss = await enfinGetProject("CTRTPO-2");
    expect(miss.status).toBe("not_found");
    expect(calls.some((c) => c.url.includes("oauth2/token"))).toBe(false);
  });

  it("EnFin: lists our installer's applications with a Salesforce query filtered to our organization, following nextRecordsUrl (live check 2026-10-29)", async () => {
    answer({
      "/services/oauth2/token": { access_token: "tok" },
      "/query/01g-2000": { records: [{ Temp_Active_Contract_No__c: "apptpo-55554444" }, { Temp_Active_Contract_No__c: null }] },
      "/query?q=": { records: [{ Temp_Active_Contract_No__c: "CTRTPO-2606931317" }, { Temp_Active_Contract_No__c: "CTRTPO-2606931317" }], nextRecordsUrl: "/services/data/v60.0/query/01g-2000" },
    });
    expect(await enfinListApplications()).toEqual(["CTRTPO-2606931317", "APPTPO-55554444"]);
    const first = calls.find((c) => c.url.includes("/query?q="))!;
    const soql = decodeURIComponent(first.url.split("q=")[1]!);
    expect(soql).toBe("SELECT Temp_Active_Contract_No__c FROM Account WHERE Partner_Installer_Account__c = 'Elevation Energy Solutions' AND Temp_Active_Contract_No__c != null");
    expect((first.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("Sunrun: per-deal reads use the proposal number, contract number and prospect id from the ServiceContract row, colon kept (live check 2026-10-29)", async () => {
    forgetToken("SUNRUN");
    Object.assign(process.env, { SUNRUN_USERNAME: "su", SUNRUN_PASSWORD: "sp", SUNRUN_SANDBOX: "false" });
    const row = { Id: "810UJ00000WAt41YAD", Name: "3005536724", Prospect_Id__c: "9727926531", Proposal_Name__c: "PK6674LNCRD9:003-H" };
    expect(sunrunReadIds(row.Id, row)).toEqual({ proposal: "PK6674LNCRD9:003-H", contract: "3005536724", lead: "9727926531" });
    expect(sunrunReadIds("PK6VZAARKA11-A")).toEqual({ proposal: "PK6VZAARKA11-A", contract: "PK6VZAARKA11-A", lead: "PK6VZAARKA11-A" });
    answer({
      "/v2/login": { sessionId: "sess", restApiBaseUrl: "https://sunrun.my.salesforce.com/services/apexrest" },
      "/v2/proposals/PK6674LNCRD9:003-H": { proposalNumber: "PK6674LNCRD9:003-H" },
      "/v2/contracts/3005536724": { contractNumber: "3005536724" },
      "/v2/leads/9727926531": { prospectId: "9727926531" },
    });
    const a = await sunrunDealBundle(row.Id, row);
    expect(a.status).toBe("ok");
    expect(a.raw).toMatchObject({ serviceContract: row, proposal: { proposalNumber: "PK6674LNCRD9:003-H" }, contract: { contractNumber: "3005536724" }, lead: { prospectId: "9727926531" } });
    const paths = calls.map((c) => c.url.replace("https://sunrun.my.salesforce.com/services/apexrest", ""));
    expect(paths).toContain("/v2/proposals/PK6674LNCRD9:003-H");
    expect(paths.some((p) => p.includes("%3A") || p.includes("810UJ"))).toBe(false);
  });

  it("GoodLeap: lists each connected organization's loans with that organization's token, following links.next (live check 2026-10-29)", async () => {
    for (const k of ["GOODLEAP:", "GOODLEAP:org-a"]) forgetToken(k);
    Object.assign(process.env, { GOODLEAP_CLIENT_ID: "gid", GOODLEAP_CLIENT_SECRET: "gs", GOODLEAP_LOAN_TAGS: "", GOODLEAP_PARTNER_ORG_IDS: "" });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = init.body ? JSON.parse(String(init.body)) as { organizationId?: string } : {};
      if (url.endsWith("/auth/organizations")) return Response.json({ data: [{ id: "org-a", name: "Lytegen" }] });
      if (url.endsWith("/auth/token")) return Response.json({ token: body.organizationId ? "tok-a" : "tok-home" });
      if (url.endsWith("/posfinancing/rest/v2/loans")) return Response.json({ data: [{ id: "AB-CD-111111" }], links: { next: "/posfinancing/rest/v2/loans?pageSize=50&pageAfter=x" } });
      if (url.includes("pageAfter=x")) return Response.json({ data: [{ id: "AB-CD-222222" }], links: { next: null } });
      return new Response("not found", { status: 404 });
    }));
    const list = await goodleapListLoans();
    expect(list.ids.map((i) => i.externalId)).toEqual(["AB-CD-111111", "AB-CD-222222"]);
    expect(list.rows?.get("AB-CD-222222")?.[GOODLEAP_ORG_KEY]).toBe("org-a");
    expect(list.message).toBeNull();
    const pages = calls.filter((c) => c.url.includes("/loans"));
    expect(pages.map((c) => c.url)).toEqual(["https://api.goodleap.com/posfinancing/rest/v2/loans", "https://api.goodleap.com/posfinancing/rest/v2/loans?pageSize=50&pageAfter=x"]);
    expect(pages.every((c) => (c.init.headers as Record<string, string>).authorization === "Bearer tok-a")).toBe(true);

    // A loan whose detail GoodLeap answers with 500 keeps its list row and the reason.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/auth/organizations")) return Response.json({ data: [] });
      if (url.endsWith("/auth/token")) return Response.json({ token: "tok-a" });
      return new Response('[{"code":"INTERNAL_SERVER_ERROR"}]', { status: 500 });
    }));
    const kept = await goodleapLoanBundle("AB-CD-333333", "org-a", { id: "AB-CD-333333", status: "FUNDED", [GOODLEAP_ORG_KEY]: "org-a" });
    expect(kept.status).toBe("ok");
    expect(kept.raw).toMatchObject({ loan: { id: "AB-CD-333333", status: "FUNDED" }, organizationId: "org-a" });
    expect(String((kept.raw as Record<string, unknown>).loanError)).toContain("(500)");
  });

  it("Concert: Basic app client + password in the query, customers list, and the per-customer bundle keeps every read raw", async () => {
    answer({
      "/oauth/token": { access_token: "ct", expires_in: 100 },
      "/rest/v3/customers/42/eligibilities": { status: "ok", count: 1, results: [{ overallStatus: "APPROVED" }] },
      "/rest/v3/customers/42/financing-requests": { results: [] },
      "/rest/v3/customers/42/financing-methods": { results: [{ apr: 7.99 }] },
      "/rest/v3/customers/42/measures": { results: [] },
      "/rest/v3/milestone-disbursements": { results: [{ milestone: "M1", disbursement: { customerId: 42 } }, { milestone: "M1", disbursement: { customerId: 7 } }] },
      "/rest/v3/customers/42": { results: [{ id: 42, cfirstname: "A" }] },
      "/rest/v3/customers": { count: 2, results: [{ customerId: 42 }, { customerId: 43 }] },
    });
    const list = await concertListCustomers();
    expect(list.ids.map((i) => i.externalId)).toEqual(["42", "43"]);
    const tokenCall = calls[0]!;
    expect(tokenCall.url.split("?")[0]).toBe("https://api.concertfin.com/oauth/token");
    expect(tokenCall.url).toContain("grant_type=password");
    expect((tokenCall.init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
    const bundle = await concertCustomerBundle("42", { customerId: 42 });
    expect(bundle.status).toBe("ok");
    expect(bundle.raw).toMatchObject({ list: { customerId: 42 }, customer: { id: 42, cfirstname: "A" }, eligibilities: [{ overallStatus: "APPROVED" }], financingMethods: [{ apr: 7.99 }] });
    expect(bundle.raw.milestoneDisbursements).toEqual([{ milestone: "M1", disbursement: { customerId: 42 } }]);
    expect(bundle.raw.eligibilitiesEnvelope).toMatchObject({ count: 1 });
  });
});

describe("withEveryField (every lender field is a table column)", () => {
  it("keeps the page's columns and adds the fields no page column covers", () => {
    const page = ["loan.id", "loan.tags[0]", "loan.tags[1]", "activity[0].type", "quotes"];
    const fields = ["activity", "loan.id", "loan.solarOnly", "loan.tags", "quotes", "zip"];
    expect(withEveryField(page, fields)).toEqual([...page, "loan.solarOnly", "zip"]);
  });
  it("leaves the page alone when the field list is not ready", () => {
    expect(withEveryField(["a", "b"], [])).toEqual(["a", "b"]);
  });
});
