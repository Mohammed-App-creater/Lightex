"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import type { Role } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { emailInitials } from "./lib";

/** Inline role picker (board 18 .mm-rp): role name + chevron, popover listbox of roles. */
export function RolePicker({
  roles,
  value,
  onChange,
  label,
  className,
}: {
  roles: Role[];
  value: string;
  onChange: (roleId: string) => void;
  /** Accessible name, e.g. "Role for Sam Patel". */
  label: string;
  className?: string;
}) {
  const current = roles.find((r) => r.id === value);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${current?.name ?? "No role"}`}
          className={cn(
            "-ml-2 inline-flex h-7 max-w-[calc(100%+8px)] items-center gap-1.5 rounded-sm border border-transparent pl-2 pr-1.5 text-[13px] font-medium text-fg",
            "transition-[background-color,border-color] duration-[var(--dur-fast)] hover:border-line-2 hover:bg-raised data-[state=open]:border-line-2 data-[state=open]:bg-raised max-[760px]:h-10",
            className,
          )}
        >
          <span className="truncate">{current?.name ?? "—"}</span>
          <ChevronDown size={12} className="flex-none text-fg-3" aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="start" width={240}>
        <RoleRadioItems roles={roles} value={value} onChange={onChange} />
      </MenuContent>
    </Menu>
  );
}

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
