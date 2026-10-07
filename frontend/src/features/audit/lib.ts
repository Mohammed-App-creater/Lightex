import type { AuditChange, AuditEntry } from "@/lib/api/types";
import { auditActionKind, auditEntity, type AuditActionKind, type AuditEntityType } from "@/lib/audit";

/* Pure helpers for the audit log (board 31): labels, icons, time formatting, word diff, export. */

/** 16-viewBox stroke paths from the board. */
export const AUDIT_ICON = {
  plus: "M8 3v10M3 8h10",
  pencil: "M10.5 2.8l2.7 2.7-7.4 7.4H3.1v-2.7z",
  circle: "M8 2.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 5.5a2.5 2.5 0 110 5",
  user: "M8 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8",
  bubble: "M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5",
  shield: "M8 1.8l5 2v4c0 3-2.2 5.3-5 6.4-2.8-1.1-5-3.4-5-6.4v-4z",
  mail: "M2.5 4h11v8.5h-11zM2.5 4.5L8 9l5.5-4.5",
  bolt: "M9 2L3.5 9H8l-1 5 5.5-7H8z",
  task: "M8 2.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM5.6 8.1l1.7 1.7 3.2-3.4",
  project: "M2.5 4.5h4l1.2 1.5h5.8v7h-11z",
  sprint: "M12.5 6.5A4.8 4.8 0 004 5M3.5 9.5A4.8 4.8 0 0012 11M3.8 2.8v2.4h2.4M12.2 13.2v-2.4H9.8",
  view: "M2.5 3.5h11l-4.2 5v4l-2.6 1v-5z",
  key: "M10 2.5a3.5 3.5 0 11-3.2 4.9L2.5 11.7V13.5h2v-1.5h1.5v-1.5l1.4-1.4A3.5 3.5 0 0110 2.5z",
  building: "M3 13.5V3.5h6.5v10M9.5 6.5h3.5v7M5 6h2.5M5 8.5h2.5M5 11h2.5M2 13.5h12",
  any: "M2.5 4h11M2.5 8h11M2.5 12h7",
  globe: "M8 2.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10.1 5.7 8S6.4 4.1 8 2.5z",
  code: "M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5",
  file: "M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3",
} as const;

export const ACTION_META: Record<AuditActionKind, { label: string; color: string; icon: string }> = {
  created: { label: "Created", color: "var(--ok)", icon: AUDIT_ICON.plus },
  updated: { label: "Updated", color: "var(--accent-t)", icon: AUDIT_ICON.pencil },
  status: { label: "Status changed", color: "var(--warn)", icon: AUDIT_ICON.circle },
  assigned: { label: "Assigned", color: "var(--info)", icon: AUDIT_ICON.user },
  commented: { label: "Commented", color: "var(--text-2)", icon: AUDIT_ICON.bubble },
  deleted: { label: "Deleted", color: "var(--danger)", icon: AUDIT_ICON.trash },
  role: { label: "Role changed", color: "var(--orange)", icon: AUDIT_ICON.shield },
  invited: { label: "Invited", color: "var(--low)", icon: AUDIT_ICON.mail },
};

export const ENTITY_META: Record<AuditEntityType, { label: string; icon: string }> = {
  task: { label: "Task", icon: AUDIT_ICON.task },
  project: { label: "Project", icon: AUDIT_ICON.project },
  sprint: { label: "Sprint", icon: AUDIT_ICON.sprint },
  comment: { label: "Comment", icon: AUDIT_ICON.bubble },
  member: { label: "Member", icon: AUDIT_ICON.user },
  view: { label: "View", icon: AUDIT_ICON.view },
  role: { label: "Role", icon: AUDIT_ICON.key },
  workspace: { label: "Workspace", icon: AUDIT_ICON.building },
};

export function describe(e: AuditEntry) {
  return { kind: auditActionKind(e), entity: auditEntity(e) };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** Table cell "Oct 7 14:32" (UTC) and full "2026-10-07 14:32:05 UTC" for the title / export. */
export function auditTime(iso: string) {
  const d = new Date(iso);
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return {
    cell: `${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${hm}`,
    full: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${hm}:${p2(d.getUTCSeconds())} UTC`,
  };
}

export type DiffSeg = { text: string; op: "eq" | "del" | "ins" };

/** Word-level LCS diff for long text fields (title, description, comment edits). */
export function wordDiff(before: string, after: string): DiffSeg[] {
  const A = before.split(/\s+/).filter(Boolean);
  const B = after.split(/\s+/).filter(Boolean);
  const n = A.length;
  const m = B.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i]![j] = A[i] === B[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const ops: [DiffSeg["op"], string][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push(["eq", A[i++]!]);
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) ops.push(["del", A[i++]!]);
    else ops.push(["ins", B[j++]!]);
  }
  while (i < n) ops.push(["del", A[i++]!]);
  while (j < m) ops.push(["ins", B[j++]!]);
  const segs: { op: DiffSeg["op"]; words: string[] }[] = [];
  for (const [op, w] of ops) {
    const last = segs[segs.length - 1];
    if (last && last.op === op) last.words.push(w);
    else segs.push({ op, words: [w] });
  }
  return segs.map((s, k) => ({ op: s.op, text: s.words.join(" ") + (k < segs.length - 1 ? " " : "") }));
}

/** A change renders as a word diff when both sides are non-empty text. */
export const isWordDiff = (c: AuditChange) =>
  c.kind === "text" && typeof c.before === "string" && typeof c.after === "string" && !!c.before && !!c.after;

/* ───────── export ───────── */

export type ExportFormat = "csv" | "json";

const csvCell = (x: unknown) => `"${String(x ?? "").replace(/"/g, '""')}"`;

export function toCsv(rows: AuditEntry[], actorName: (e: AuditEntry) => string) {
  const head = ["time", "actor", "action", "entity_type", "entity", "source", "request_id", "changes"];
  const lines = rows.map((e) => {
    const { kind, entity } = describe(e);
    const changes = (e.changes ?? []).map((c) => `${c.field}: ${c.before ?? "—"} → ${c.after ?? "—"}`).join("; ");
    return [
      auditTime(e.createdAt).full,
      actorName(e),
      ACTION_META[kind].label,
      entity,
      `${e.entityKey ? `${e.entityKey} ` : ""}${e.target}`,
      e.source ?? "web",
      e.requestId ?? "",
      changes,
    ]
      .map(csvCell)
      .join(",");
  });
  return [head.join(","), ...lines].join("\n");
}

export function toJson(rows: AuditEntry[], actorName: (e: AuditEntry) => string) {
  return JSON.stringify(
    rows.map((e) => {
      const { kind, entity } = describe(e);
      return {
        time: e.createdAt,
        actor: actorName(e),
        actor_id: e.actorId,
        action: kind,
        raw_action: e.action,
        entity_type: entity,
        entity: e.target,
        key: e.entityKey ?? null,
        source: e.source ?? "web",
        request_id: e.requestId ?? null,
        changes: (e.changes ?? []).map((c) => ({ field: c.field, before: c.before, after: c.after })),
      };
    }),
    null,
    1,
  );
}

export function exportFileName(fmt: ExportFormat, now = new Date()) {
  return `audit-log-${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}.${fmt}`;
}
