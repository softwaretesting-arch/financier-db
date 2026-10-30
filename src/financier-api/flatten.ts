/**
 * Raw lender JSON → spreadsheet cells. Nested objects become dotted column names (`financeDetails.term`), arrays
 * become indexed names (`eligibilities[0].overallStatus`). Nothing is renamed, converted or dropped: the owner
 * asked for raw data, so a column is exactly the lender's key path.
 */
export type Cell = string | number | boolean | null;

export function flatten(value: unknown, prefix = "", out: Record<string, Cell> = {}): Record<string, Cell> {
  if (value === null || value === undefined) { if (prefix) out[prefix] = null; return out; }
  if (Array.isArray(value)) {
    if (value.length === 0) { if (prefix) out[prefix] = "[]"; return out; }
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) { if (prefix) out[prefix] = "{}"; return out; }
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix || "value"] = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : String(value);
  return out;
}

/**
 * The CSV flattening: objects become dotted columns like on the page, but every list stays one cell holding its JSON.
 * Palmetto's activity histories flatten to ~737,000 columns across 2,384 accounts (1.75 billion cells), which ran the
 * process out of memory (2026-10-29); with lists kept whole the CSV has a few hundred columns and every value is kept.
 */
export function flattenForCsv(value: unknown, prefix = "", out: Record<string, Cell> = {}): Record<string, Cell> {
  if (value === null || value === undefined) { if (prefix) out[prefix] = null; return out; }
  if (Array.isArray(value)) { out[prefix || "value"] = JSON.stringify(value); return out; }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) { if (prefix) out[prefix] = "{}"; return out; }
    for (const [k, v] of entries) flattenForCsv(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix || "value"] = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : String(value);
  return out;
}

/** One CSV line (with its line break) for these columns. */
export function csvLine(columns: readonly string[], row: Readonly<Record<string, Cell>>): string {
  return `${columns.map((c) => csvCell(row[c] ?? null)).join(",")}\r\n`;
}

/** Column names across rows, in first-seen order (so a lender's own order is kept). */
export function columnsOf(rows: readonly Record<string, Cell>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

function csvCell(v: Cell): string {
  if (v === null) return "";
  const s = typeof v === "string" ? v : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: readonly string[], rows: readonly Record<string, Cell>[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c] ?? null)).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
