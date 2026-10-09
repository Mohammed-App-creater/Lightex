import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ImportTimeUnit, StatusGlyph } from "@/lib/api/types";
import { dateOrderOf, parseDate, parseDurationCell, parseNumber } from "./convert";
import { parseCsv, sniffDelimiter, type Delimiter } from "./csv";
import { decodeBytes } from "./decode";
import { sampleText } from "./fixtures/sample";
import vectors from "./fixtures/import_vectors.json";
import { matchPerson, matchPriority, matchStatus, matchType } from "./match";
import { planImport, type ParsedFile, type PlanProject } from "./plan";
import { detectPreset, fieldForHeader, normHeader, suggestColumns } from "./presets";
import { buildReport, csvSafe } from "./report";

/* Board 40 mock parser and planner against the shared vectors (fixtures/import_vectors.json). */

const hex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
const enc = (s: string) => new TextEncoder().encode(s);

function parse(text: string, maxRows = 1000) {
  const d = sniffDelimiter(text);
  const r = parseCsv(text, d, maxRows);
  if (!r.ok) throw new Error(`parse failed: ${r.error.reason}`);
  return { ...r.csv, delimiter: d } as ParsedFile;
}

describe("decode (vectors)", () => {
  for (const v of vectors.decode) {
    it(v.name, () => {
      const r = decodeBytes(hex(v.hex));
      if ("error" in v) expect(r).toEqual({ ok: false, reason: v.error });
      else expect(r).toEqual({ ok: true, encoding: v.encoding, text: v.text });
    });
  }
});

describe("delimiter sniffing (vectors)", () => {
  for (const v of vectors.delimiter) it(v.name, () => expect(sniffDelimiter(v.text)).toBe(v.delimiter));
});

describe("CSV parsing (vectors)", () => {
  for (const v of vectors.parse) {
    it(v.name, () => {
      const r = parseCsv(v.text, v.delimiter as Delimiter, 1000);
      if ("error" in v) expect(r).toEqual({ ok: false, error: v.error });
      else {
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.csv.header).toEqual(v.header);
          expect(r.csv.rows).toEqual(v.rows);
        }
      }
    });
  }

  it("enforces the row, column and cell limits", () => {
    const rows = Array.from({ length: 1240 }, (_, i) => `Task ${i}`).join("\n");
    expect(parseCsv(`Title\n${rows}\n`, ",", 1000)).toEqual({ ok: false, error: { reason: "too_many_rows", rows: 1240, max: 1000 } });
    const wide = Array.from({ length: 45 }, (_, i) => `C${i}`).join(",");
    expect(parseCsv(`${wide}\nx\n`, ",", 1000)).toEqual({ ok: false, error: { reason: "too_many_columns", columns: 45 } });
    const long = "x".repeat(65_537);
    expect(parseCsv(`Title\nok\n${long}\n`, ",", 1000)).toEqual({ ok: false, error: { reason: "cell_too_long", line: 3 } });
  });

  it("reads the Windows-1252, BOM, semicolon and tab variants of the Jira fixture identically", () => {
    const jira = readFileSync(join(__dirname, "fixtures", "jira-export.csv"), "utf8");
    const base = parse(jira);
    const cp1252Bytes = new Uint8Array([...jira.replace("Cart drawer,", "Café drawer,")].map((c) => (c === "é" ? 0xe9 : c.charCodeAt(0))));
    const cp = decodeBytes(cp1252Bytes);
    expect(cp).toMatchObject({ ok: true, encoding: "windows-1252" });
    if (cp.ok) expect(parse(cp.text).rows[1]![2]).toBe("Café drawer");

    const bom = decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...enc(jira)]));
    expect(bom.ok && parse(bom.text).rows).toEqual(base.rows);

    const semi = jira.split("\n").map((l) => l.replace(/,/g, ";")).join("\r\n");
    const semiParsed = parse(semi);
    expect(semiParsed.delimiter).toBe(";");
    expect(semiParsed.rows).toEqual(base.rows);

    const tabText = jira.replace(/,/g, "\t");
    const utf16 = new Uint8Array(2 + tabText.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let i = 0; i < tabText.length; i++) {
      utf16[2 + i * 2] = tabText.charCodeAt(i) & 0xff;
      utf16[3 + i * 2] = tabText.charCodeAt(i) >> 8;
    }
    const u = decodeBytes(utf16);
    expect(u).toMatchObject({ ok: true, encoding: "utf-16" });
    if (u.ok) {
      const p = parse(u.text);
      expect(p.delimiter).toBe("\t");
      expect(p.rows).toEqual(base.rows);
    }
  });
});

describe("headers, presets and suggestions (vectors)", () => {
  for (const v of vectors.headers) {
    it(`${v.header} → ${v.field ?? "nothing"}`, () => {
      expect(normHeader(v.header)).toBe(v.normalised);
      expect(fieldForHeader(v.header)).toBe(v.field);
    });
  }
  for (const v of vectors.presets) it(`preset ${v.preset} (${v.headers.join(", ")})`, () => expect(detectPreset(v.headers)).toBe(v.preset));
  for (const v of vectors.suggest) it(`suggests: ${v.name}`, () => expect(suggestColumns(v.headers, v.preset as never, [])).toEqual(v.columns));

  it("maps a header equal to a custom field's name", () => {
    expect(suggestColumns(["Title", "Browser", "browser"], "generic", [{ id: "cf1", name: "Browser" }])).toEqual([
      { field: "title" },
      { field: "customField", customFieldId: "cf1" },
      { field: "skip" },
    ]);
  });
});

describe("value matching (vectors)", () => {
  const statuses = vectors.statuses.project.map((s) => ({ ...s, glyph: s.glyph as StatusGlyph }));
  for (const c of vectors.statuses.cases) it(`status ${c.value} → ${c.target}`, () => expect(matchStatus(c.value, statuses)).toBe(c.target));
  for (const c of vectors.types) it(`type ${c.value} (epic ${c.canEpic}) → ${c.type}`, () => expect(matchType(c.value, c.canEpic)).toBe(c.type));
  for (const c of vectors.people.cases) {
    it(`person "${c.value}" → ${c.target}`, () => expect(matchPerson(c.value, vectors.people.members)).toEqual({ target: c.target, matchedBy: c.matchedBy }));
  }
  for (const c of vectors.priorities) it(`priority "${c.value}" → ${c.priority}`, () => expect(matchPriority(c.value)).toBe(c.priority));
});

describe("conversion (vectors)", () => {
  for (const c of vectors.dates) it(`date "${c.value}" (${c.order}) → ${c.date}`, () => expect(parseDate(c.value, c.order as never)).toBe(c.date));
  for (const c of vectors.dateOrder) it(`date order of ${c.values.join(" | ")}`, () => expect(dateOrderOf(c.values)).toBe(c.order));
  for (const c of vectors.numbers) it(`number "${c.value}" (${c.delimiter})`, () => expect(parseNumber(c.value, c.delimiter)).toBe(c.number));
  for (const c of vectors.durations) {
    it(`duration "${c.value}" (${c.unit})`, () => expect(parseDurationCell(c.value, c.unit as ImportTimeUnit)).toBe(c.minutes));
  }
});

describe("formula-safe CSV (vectors)", () => {
  for (const c of vectors.csvSafe) it(`csvSafe ${JSON.stringify(c.value)}`, () => expect(csvSafe(c.value)).toBe(c.cell));

  it("builds the report: BOM-less body, CRLF, quoted, formula-safe headers and cells, skips first", () => {
    const csv = buildReport(
      ["Title", "=Due"],
      [
        ["=cmd|' /C calc'!A0", "next week"],
        ["Ok", "2026-10-08"],
      ],
      [
        { row: 3, severity: "warning", field: "sprint", reason: "No sprint named “S9” · added to the backlog", value: "S9" },
        { row: 2, severity: "skip", field: "dueDate", reason: "Invalid due date", value: "next week" },
      ],
    );
    expect(csv.split("\r\n")).toEqual([
      `"Row","Outcome","Reason","Value","Title","'=Due"`,
      `"2","Skipped","Invalid due date","next week","'=cmd|' /C calc'!A0","next week"`,
      `"3","Imported with changes","No sprint named “S9” · added to the backlog","S9","Ok","2026-10-08"`,
      "",
    ]);
  });
});

/* ───────── planning against PRJ-like project state ───────── */

const ST = vectors.statuses.project.map((s) => ({ ...s, glyph: s.glyph as StatusGlyph }));
function project(over: Partial<PlanProject> = {}): PlanProject {
  return {
    key: "PRJ",
    taskSeq: 60,
    statuses: ST,
    defaultStatusId: "st_todo",
    members: [
      { id: "u_alex", name: "Alex Kim", email: "alex@team.dev" },
      { id: "u_jordan", name: "Jordan Lee", email: "jordan@team.dev" },
      { id: "u_sam", name: "Sam Patel", email: "sam@team.dev" },
      { id: "u_riley", name: "Riley Chen", email: "riley@team.dev" },
    ],
    importerId: "u_alex",
    perms: ["project.view", "task.create", "task.assign", "epic.manage", "field.manage", "project.import"],
    labels: ["frontend", "backend", "bug", "perf", "infra", "design"].map((n) => ({ id: `lb_${n}`, name: n })),
    epics: [],
    sprints: [{ id: "sp_14", name: "Sprint 14" }],
    customFields: [],
    tasks: [],
    ...over,
  };
}
const noUser = { statuses: {}, types: {}, people: {} };

describe("planning the design's 48-row sample", () => {
  const file = parse(sampleText());
  const columns = suggestColumns(file.rawHeader, "generic", []);

  it("auto-maps all 8 columns, statuses and people; blocked is the one unmapped status", () => {
    const { validation, mapping } = planImport(file, columns, noUser, project());
    expect(mapping.columns.map((c) => c.field)).toEqual(["title", "description", "status", "assignee", "priority", "estimate", "dueDate", "labels"]);
    expect(validation.values.statuses.map((v) => [v.key, v.target, v.auto])).toEqual([
      ["todo", "st_todo", true],
      ["in progress", "st_progress", true],
      ["done", "st_done", true],
      ["review", "st_review", true],
      ["blocked", null, false],
    ]);
    expect(validation.values.people.map((v) => [v.value, v.target, v.matchedBy])).toEqual([
      ["Alex Kim", "u_alex", "name"],
      ["Riley Chen", "u_riley", "name"],
      ["Sam Patel", "u_sam", "name"],
      ["Chris Ortiz", null, null],
    ]);
    expect(validation.blockers).toEqual([{ code: "status_unmapped", message: "Map 1 more status", field: "status" }]);
    expect(validation.counts).toEqual({ rows: 48, tasks: 44, epics: 0, skipped: 4, warnings: 0, statuses: 5, people: 3 });
    expect(validation.creates).toEqual({ labels: ["api"], epics: [], options: [] });
    expect(validation.keyRange).toEqual({ first: "PRJ-61", last: "PRJ-104" });
  });

  it("validates rows: 44 imported, 4 skipped with the design's reasons", () => {
    const { validation, rows } = planImport(file, columns, { ...noUser, statuses: { blocked: "st_todo" } }, project());
    expect(validation.ready).toBe(true);
    expect(validation.counts.tasks).toBe(44);
    expect(validation.counts.skipped).toBe(4);
    expect(rows.filter((r) => r.outcome === "skipped").map((r) => [r.row, r.issues[0]!.reason, r.issues[0]!.value])).toEqual([
      [8, "Missing title", ""],
      [20, "Invalid due date", "next week"],
      [27, "Estimate is not a number", "XL"],
      [42, "Missing title", ""],
    ]);
    expect(validation.skipReasons).toEqual([
      { reason: "Missing title", count: 2 },
      { reason: "Invalid due date", count: 1 },
      { reason: "Estimate is not a number", count: 1 },
    ]);
    const first = rows[0]!;
    expect(first).toMatchObject({ row: 2, outcome: "task", key: "PRJ-61" });
    expect(first.values).toMatchObject({ title: "Fix login redirect loop", statusId: "st_todo", assigneeId: "u_alex", priority: 3, estimate: 3, dueDate: "2026-10-08", labels: ["frontend"] });
    expect(rows[2]!.values.labels).toEqual(["frontend", "perf"]);
  });

  it("gates people on task.assign: only the importer stays suggested", () => {
    const { validation } = planImport(file, columns, noUser, project({ perms: ["task.create", "project.import"], importerId: "u_sam" }));
    expect(validation.values.people.map((v) => v.target)).toEqual([null, null, "u_sam", null]);
  });

  it("orders blockers: title, duplicate, statuses", () => {
    const cols = columns.map((c) => (c.field === "title" ? { field: "skip" as const } : c.field === "priority" ? { field: "status" as const } : c));
    const { validation } = planImport(file, cols, noUser, project());
    expect(validation.blockers.map((b) => b.message).slice(0, 2)).toEqual(["Map a column to Title", "Two columns map to Status"]);
  });
});

describe("planning the 6-row Jira export", () => {
  const jira = readFileSync(join(__dirname, "fixtures", "jira-export.csv"), "utf8");
  const file = parse(jira);
  const preset = detectPreset(file.rawHeader);
  const columns = suggestColumns(file.rawHeader, preset, []);
  const plan = planImport(file, columns, noUser, project());
  const row = (n: number) => plan.rows.find((r) => r.row === n + 1)!;

  it("detects the preset and the multi-column fields", () => {
    expect(preset).toBe("jira");
    expect(columns.filter((c) => c.field === "sourceId")).toHaveLength(2);
    expect(columns.filter((c) => c.field === "labels")).toHaveLength(2);
  });

  it("plans the epic, tasks, sub-task, dependency, warnings and the skip", () => {
    expect(plan.validation.blockers).toEqual([]);
    expect(row(1)).toMatchObject({ outcome: "epic", values: { title: "Checkout redesign", startDate: "2026-10-01", dueDate: "2026-10-30" } });
    expect(row(2)).toMatchObject({ outcome: "task", epicRow: 2, values: { estimate: 3, timeEstimateMinutes: 480, startDate: "2026-10-05", dueDate: "2026-10-14", sprintId: "sp_14", labels: ["frontend", "ux"], assigneeId: "u_jordan" } });
    expect(row(3)).toMatchObject({ outcome: "task", parent: { row: 3 }, epicRow: 2, values: { assigneeId: "u_jordan", sprintId: "sp_14" } });
    expect(plan.validation.values.people.find((p) => p.value === "jordan.lee")).toMatchObject({ target: "u_jordan", matchedBy: "initial" });
    expect(row(4)).toMatchObject({ outcome: "task", epicRow: 2, values: { statusId: "st_done", priority: 4, assigneeId: "u_sam" } });
    expect(plan.validation.values.people.find((p) => p.value === "Sam P.")).toMatchObject({ matchedBy: "initial" });
    expect(row(5)).toMatchObject({ outcome: "task", values: { statusId: "st_review", assigneeId: null, sprintId: null } });
    expect(row(5).blockedBy).toEqual([{ ref: "WEB-4", row: 5 }]);
    expect(row(5).issues).toEqual([{ severity: "warning", field: "sprint", reason: "No sprint named “Sprint 99” · added to the backlog", value: "Sprint 99" }]);
    expect(row(6)).toMatchObject({ outcome: "skipped", issues: [{ reason: "Missing title" }] });
    expect(plan.validation.counts).toMatchObject({ tasks: 4, epics: 1, skipped: 1, warnings: 1 });
    expect(plan.validation.creates).toEqual({ labels: ["ux", "api"], epics: ["Checkout redesign"], options: [] });
    expect(plan.validation.keyRange).toEqual({ first: "PRJ-61", last: "PRJ-64" });
  });

  it("without epic.manage the Epic type is unmapped (a blocker)", () => {
    const p = planImport(file, columns, noUser, project({ perms: ["task.create", "task.assign", "project.import"] }));
    expect(p.validation.blockers[0]).toEqual({ code: "type_unmapped", message: "Map 1 more type", field: "type" });
  });
});
