/**
 * API module project detail (owner Nav, 2026-10-30: "when we click on it … the right data in the tabs, like the
 * middleware, including the documents in downloadable format"). One saved record, its documents in one shape for every
 * lender, and the bytes of one document. Documents are listed from what the lender gives:
 *   Palmetto  saved documents[] (files have no link) → fresh link at download time
 *   GoodLeap  GET /loans/{id}/documents, live, in the loan's organization
 *   EnFin     Salesforce Attachments whose name carries the contract number, live
 *   Concert, Sunrun  no file bodies in their APIs (the middleware could not download them either)
 */
import { and, eq } from "drizzle-orm";
import { db, financierApiRecordsTable, type FinancierApiRecordRow } from "../db";
import { enfinAttachmentFile, enfinAttachments, normalizeEnfinId } from "./enfin";
import { goodleapDocumentFile, goodleapDocuments } from "./goodleap";
import { palmettoDocumentFile } from "./palmetto";
import { FinancierApiError, FINANCIER_API_LABELS, type FinancierApiProvider } from "./types";

export interface RecordDetail {
  id: number; financier: FinancierApiProvider; label: string; externalId: string; source: string; status: string;
  error: string | null; fetchedAt: string | null; raw: Record<string, unknown> | null;
}

export interface DetailDocument {
  key: string; name: string; type: string | null; status: string | null; sizeKB: number | null; createdAt: string | null; downloadable: boolean;
}

export interface DocumentList { documents: DetailDocument[]; note: string | null }

export async function getRecord(financier: FinancierApiProvider, id: number): Promise<RecordDetail> {
  if (!Number.isInteger(id) || id <= 0) throw new FinancierApiError(404, "Unknown record.");
  const [row] = await db.select().from(financierApiRecordsTable)
    .where(and(eq(financierApiRecordsTable.id, id), eq(financierApiRecordsTable.financier, financier))).limit(1);
  if (!row) throw new FinancierApiError(404, "Unknown record.");
  return toDetail(row);
}

function toDetail(row: FinancierApiRecordRow): RecordDetail {
  return {
    id: row.id, financier: row.financier as FinancierApiProvider, label: FINANCIER_API_LABELS[row.financier as FinancierApiProvider],
    externalId: row.externalId, source: row.source, status: row.status, error: row.error,
    fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null, raw: (row.raw as Record<string, unknown> | null) ?? null,
  };
}

const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** EnFin's contract number for a record: the saved appDetails.CTRNum, else the record id when it is one. */
export function enfinContractNumber(r: RecordDetail): string | null {
  return normalizeEnfinId(str(obj(obj(r.raw)?.appDetails)?.CTRNum) ?? "") ?? normalizeEnfinId(r.externalId);
}

/** Palmetto's saved documents[] → one row per file (key "<documentId>:<fileIndex>"). Exported for tests. */
export function palmettoSavedDocuments(raw: Record<string, unknown> | null): DetailDocument[] {
  const docs = Array.isArray(raw?.documents) ? raw!.documents as Record<string, unknown>[] : [];
  const out: DetailDocument[] = [];
  for (const d of docs) {
    const id = str(d.id) ?? str(d.documentId);
    if (!id || d.archived === true) continue;
    const files = Array.isArray(d.files) ? d.files as Record<string, unknown>[] : [];
    const created = str(obj(d.meta)?.createdAt) ?? str(d.createdAt);
    files.forEach((f, i) => out.push({
      key: `${id}:${i}`, name: str(f.originalName) ?? str(f.fileName) ?? str(d.type) ?? id, type: str(d.type), status: str(d.status),
      sizeKB: num(f.sizeKB), createdAt: created, downloadable: true,
    }));
  }
  return out;
}

/** Attachments named on GoodLeap review cases (cases[].attachments[]). Not downloadable. Exported for tests. */
export function goodleapCaseAttachments(raw: Record<string, unknown> | null): DetailDocument[] {
  const cases = Array.isArray(raw?.cases) ? raw!.cases as Record<string, unknown>[] : [];
  return cases.flatMap((c) => (Array.isArray(c.attachments) ? c.attachments as Record<string, unknown>[] : []).map((a, i) => ({
    key: `case:${str(a.id) ?? i}`, name: str(a.name) ?? str(a.type) ?? "Attachment", type: str(a.type) ?? str(c.name),
    status: str(a.status), sizeKB: null, createdAt: str(c.createdAt), downloadable: false,
  })));
}

export async function listDocuments(r: RecordDetail): Promise<DocumentList> {
  switch (r.financier) {
    case "PALMETTO":
      return { documents: palmettoSavedDocuments(r.raw), note: null };
    case "GOODLEAP": {
      const docs = await goodleapDocuments(r.externalId, str(obj(r.raw)?.organizationId) ?? "");
      const listed: DetailDocument[] = docs.map((d) => ({ key: d.id, name: d.name, type: d.type, status: d.status, sizeKB: null, createdAt: d.createdAt, downloadable: !!d.url }));
      // GoodLeap answers 404 to /documents on most loans (the middleware had none either); its review cases still name
      // the attachments they hold, so those are listed (GoodLeap gives no download for them).
      const caseFiles = goodleapCaseAttachments(r.raw);
      return {
        documents: [...listed, ...caseFiles],
        note: listed.length ? null : caseFiles.length ? "GoodLeap gives no file downloads for this loan; these are the attachments on its review cases." : "GoodLeap has no documents on this loan.",
      };
    }
    case "ENFIN": {
      const ctr = enfinContractNumber(r);
      const docs = ctr ? await enfinAttachments(ctr) : [];
      return {
        documents: docs.map((d) => ({ key: d.id, name: d.name, type: d.contentType, status: null, sizeKB: d.sizeKB, createdAt: d.createdAt, downloadable: true })),
        note: docs.length ? null : "EnFin has no documents for this application.",
      };
    }
    case "CONCERT":
      return { documents: [], note: "Concert's API lists document requirements but gives no files to download." };
    case "SUNRUN":
      return { documents: [], note: "Sunrun's API gives no documents for a deal." };
  }
}

export async function downloadDocument(r: RecordDetail, key: string): Promise<{ fileName: string; contentType: string; body: Buffer }> {
  let file: { fileName: string; contentType: string; body: Buffer } | null = null;
  if (r.financier === "PALMETTO") {
    const doc = palmettoSavedDocuments(r.raw).find((d) => d.key === key);
    const [docId, index] = key.split(":");
    if (doc && docId) file = await palmettoDocumentFile(r.externalId, docId, Number(index));
  } else if (r.financier === "GOODLEAP") {
    file = await goodleapDocumentFile(r.externalId, key, str(obj(r.raw)?.organizationId) ?? "");
  } else if (r.financier === "ENFIN") {
    const ctr = enfinContractNumber(r);
    if (ctr) file = await enfinAttachmentFile(ctr, key);
  }
  if (!file) throw new FinancierApiError(404, "That document is not available from the lender.");
  // Lenders mislabel types (EnFin sends "application/octetstream"); trust the bytes for PDFs.
  if (file.body.subarray(0, 5).toString("latin1") === "%PDF-") file.contentType = "application/pdf";
  return file;
}
