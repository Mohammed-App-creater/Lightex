/*
 * Board 40 mock: a small RFC 4180 reader (§5.2, §7.3, §7.4). Quotes open only at the start of a
 * field; "" inside quotes is a quote; CR, LF and CRLF end a record; newlines inside quotes are kept.
 * Completely empty lines are ignored (like Python's csv module yielding []). A quote that is
 * closed early ("ab"c) keeps the rest of the field (lenient, like csv with strict=False).
 */

export type Delimiter = "," | ";" | "\t" | "|";
export const DELIMITERS: Delimiter[] = [",", ";", "\t", "|"];

export const MAX_COLUMNS = 40;
export const MAX_CELL = 65_536;
export const MAX_HEADER = 60;

export type CsvError =
  | { reason: "unclosed_quote"; line: number }
  | { reason: "cell_too_long"; line: number }
  | { reason: "no_rows" }
  | { reason: "header_only" }
  | { reason: "too_many_columns"; columns: number }
  | { reason: "too_many_rows"; rows: number; max: number };

type Rec = { cells: string[]; line: number };

/**
 * Splits text into records. `limit` stops after that many records (sniffing). Returns the
 * records, the physical line where an unclosed quote opened (or 0), and the first record whose
 * cell exceeds the cell limit.
 */
export function readRecords(text: string, delim: string, limit = Infinity, cellLimit = MAX_CELL) {
  const records: Rec[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  let line = 1;
  let recLine = 1;
  let quoteLine = 0;
  let tooLong = 0;
  let any = false; // the current record has content (a delimiter, a char or a quote)
  const endField = () => {
    if (!tooLong && field.length > cellLimit) tooLong = recLine;
    row.push(field);
    field = "";
    fieldStart = true;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && fieldStart) {
      quoted = true;
      quoteLine = line;
      fieldStart = false;
      any = true;
      continue;
    }
    if (ch === delim) {
      endField();
      any = true;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (any || field) {
        endField();
        records.push({ cells: row, line: recLine });
        if (records.length >= limit) return { records, quoteLine: 0, tooLong };
      }
      row = [];
      field = "";
      fieldStart = true;
      any = false;
      line++;
      recLine = line;
      continue;
    }
    field += ch;
    fieldStart = false;
    any = true;
  }
  if (quoted) return { records, quoteLine, tooLong };
  if (any || field) {
    endField();
    records.push({ cells: row, line: recLine });
  }
  return { records, quoteLine: 0, tooLong };
}

/**
 * §7.3: for each candidate, parse the first 20 records and count those with the same field count
 * as the first, when that count is > 1. Highest score wins; ties go to more fields in the first
 * record, then to the order , ; tab |. No candidate with > 1 field → ",".
 */
export function sniffDelimiter(text: string): Delimiter {
  let best: { d: Delimiter; score: number; width: number } | null = null;
  for (const d of DELIMITERS) {
    const { records } = readRecords(text, d, 20, Infinity);
    const width = records[0]?.cells.length ?? 0;
    if (width <= 1) continue;
    const score = records.filter((r) => r.cells.length === width).length;
    if (!best || score > best.score || (score === best.score && width > best.width)) best = { d, score, width };
  }
  return best?.d ?? ",";
}

/** C0 control characters except tab and newline are removed from every value (§4.7 "Text"). */
const C0 = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
export const stripControls = (s: string) => s.replace(C0, "");

/** Header names: first 60 characters, blank → "Column 4", duplicates → "Labels (2)" (design). */
export function normaliseHeader(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, k) => {
    let s = stripControls(h).trim().slice(0, MAX_HEADER) || `Column ${k + 1}`;
    const low = s.toLowerCase();
    const n = (seen.get(low) ?? 0) + 1;
    seen.set(low, n);
    if (n > 1) s = `${s} (${n})`;
    return s;
  });
}

export interface ParsedCsv {
  /** Display names (cut, blank-filled, de-duplicated). */
  header: string[];
  /** Header cells as written (trimmed), for synonym matching ("Labels" twice → both "Labels"). */
  rawHeader: string[];
  /** Data rows, padded / cut to the header width, control characters stripped. */
  rows: string[][];
}

/** Parses a decoded file with a known delimiter and applies the §1.5 limits. */
export function parseCsv(text: string, delim: Delimiter, maxRows: number): { ok: true; csv: ParsedCsv } | { ok: false; error: CsvError } {
  const { records, quoteLine, tooLong } = readRecords(text, delim);
  if (quoteLine) return { ok: false, error: { reason: "unclosed_quote", line: quoteLine } };
  if (tooLong) return { ok: false, error: { reason: "cell_too_long", line: tooLong } };
  if (!records.length) return { ok: false, error: { reason: "no_rows" } };
  const head = records[0]!.cells;
  if (head.length > MAX_COLUMNS) return { ok: false, error: { reason: "too_many_columns", columns: head.length } };
  if (records.length === 1) return { ok: false, error: { reason: "header_only" } };
  const dataCount = records.length - 1;
  if (dataCount > maxRows) return { ok: false, error: { reason: "too_many_rows", rows: dataCount, max: maxRows } };
  const width = head.length;
  const rows = records.slice(1).map((r) => {
    const out: string[] = [];
    for (let k = 0; k < width; k++) out.push(stripControls(r.cells[k] ?? ""));
    return out;
  });
  return { ok: true, csv: { header: normaliseHeader(head), rawHeader: head.map((h) => stripControls(h).trim()), rows } };
}
