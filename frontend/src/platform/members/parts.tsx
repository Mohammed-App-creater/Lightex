"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Menu, MenuCheckboxItem, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/ui/menu";
import type { Role } from "@/api/types";
import { cn } from "@/lib/utils/cn";
import { emailInitials, rolesLabel, roleNamesOf, roleToggleBlock, toggleRoleId } from "./lib";

export function RoleRadioItems({ roles, value, onChange }: { roles: Role[]; value: string; onChange: (roleId: string) => void }) {
  return (
    <MenuRadioGroup value={value} onValueChange={(v) => v !== value && onChange(v)}>
      {roles.map((r) => (
        <MenuRadioItem key={r.id} value={r.id}>
          {r.name}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/**
 * Sales S0: checkbox items for a member's (or an invite's) workspace roles. The menu stays open while toggling.
 * A role that can't be toggled is disabled with its reason under the name.
 */
export function RoleCheckboxItems({
  roles,
  value,
  onChange,
  myPermissions,
  describe,
}: {
  roles: Role[];
  value: string[];
  onChange: (roleIds: string[]) => void;
  myPermissions: readonly string[];
  /** Show each role's description (the invite dialog). */
  describe?: boolean;
}) {
  return (
    <>
      {roles.map((r) => {
        const on = value.includes(r.id);
        const block = roleToggleBlock(r, value, myPermissions);
        const sub = block ?? (describe ? r.description : "");
        return (
          <MenuCheckboxItem
            key={r.id}
            checked={on}
            disabled={Boolean(block)}
            title={block ?? undefined}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(c) => onChange(toggleRoleId(value, r.id, c === true, roles))}
            className="h-auto min-h-[30px] py-1.5"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate">{r.name}</span>
              {sub && <span className="truncate text-[11.5px] font-normal text-fg-3">{sub}</span>}
            </span>
          </MenuCheckboxItem>
        );
      })}
    </>
  );
}

/** Sales S0: a member's roles as chips (board 18 role cell, one chip per role). */
export function RoleChips({ names, className }: { names: string[]; className?: string }) {
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {names.length === 0 && <span className="text-fg-3">—</span>}
      {names.map((n) => (
        <span key={n} className="inline-flex h-[22px] max-w-full items-center truncate rounded-sm border border-line-2 bg-raised px-1.5 text-[12px] font-medium text-fg-2">
          <span className="truncate">{n}</span>
        </span>
      ))}
    </span>
  );
}

/** Sales S0: the member row's role control: the chips open a multi-select of workspace roles. */
export function RoleMultiPicker({
  roles,
  value,
  onChange,
  label,
  myPermissions,
}: {
  roles: Role[];
  value: string[];
  onChange: (roleIds: string[]) => void;
  /** Accessible name, e.g. "Roles for Sam Patel". */
  label: string;
  myPermissions: readonly string[];
}) {
  const names = roleNamesOf(value, roles);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${rolesLabel(names)}`}
          className={cn(
            "-ml-1.5 inline-flex min-h-7 max-w-[calc(100%+6px)] items-center gap-1 rounded-sm border border-transparent py-0.5 pl-1.5 pr-1 text-left",
            "transition-[background-color,border-color] duration-[var(--dur-fast)] hover:border-line-2 hover:bg-raised data-[state=open]:border-line-2 data-[state=open]:bg-raised max-[760px]:min-h-10",
          )}
        >
          <RoleChips names={names} />
          <ChevronDown size={12} className="flex-none text-fg-3" aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="start" width={260}>
        <RoleCheckboxItems roles={roles} value={value} onChange={onChange} myPermissions={myPermissions} />
      </MenuContent>
    </Menu>
  );
}

/** Status pill (board 18 .mm-st): 22px, dot in currentColor, 12% tint. */
export function StatusPill({ kind }: { kind: "active" | "invited" | "deactivated" }) {
  const color = kind === "active" ? "var(--ok)" : kind === "invited" ? "var(--warn)" : "var(--text-3)";
  const label = kind === "active" ? "Active" : kind === "invited" ? "Invited" : "Deactivated";
  return (
    <span
      className="inline-flex h-[22px] w-fit items-center gap-1.5 rounded-full px-2 text-[12px] font-medium"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** Dashed invite avatar with the first two letters of the email. */
export function InviteAvatar({ email, size = 28 }: { email: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex flex-none items-center justify-center rounded-full border-[1.5px] border-dashed border-control text-[10px] font-semibold text-fg-3"
      style={{ width: size, height: size }}
    >
      {emailInitials(email)}
    </span>
  );
}

/** Dashed state box (board 18 .mm-state). */
export function StateBox({
  icon,
  title,
  meta,
  children,
  small,
  tone,
  role,
}: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  small?: boolean;
  tone?: "danger";
  role?: "alert" | "status";
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-line-2 text-center",
        small ? "px-4 py-[22px]" : "px-4 py-9",
      )}
    >
      {icon && (
        <span
          className={cn(
            "flex size-10 items-center justify-center rounded-[10px] border border-line-2 bg-raised",
            tone === "danger" ? "text-danger" : "text-fg-2",
          )}
        >
          {icon}
        </span>
      )}
      <span className="text-[14px] font-semibold">{title}</span>
      {meta && <span className="text-[12px] text-fg-3">{meta}</span>}
      {children}
    </div>
  );
}

/** Small mono tag (board 18 .mm-tag). */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1 rounded-sm border border-line-2 px-2 font-mono text-[11px] font-medium text-fg-3",
        className,
      )}
    >
      {children}
    </span>
  );
}
