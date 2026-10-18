"use client";

import * as Popover from "@radix-ui/react-popover";
import { Search, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Avatar, UnassignedAvatar } from "@/ui/avatar";
import { Checkbox } from "@/ui/choice";
import { MenuCheckboxItem, MenuItem, MenuLabel, MenuSeparator } from "@/ui/menu";
import type { User } from "@/api/types";
import { cn } from "@/lib/utils/cn";

/* Multiple assignees (docs/tracking/checklist-assignees.md §1): 0–10 people, in order; writes replace the set. */

export const MAX_ASSIGNEES = 10;
export const FULL_REASON = `Up to ${MAX_ASSIGNEES} people. Remove someone to add another.`;

/** Adds `userId` last, or removes it. Adding to a full list is a no-op. */
export function toggleAssignee(ids: readonly string[], userId: string): string[] {
  if (ids.includes(userId)) return ids.filter((x) => x !== userId);
  return ids.length >= MAX_ASSIGNEES ? [...ids] : [...ids, userId];
}

type Person = Pick<User, "id" | "name" | "hue">;

/**
 * Checkbox rows for a Menu (list cells): toggling keeps the menu open. When the task already has 10 people the
 * unchecked rows are disabled and the reason is shown at the top.
 */
export function AssigneeMenuItems({ people, value, onChange }: { people: readonly Person[]; value: readonly string[]; onChange: (ids: string[]) => void }) {
  const full = value.length >= MAX_ASSIGNEES;
  return (
    <>
      {full && <MenuLabel>{FULL_REASON}</MenuLabel>}
      {people.map((u) => {
        const on = value.includes(u.id);
        return (
          <MenuCheckboxItem
            key={u.id}
            checked={on}
            disabled={full && !on}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => onChange(toggleAssignee(value, u.id))}
            icon={<Avatar name={u.name} hue={u.hue} size={20} decorative />}
          >
            {u.name}
          </MenuCheckboxItem>
        );
      })}
      {value.length > 0 && (
        <>
          <MenuSeparator />
          <MenuItem icon={<UnassignedAvatar size={18} />} onSelect={() => onChange([])}>
            Unassign everyone
          </MenuItem>
        </>
      )}
    </>
  );
}

/**
 * The task panel's people picker: search, a checkbox per project member, and the current assignees (in order)
 * with a remove button each. Every toggle is saved at once (optimistic, through `onChange`).
 */
export function AssigneePicker({
  people,
  value,
  onChange,
  children,
}: {
  people: readonly Person[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  /** The trigger (a button). */
  children: ReactNode;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => people.filter((u) => u.name.toLowerCase().includes(q.trim().toLowerCase())), [people, q]);
  const byId = useMemo(() => new Map(people.map((u) => [u.id, u])), [people]);
  const current = value.map((id) => byId.get(id)).filter((u): u is Person => Boolean(u));
  const full = value.length >= MAX_ASSIGNEES;
  return (
    <Popover.Root onOpenChange={(o) => !o && setQ("")}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={16}
          aria-label="Assignees"
          className="z-[70] w-[280px] max-w-[calc(100vw-32px)] rounded-[10px] border border-line-2 bg-raised p-1 shadow-pop outline-none data-[state=open]:animate-[menu-in_150ms_var(--ease)]"
        >
          {current.length > 0 && (
            <ul aria-label="Assigned" className="m-0 flex list-none flex-wrap gap-1 border-b border-line p-1.5">
              {current.map((u) => (
                <li key={u.id} className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-line bg-surface pl-1 pr-0.5 text-[12px] font-medium">
                  <Avatar name={u.name} hue={u.hue} size={18} ring={false} decorative />
                  <span className="max-w-[120px] truncate">{u.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${u.name}`}
                    onClick={() => onChange(value.filter((x) => x !== u.id))}
                    className="flex size-5 items-center justify-center rounded-xs text-fg-3 hover:bg-hover hover:text-fg max-[1023px]:size-7"
                  >
                    <X size={10} strokeWidth={2.5} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="relative p-1">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search people…"
              aria-label="Search people"
              className="h-[30px] w-full rounded-sm border border-line-2 bg-bg pl-7 pr-2 text-[13px] outline-none focus:border-accent max-[1023px]:h-10"
            />
          </div>
          {full && (
            <p role="status" className="m-0 px-2 pb-1 pt-0.5 text-[12px] leading-4 text-fg-3">
              {FULL_REASON}
            </p>
          )}
          <div role="listbox" aria-multiselectable="true" aria-label="Project members" className="max-h-[240px] overflow-auto">
            {shown.map((u) => {
              const on = value.includes(u.id);
              const disabled = full && !on;
              return (
                <label
                  key={u.id}
                  title={disabled ? FULL_REASON : undefined}
                  className={cn(
                    "flex h-[32px] items-center gap-2.5 rounded-sm px-2 text-[13px] font-medium max-[1023px]:h-11",
                    disabled ? "cursor-not-allowed text-fg-3" : "cursor-pointer hover:bg-hover",
                  )}
                >
                  <Checkbox checked={on} disabled={disabled} onChange={() => onChange(toggleAssignee(value, u.id))} />
                  <Avatar name={u.name} hue={u.hue} size={20} ring={false} decorative />
                  <span className="truncate">{u.name}</span>
                </label>
              );
            })}
            {shown.length === 0 && <p className="m-0 px-2 py-2.5 text-[12px] text-fg-3">No one matches.</p>}
          </div>
          <p className="m-0 border-t border-line px-2 py-1.5 font-mono text-[11px] text-fg-3">
            {value.length} of {MAX_ASSIGNEES} assigned
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
