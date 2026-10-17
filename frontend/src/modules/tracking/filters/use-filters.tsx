"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { replaceUrl } from "@/lib/routes";
import { useCallback, useMemo, type ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { PriorityIcon, StatusGlyph, priorityMeta, type PriorityLevel } from "@/components/ui/glyphs";
import { useMe } from "@/features/auth/session";
import { epicSwatch } from "@/features/epics/epic-model";
import { useCustomFields } from "@/features/fields/queries";
import { useEpics, useLabels, useMilestones, useProjectMembers, useSprints, useStatuses } from "@/features/projects/queries";
import type { FilterField, FilterRule } from "@/lib/api/types";
import { shortDate, todayISO } from "@/lib/utils/dates";
import { cfFieldId, fieldLabel, isCfField, OP_LABEL, parseRules, withRules, type MatchCtx } from "./filter-model";

/* React glue for the shared filter model: URL state + value options for one project. */

/** Filters live in the URL (?f=…), so a filtered board or list is linkable. */
export function useUrlFilters() {
  const search = useSearchParams();
  const pathname = usePathname();
  const qs = search.toString();
  const rules = useMemo(() => parseRules(new URLSearchParams(qs)), [qs]);
  const viewId = search.get("view");
  const setRules = useCallback(
    (next: FilterRule[], nextView: string | null = null) => replaceUrl(`${pathname}${withRules(qs, next, nextView)}`),
    [pathname, qs],
  );
  return { rules, setRules, viewId };
}

export type ValueOption = { id: string; label: string; meta?: string; icon?: ReactNode };

export function useFilterOptions(projectId: string) {
  const me = useMe();
  const { data: statuses = [] } = useStatuses(projectId);
  const { data: members = [] } = useProjectMembers(projectId);
  const { data: labels = [] } = useLabels(projectId);
  const { data: sprints = [] } = useSprints(projectId);
  const { data: epics = [] } = useEpics(projectId);
  const { data: milestones = [] } = useMilestones(projectId);
  const fieldsQ = useCustomFields(projectId);
  const fields = useMemo(() => fieldsQ.data ?? [], [fieldsQ.data]);
  const fieldsLoaded = fieldsQ.isSuccess;
  const active = sprints.find((s) => s.state === "active");

  // Board 39: with the definitions loaded, rules on deleted custom fields are ignored.
  const ctx: MatchCtx = useMemo(
    () => ({ meId: me.id, today: todayISO(), sprintEnd: active?.endDate ?? null, fields: fieldsLoaded ? fields : undefined }),
    [me.id, active?.endDate, fieldsLoaded, fields],
  );

  const people = useCallback(
    (): ValueOption[] => [
      { id: "me", label: "Me", meta: me.name.split(" ")[0], icon: <Avatar name={me.name} hue={me.hue} size={18} decorative /> },
      ...members
        .filter((m) => m.userId !== me.id)
        .map((m) => ({ id: m.userId, label: m.user.name, icon: <Avatar name={m.user.name} hue={m.user.hue} size={18} decorative /> })),
    ],
    [me, members],
  );

  const options = useCallback(
    (field: FilterField): ValueOption[] => {
      if (field === "blocked") return [{ id: "true", label: "Yes" }, { id: "false", label: "No" }];
      if (isCfField(field)) {
        const def = fields.find((f) => f.id === cfFieldId(field));
        if (!def) return [];
        if (def.type === "select") return def.options.map((o) => ({ id: o.id, label: o.name, icon: <span aria-hidden className="size-[7px] rounded-full" style={{ background: o.color }} /> }));
        if (def.type === "user") return people();
        if (def.type === "date") {
          const out: ValueOption[] = [{ id: "today", label: "Today", meta: shortDate(ctx.today) }, { id: "tomorrow", label: "Tomorrow" }, { id: "week", label: "In 7 days" }];
          if (active) out.push({ id: "sprint", label: "Sprint end", meta: shortDate(active.endDate) });
          return out;
        }
        return [];
      }
      switch (field) {
        case "status":
          return statuses.map((s) => ({ id: s.id, label: s.name, icon: <StatusGlyph kind={s.glyph} /> }));
        case "priority":
          return ([4, 3, 2, 1] as PriorityLevel[]).map((p) => ({ id: String(p), label: priorityMeta[p].label, icon: <PriorityIcon level={p} bars /> }));
        case "assignee":
          return people();
        case "label":
          return labels.map((l) => ({ id: l.id, label: l.name, icon: <span aria-hidden className="size-[7px] rounded-full" style={{ background: l.color }} /> }));
        case "sprint":
          return [...sprints]
            .sort((a, b) => b.number - a.number)
            .map((s) => ({ id: s.id, label: s.name, meta: s.state === "active" ? "Active" : s.state === "planned" ? "Planned" : shortDate(s.endDate) }));
        case "epic":
          return epics.map((e) => ({ id: e.id, label: e.name, icon: <span aria-hidden className="size-2 rounded-[3px]" style={{ background: epicSwatch(e.hue) }} /> }));
        case "due": {
          const out: ValueOption[] = [
            { id: "today", label: "Today", meta: shortDate(ctx.today) },
            { id: "tomorrow", label: "Tomorrow" },
            { id: "week", label: "In 7 days" },
          ];
          if (active) out.push({ id: "sprint", label: "Sprint end", meta: shortDate(active.endDate) });
          milestones
            .filter((m) => !m.completedAt)
            .slice(0, 4)
            .forEach((m) => out.push({ id: m.dueDate, label: m.name, meta: shortDate(m.dueDate) }));
          return out;
        }
      }
    },
    [statuses, labels, sprints, epics, milestones, ctx.today, active, fields, people],
  );

  const valueLabel = useCallback(
    (field: FilterField, v: string) => {
      if (field === "blocked") return v === "true" ? "Yes" : "No";
      if (isCfField(field)) {
        const def = fields.find((f) => f.id === cfFieldId(field));
        if (def?.type === "number") return Number(v).toLocaleString("en-US");
        if (def?.type === "date" || /^\d{4}-/.test(v)) {
          const tok: Record<string, string> = { today: "Today", tomorrow: "Tomorrow", week: "In 7 days", sprint: "Sprint end" };
          return tok[v] ?? shortDate(v);
        }
        if (def?.type === "user") return v === "me" ? "Me" : (members.find((m) => m.userId === v)?.user.name.split(" ")[0] ?? "Former member");
        if (def?.type === "select") return def.options.find((o) => o.id === v)?.name ?? "Removed option";
        return v;
      }
      if (field === "due") {
        const tok: Record<string, string> = { today: "Today", tomorrow: "Tomorrow", week: "In 7 days", sprint: "Sprint end" };
        return tok[v] ?? shortDate(v);
      }
      if (field === "assignee" && v === "me") return "Me";
      if (field === "assignee") return members.find((m) => m.userId === v)?.user.name.split(" ")[0] ?? "Former member";
      return options(field).find((o) => o.id === v)?.label ?? "Unknown";
    },
    [options, members, fields],
  );

  /** "Alex, Jordan +1" — the value part of a chip. */
  const valuesText = useCallback(
    (r: FilterRule) => {
      const names = r.values.map((v) => valueLabel(r.field, v));
      return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
    },
    [valueLabel],
  );

  const describe = useCallback(
    (r: FilterRule) => `${fieldLabel(r.field, fields)} ${OP_LABEL[r.op]}${r.op === "empty" || r.op === "set" ? "" : ` ${valuesText(r)}`}`,
    [valuesText, fields],
  );

  return { ctx, options, valueLabel, valuesText, describe, fields };
}

export type FilterOptions = ReturnType<typeof useFilterOptions>;
