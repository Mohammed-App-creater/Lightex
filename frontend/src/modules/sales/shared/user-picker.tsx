"use client";

import { ChevronDown } from "lucide-react";
import type { Permission, User } from "@/api/types";
import { useSession } from "@/platform/auth/session";
import { useWsMembers } from "@/platform/workspace/queries";
import { Avatar, UnassignedAvatar } from "@/ui/avatar";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";
import { cn } from "@/lib/utils/cn";
import { useSlug } from "../api/queries";
import { useSalesScope } from "./scope";

export type Person = Pick<User, "id" | "name" | "hue">;

/** Active workspace members, as people. */
export function useSalesPeople(): { people: Person[]; isPending: boolean } {
  const slug = useSlug();
  const q = useWsMembers(slug);
  const people = (q.data ?? []).filter((m) => m.status === "active").map((m) => ({ id: m.user.id, name: m.user.name, hue: m.user.hue }));
  return { people, isPending: q.isPending };
}

/**
 * Pick one workspace member (owner filters, reassign, target subjects). `noneLabel` adds a "nobody / any" row that
 * sends null.
 */
export function UserPicker({
  value,
  onChange,
  label = "Person",
  noneLabel,
  people: given,
  disabled,
  className,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  label?: string;
  noneLabel?: string;
  /** Limit the choices (default: every active member). */
  people?: Person[];
  disabled?: boolean;
  className?: string;
}) {
  const all = useSalesPeople().people;
  const people = given ?? all;
  const current = people.find((p) => p.id === value) ?? all.find((p) => p.id === value);
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        aria-label={`${label}: ${current?.name ?? noneLabel ?? "none"}`}
        className={cn(
          "inline-flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md border border-line bg-surface px-2 text-[13px] text-fg hover:bg-hover disabled:opacity-60 max-[1023px]:h-11",
          className,
        )}
      >
        {current ? <Avatar name={current.name} hue={current.hue} size={20} decorative /> : <UnassignedAvatar size={20} />}
        <span className="min-w-0 flex-1 truncate text-left">{current?.name ?? noneLabel ?? label}</span>
        <ChevronDown size={14} aria-hidden className="flex-none text-fg-3" />
      </MenuTrigger>
      <MenuContent align="start" width={240} className="max-h-[320px] overflow-y-auto">
        {noneLabel && (
          <>
            <MenuItem icon={<UnassignedAvatar size={18} />} onSelect={() => onChange(null)}>
              {noneLabel}
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {people.map((p) => (
          <MenuItem key={p.id} icon={<Avatar name={p.name} hue={p.hue} size={20} decorative />} onSelect={() => onChange(p.id)}>
            {p.name}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/**
 * The owner field of a sales record. With an `own` scope on `code` (e.g. `sales.lead.assign`, `sales.company.edit`)
 * you can only own it yourself, so this renders a read-only "You"; with `team` / `all` it is a `UserPicker` (the
 * server answers 422 `ownerId` "Pick someone in your team" for a `team` scope outside your teams: show it on the
 * field). Without the permission it renders the current owner read-only.
 */
export function OwnerPicker({
  code,
  value,
  onChange,
  className,
}: {
  code: Permission;
  value: string | null;
  onChange: (id: string | null) => void;
  className?: string;
}) {
  const { user } = useSession();
  const { beyondOwn } = useSalesScope(code);
  const { people } = useSalesPeople();
  if (!beyondOwn) {
    const p = people.find((x) => x.id === value) ?? (user ? { id: user.id, name: user.name, hue: user.hue } : null);
    return (
      <span className={cn("inline-flex h-8 items-center gap-2 text-[13px] text-fg-2", className)}>
        {p && <Avatar name={p.name} hue={p.hue} size={20} decorative />}
        {p ? (p.id === user?.id ? "You" : p.name) : "—"}
      </span>
    );
  }
  return <UserPicker value={value} onChange={onChange} label="Owner" className={className} />;
}
