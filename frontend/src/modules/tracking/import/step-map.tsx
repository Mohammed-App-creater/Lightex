"use client";

import { useState } from "react";
import { Avatar, UnassignedAvatar } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/feedback";
import { PriorityIcon, StatusGlyph, glyphColor, priorityMeta } from "@/components/ui/glyphs";
import { useCustomFields } from "@/features/fields/queries";
import { useProjectMembers, useStatuses } from "@/features/projects/queries";
import type { ImportColumnMapping, ImportField, ImportJob, ImportRowPreview, ImportTaskType, ImportTimeUnit, ImportValue, Project, Status, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { shortDate } from "@/lib/utils/dates";
import { IMPORT_FIELD_LABELS, fieldOptions, fieldValue, typeOptions } from "./import-lib";
import { ArrowGlyph, Section } from "./parts";
import { useImportRows, type LocalMapping } from "./queries";

/*
 * Step 3 · Map (board 40 S3 / MOB): Fields table (+ unit select), Statuses / Types / People value
 * tables and the 5-row preview. Selects show the local value at once; tables, counts and the
 * preview follow the server's response (§1.4 step 3).
 */

const SINGLE_SKIP = new Set<ImportField>(["labels", "sourceId", "blockedBy", "blocks", "skip"]);
const touchedKey = (id: string) => `lightex-import-touched-${id}`;

function readTouched(id: string): number[] {
  try {
    const raw = sessionStorage.getItem(touchedKey(id));
    return raw ? (JSON.parse(raw) as number[]) : [];
  } catch {
    return [];
  }
}

function Select({ label, value, onChange, children, need, skip, className }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode; need?: boolean; skip?: boolean; className?: string }) {
  return (
    <span className={cn("iw-selbox", className)}>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="iw-sel" data-need={need || undefined} data-skip={skip || undefined}>
        {children}
      </select>
    </span>
  );
}

const ROW = "grid min-h-[46px] grid-cols-[minmax(0,1fr)_18px_minmax(0,1fr)] items-center gap-2.5 bg-bg px-3 py-1.5 max-[760px]:grid-cols-1 max-[760px]:gap-1.5 max-[760px]:py-2.5";
const VROW = "grid min-h-[42px] grid-cols-[minmax(0,1fr)_14px_minmax(0,1.1fr)] items-center gap-2.5 bg-bg px-3 py-[5px] max-[760px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]";
const TABLE = "flex flex-col overflow-hidden rounded-[10px] border border-line [&>*+*]:shadow-[inset_0_1px_0_var(--line)]";

export function StepMap({ job, project, me, local, update, wide }: { job: ImportJob; project: Project; me: User; local: LocalMapping; update: (m: LocalMapping) => void; wide: boolean }) {
  const perms = project.my_permissions;
  const statusesQ = useStatuses(job.projectId);
  const membersQ = useProjectMembers(job.projectId);
  const fieldsQ = useCustomFields(job.projectId);
  const [touched, setTouched] = useState<number[]>(() => readTouched(job.id));
  const columns = job.analysis?.columns ?? [];
  const validation = job.validation;
  const statuses = statusesQ.data ?? [];
  const members = (membersQ.data ?? []).map((m) => m.user);
  const canAssign = perms.includes("task.assign");
  const people = canAssign ? members : members.filter((u) => u.id === me.id);

  const counts = new Map<string, number>();
  for (const c of local.columns) if (!SINGLE_SKIP.has(c.field)) counts.set(fieldValue(c), (counts.get(fieldValue(c)) ?? 0) + 1);
  const mapped = local.columns.filter((c) => c.field !== "skip").length;

  const setColumn = (i: number, next: ImportColumnMapping) => {
    const t = touched.includes(i) ? touched : [...touched, i];
    setTouched(t);
    try {
      sessionStorage.setItem(touchedKey(job.id), JSON.stringify(t));
    } catch {
      /* private mode */
    }
    update({ ...local, columns: local.columns.map((c, k) => (k === i ? next : c)) });
  };
  const parseField = (v: string, prev: ImportColumnMapping): ImportColumnMapping => {
    if (v.startsWith("cf:")) return { field: "customField", customFieldId: v.slice(3) };
    if (v === "timeEstimate") return { field: "timeEstimate", unit: prev.unit ?? "hours" };
    return { field: v as ImportField };
  };
  const groups = fieldOptions(fieldsQ.data ?? []);
  const targetOf = <T,>(map: Record<string, T | null>, v: ImportValue) => (Object.prototype.hasOwnProperty.call(map, v.key) ? (map[v.key] ?? null) : (v.target as T | null));

  const fieldsTable = (
    <Section title="Fields" count={`${mapped}/${columns.length}`}>
      <div className={TABLE}>
        <div aria-hidden className={cn(ROW, "min-h-8 bg-raised font-mono text-[11px] font-medium uppercase tracking-[.04em] text-fg-3 max-[760px]:hidden")}>
          <span>{job.source === "jira" ? "Jira" : "CSV"} column</span>
          <span />
          <span>Lightex field</span>
        </div>
        {columns.map((col, i) => {
          const c = local.columns[i] ?? { field: "skip" as const };
          const v = fieldValue(c);
          const dup = !SINGLE_SKIP.has(c.field) && (counts.get(v) ?? 0) > 1;
          const auto = c.field !== "skip" && !touched.includes(i);
          const bareNumbers = col.inferredType === "number";
          return (
            <div key={col.index} className={cn(ROW, dup && "bg-warn-s/50")}>
              <span className="flex min-w-0 flex-col gap-[3px]">
                <b className={cn("truncate font-medium", c.field === "skip" && "text-fg-3")}>{col.name}</b>
                <span className="truncate font-mono text-[11px] leading-[1.2] text-fg-3">{col.samples[0] ?? "empty"}</span>
              </span>
              <ArrowGlyph className="text-fg-3 max-[760px]:hidden" />
              <span className="iw-selw">
                <Select label={`Map ${col.name} to`} value={v} onChange={(x) => setColumn(i, parseField(x, c))} need={dup} skip={c.field === "skip"}>
                  {groups.map((g, gi) =>
                    g.label ? (
                      <optgroup key={gi} label={g.label}>
                        {g.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    ) : (
                      g.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))
                    ),
                  )}
                  {c.field === "customField" && !(fieldsQ.data ?? []).some((f) => f.id === c.customFieldId) && <option value={v}>Deleted field</option>}
                </Select>
                {c.field === "timeEstimate" && bareNumbers && (
                  <Select label={`Unit for ${col.name}`} value={c.unit ?? "hours"} onChange={(u) => setColumn(i, { ...c, unit: u as ImportTimeUnit })} className="max-w-[104px]">
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="seconds">seconds</option>
                  </Select>
                )}
                {auto && (
                  <span title="Matched by name" className="flex-none rounded-[4px] bg-accent-s px-[5px] py-[3px] font-mono text-[10px] font-medium leading-none text-accent-t">
                    auto
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );

  const statusRows = validation?.values.statuses ?? [];
  const typeRows = validation?.values.types ?? [];
  const peopleRows = validation?.values.people ?? [];
  const hasStatusCol = local.columns.some((c) => c.field === "status");
  const hasTypeCol = local.columns.some((c) => c.field === "type");
  const statusDone = statusRows.filter((v) => targetOf(local.statuses, v)).length;
  const typeDone = typeRows.filter((v) => targetOf(local.types, v)).length;

  const valueTables = (
    <div className="flex min-w-0 flex-col gap-5">
      {hasStatusCol && statusRows.length > 0 && (
        <Section title="Statuses" count={`${statusDone}/${statusRows.length}`}>
          <div className={TABLE}>
            {statusRows.map((v) => {
              const target = targetOf(local.statuses, v);
              const s = statuses.find((x) => x.id === target);
              return (
                <div key={v.key} className={VROW}>
                  <ValueName value={v.value} count={v.count} />
                  <ArrowGlyph size={14} className="text-fg-3 max-[760px]:hidden" />
                  <span className="iw-selw">
                    <StatusGlyph kind={s?.glyph ?? "backlog"} color={s ? (s.color ?? glyphColor[s.glyph]) : "var(--warn)"} className="size-3.5 flex-none" />
                    <Select label={`Map status ${v.value} to`} value={target ?? ""} need={!target} onChange={(x) => update({ ...local, statuses: { ...local.statuses, [v.key]: x || null } })}>
                      <option value="">Choose…</option>
                      {statuses.map((st: Status) => (
                        <option key={st.id} value={st.id}>
                          {st.name}
                        </option>
                      ))}
                    </Select>
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
      {hasTypeCol && typeRows.length > 0 && (
        <Section title="Types" count={`${typeDone}/${typeRows.length}`}>
          <div className={TABLE}>
            {typeRows.map((v) => {
              const target = targetOf(local.types, v);
              return (
                <div key={v.key} className={VROW}>
                  <ValueName value={v.value} count={v.count} />
                  <ArrowGlyph size={14} className="text-fg-3 max-[760px]:hidden" />
                  <span className="iw-selw">
                    <Select label={`Map type ${v.value} to`} value={target ?? ""} need={!target} onChange={(x) => update({ ...local, types: { ...local.types, [v.key]: (x || null) as ImportTaskType | null } })}>
                      <option value="">Choose…</option>
                      {typeOptions(perms).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
      {peopleRows.length > 0 && local.columns.some((c) => c.field === "assignee" || c.field === "customField") && (
        <Section title="People" count={peopleRows.length}>
          <div className={TABLE}>
            {peopleRows.map((v) => {
              const target = targetOf(local.people, v);
              const u = members.find((m) => m.id === target);
              return (
                <div key={v.key} className={VROW}>
                  <ValueName value={v.value} count={v.count} />
                  <ArrowGlyph size={14} className="text-fg-3 max-[760px]:hidden" />
                  <span className="iw-selw">
                    {u ? <Avatar name={u.name} hue={u.hue} size={20} ring={false} decorative /> : <UnassignedAvatar size={20} label="" />}
                    <Select label={`Map person ${v.value} to`} value={target ?? ""} skip={!target} onChange={(x) => update({ ...local, people: { ...local.people, [v.key]: x || null } })}>
                      {people.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id === me.id && !canAssign ? "You" : m.name}
                        </option>
                      ))}
                      {u && !people.some((m) => m.id === u.id) && <option value={u.id}>{u.name}</option>}
                      <option value="">Leave unassigned</option>
                    </Select>
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );

  return (
    <>
      <div className={cn("grid grid-cols-1 gap-5", wide && "grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-7")}>
        {fieldsTable}
        {valueTables}
      </div>
      <Preview job={job} local={local} statuses={statuses} members={members} />
    </>
  );
}

function ValueName({ value, count }: { value: string; count: number }) {
  return (
    <span className="flex min-w-0 items-center gap-2 font-medium">
      <span className="truncate">{value}</span>
      <span className="font-mono text-[11px] text-fg-3">{count}</span>
    </span>
  );
}

const PREVIEW_FIELDS: ImportField[] = ["title", "status", "assignee", "priority", "estimate", "dueDate", "labels"];

function Preview({ job, local, statuses, members }: { job: ImportJob; local: LocalMapping; statuses: Status[]; members: User[] }) {
  const rowsQ = useImportRows(job);
  const fields = PREVIEW_FIELDS.filter((f) => local.columns.some((c) => c.field === f));
  const miss = "italic text-danger";
  const mute = "text-fg-3";
  const issueOf = (r: ImportRowPreview, f: ImportField) => r.issues.find((i) => i.field === f && i.severity === "skip");
  const cell = (r: ImportRowPreview, f: ImportField) => {
    const v = r.values;
    switch (f) {
      case "title":
        return v.title ? <span>{v.title}</span> : <span className={miss}>Missing title</span>;
      case "status": {
        const s = statuses.find((x) => x.id === v.statusId);
        return s ? (
          <span className="inline-flex items-center gap-1.5">
            <StatusGlyph kind={s.glyph} color={s.color ?? glyphColor[s.glyph]} className="size-3" />
            {s.name}
          </span>
        ) : (
          <span className={miss}>Unmapped</span>
        );
      }
      case "assignee": {
        const u = members.find((m) => m.id === v.assigneeId);
        return u ? (
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={u.name} hue={u.hue} size={20} ring={false} decorative />
            {u.name}
          </span>
        ) : (
          <span className={mute}>Unassigned</span>
        );
      }
      case "priority":
        return v.priority ? (
          <span className="inline-flex items-center gap-1.5">
            <PriorityIcon level={v.priority} bars />
            {priorityMeta[v.priority].label}
          </span>
        ) : (
          <span className={mute}>—</span>
        );
      case "estimate": {
        const bad = issueOf(r, "estimate");
        if (bad) return <span className={miss}>{bad.value}</span>;
        return v.estimate !== null ? <span className="font-mono">{v.estimate} pts</span> : <span className={mute}>—</span>;
      }
      case "dueDate": {
        const bad = issueOf(r, "dueDate");
        if (bad) return <span className={miss}>{bad.value}</span>;
        return v.dueDate ? <span>{shortDate(v.dueDate)}</span> : <span className={mute}>—</span>;
      }
      case "labels":
        return v.labels.length ? (
          <span className="inline-flex items-center gap-1">
            {v.labels.slice(0, 3).map((l) => (
              <span key={l} className="inline-flex h-5 items-center rounded-[5px] border border-line bg-raised px-1.5 text-[11.5px]">
                {l}
              </span>
            ))}
          </span>
        ) : (
          <span className={mute}>—</span>
        );
      default:
        return null;
    }
  };
  return (
    <Section title="Preview" meta="first 5 rows">
      <div className="overflow-auto rounded-[10px] border border-line">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th className="sticky top-0 w-9 bg-raised px-2.5 py-2 text-left font-mono text-[11px] font-medium uppercase tracking-[.04em] text-fg-3">Row</th>
              {fields.map((f) => (
                <th key={f} className="sticky top-0 whitespace-nowrap bg-raised px-2.5 py-2 text-left font-mono text-[11px] font-medium uppercase tracking-[.04em] text-fg-3">
                  {IMPORT_FIELD_LABELS[f]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowsQ.isPending
              ? [0, 1, 2].map((i) => (
                  <tr key={i}>
                    <td colSpan={fields.length + 1} className="border-t border-line px-2.5 py-2">
                      <Skeleton className="h-3.5 w-full" />
                    </td>
                  </tr>
                ))
              : (rowsQ.data?.data ?? []).map((r) => {
                  const skip = r.issues.find((i) => i.severity === "skip");
                  return (
                    <tr key={r.row} title={skip ? `Will skip: ${skip.reason}` : undefined} className={cn(skip && "[&>td]:bg-danger-s/40")}>
                      <td className="border-t border-line px-2.5 py-2 font-mono text-[11px] text-fg-3">{r.row}</td>
                      {fields.map((f) => (
                        <td key={f} className="max-w-[260px] overflow-hidden text-ellipsis whitespace-nowrap border-t border-line px-2.5 py-2 align-middle">
                          {cell(r, f)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
