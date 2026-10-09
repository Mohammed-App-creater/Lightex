"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { DateChip, DatePicker } from "@/components/ui/date-picker";
import { Skeleton } from "@/components/ui/feedback";
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { CF_TYPE_ICON } from "@/features/filters/filter-bar";
import { useProjectMembers } from "@/features/projects/queries";
import type { CustomField, CustomFieldValue, TaskDetail, TaskPatch } from "@/lib/api/types";
import { can, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { todayISO } from "@/lib/utils/dates";
import { displayValue, hasValue, TEXT_MAX, validateValue, visibleRows } from "./field-lib";
import { useCustomFields } from "./queries";

/**
 * Task panel "Custom fields" group (board 39 .tx-cf): rows for fields with a value, required
 * fields, and fields revealed through "Add property". Per-type editors: inline text / number,
 * select and person menus with Clear, date popover with Today and Clear.
 */
export function TaskCustomFields({ task, canEdit, revealed, onPatch }: { task: TaskDetail; canEdit: boolean; revealed: ReadonlySet<string>; onPatch: (p: TaskPatch) => void }) {
  const ws = useCurrentWorkspace()!;
  const fieldsQ = useCustomFields(task.projectId);
  const { data: members = [] } = useProjectMembers(task.projectId);
  const memberMap = new Map(members.map((m) => [m.userId, m.user]));
  const canManage = can("field.manage", task.project.my_permissions);
  const hasAnyValue = Object.keys(task.customFields ?? {}).length > 0;

  const header = (
    <div className="flex h-6 items-center justify-between font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3">
      <span>Custom fields</span>
      {canManage && (
        <Link href={`${routes.project(ws.slug, task.project.key, "settings")}?tab=fields`} className="rounded-[5px] px-1.5 py-1 font-sans text-[11px] normal-case tracking-normal text-fg-3 hover:bg-hover hover:text-fg">
          Manage
        </Link>
      )}
    </div>
  );
  const wrap = (body: ReactNode) => (
    <div role="group" aria-label="Custom fields" className="flex flex-col border-t border-line pt-2">
      {header}
      {body}
    </div>
  );

  if (fieldsQ.isPending) {
    if (!hasAnyValue) return null;
    return wrap(
      <div aria-busy="true" aria-label="Loading custom fields" className="flex flex-col gap-3 py-2">
        {[72, 54, 64].map((w) => (
          <div key={w} className="grid grid-cols-[118px_minmax(0,1fr)] items-center">
            <Skeleton className="h-2.5 w-[70px]" />
            <Skeleton className="h-2.5" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>,
    );
  }
  if (fieldsQ.isError) {
    if (!hasAnyValue) return null;
    return wrap(
      <p role="alert" className="m-0 flex items-center gap-2 py-1.5 text-[12px] text-fg-2">
        Couldn’t load custom fields.
        <button type="button" className="font-medium text-accent-t hover:underline" onClick={() => void fieldsQ.refetch()}>
          Retry
        </button>
      </p>,
    );
  }
  const rows = visibleRows(fieldsQ.data, task, revealed);
  if (!rows.length) return null;
  const set = (f: CustomField, v: CustomFieldValue | null) => {
    if ((task.customFields?.[f.id] ?? null) === v) return;
    onPatch({ customFields: { [f.id]: v } });
  };

  return wrap(
    rows.map((f) => (
      <div key={f.id} className="grid min-h-8 grid-cols-[118px_minmax(0,1fr)] items-center max-[760px]:min-h-11">
        <span className="flex min-w-0 items-center gap-[7px] truncate text-[12px] font-medium text-fg-3 [&_svg]:size-3 [&_svg]:flex-none">
          {CF_TYPE_ICON[f.type]}
          <span className="truncate">{f.name}</span>
        </span>
        <span className="min-w-0">
          <ValueCell field={f} value={task.customFields?.[f.id]} canEdit={canEdit} members={memberMap} onSet={(v) => set(f, v)} />
        </span>
      </div>
    )),
  );
}

const pv =
  "-ml-1.5 inline-flex min-h-[26px] max-w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-[13px] font-medium leading-[1.3] text-fg max-[760px]:min-h-9";
const inCls =
  "h-7 w-full rounded-sm border border-accent bg-surface px-2 text-[13px] text-fg shadow-[0_0_0_3px_var(--accent-s)] outline-none max-[760px]:h-9 max-[760px]:text-[15px]";

function ValueCell({
  field,
  value,
  canEdit,
  members,
  onSet,
}: {
  field: CustomField;
  value: CustomFieldValue | undefined;
  canEdit: boolean;
  members: ReadonlyMap<string, { id: string; name: string; hue: number }>;
  onSet: (v: CustomFieldValue | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = displayValue(field, value, members);
  const canClear = hasValue(value) && !field.required;

  const content = shown ? (
    <>
      {shown.color && <span aria-hidden className="size-[7px] flex-none rounded-full" style={{ background: shown.color }} />}
      {shown.user && <Avatar name={shown.user.name} hue={shown.user.hue} size={20} decorative />}
      <span className={cn("truncate", shown.muted && "font-normal text-fg-3", field.type === "number" && "font-mono tabular-nums")}>{shown.text}</span>
    </>
  ) : field.required ? (
    <span className="font-medium text-warn">Required</span>
  ) : (
    <span className="font-normal text-fg-3">Empty</span>
  );
  const label = `${field.name}: ${shown?.text ?? (field.required ? "Required" : "Empty")}`;

  if (!canEdit) return <span className={pv} aria-label={label}>{content}</span>;

  if (field.type === "text" || field.type === "number") {
    if (draft !== null) {
      const commit = () => {
        const d = draft;
        setDraft(null);
        const r = validateValue(field, field.type === "number" && d.trim() !== "" ? Number(d) : d);
        // Required + empty (or an invalid number) silently restores the old value (§8 #10).
        if (r.ok) onSet(r.value);
      };
      return (
        <input
          autoFocus
          aria-label={field.name}
          type={field.type === "number" ? "number" : "text"}
          min={field.type === "number" ? 0 : undefined}
          maxLength={field.type === "text" ? TEXT_MAX : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
            }
          }}
          className={cn(inCls, field.type === "number" && "font-mono text-[12.5px]")}
        />
      );
    }
    return (
      <button type="button" aria-label={label} onClick={() => setDraft(value === undefined ? "" : String(value))} className={cn(pv, "hover:bg-hover")}>
        {content}
      </button>
    );
  }

  if (field.type === "date") {
    return (
      <DatePicker
        value={typeof value === "string" ? value : null}
        onChange={(v) => {
          if (v) onSet(v);
          else if (!field.required) onSet(null);
        }}
        align="end"
        quick={(pick) => (
          <>
            <DateChip onClick={() => pick(todayISO())}>Today</DateChip>
            {canClear && <DateChip onClick={() => pick(null)}>Clear</DateChip>}
          </>
        )}
      >
        <button type="button" aria-label={label} aria-haspopup="dialog" className={cn(pv, "hover:bg-hover data-[state=open]:bg-hover")}>
          {content}
        </button>
      </DatePicker>
    );
  }

  const items = field.type === "select" ? field.options.map((o) => ({ id: o.id, name: o.name, icon: <span aria-hidden className="size-[7px] rounded-full" style={{ background: o.color }} /> })) : [...members.values()].map((u) => ({ id: u.id, name: u.name, icon: <Avatar name={u.name} hue={u.hue} size={20} decorative /> }));
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label={label} aria-haspopup="listbox" className={cn(pv, "hover:bg-hover data-[state=open]:bg-hover")}>
          {content}
        </button>
      </MenuTrigger>
      <MenuContent align="start" width={230} aria-label={field.name} className="max-h-[320px] overflow-y-auto">
        <MenuRadioGroup value={typeof value === "string" ? value : ""} onValueChange={(v) => onSet(v)}>
          {items.map((it) => (
            <MenuRadioItem key={it.id} value={it.id} icon={it.icon}>
              {it.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {canClear && (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => onSet(null)}>Clear</MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
