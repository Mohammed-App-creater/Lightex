"use client";

import { Bell, Building2, KeyRound, ShieldCheck, Trash2, TriangleAlert, UserRound, Users } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { useSession } from "@/features/auth/session";
import { canOpenTrash } from "@/features/trash/lib";
import { useProjects, useRoles } from "@/features/workspace/queries";
import { can, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes, useRouteInfo, type SettingsSection } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";

type NavItem = { key: SettingsSection | "danger" | "trash"; label: string; icon: ReactNode; href: string; danger?: boolean };

/**
 * Settings shell (board 20 B.2): a 220px settings nav (Account / Workspace / Danger zone) next to
 * the page. Below 760px the nav becomes a horizontal scroller above the page.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const ws = useCurrentWorkspace()!;
  const route = useRouteInfo();
  const { user } = useSession();
  const roles = useRoles(ws.slug);
  const myRole = roles.data?.find((r) => r.id === ws.myRoleId);
  const projects = useProjects(ws.slug);

  const account: NavItem[] = [
    { key: "profile", label: "Profile", icon: <UserRound size={16} strokeWidth={1.5} aria-hidden />, href: routes.settings(ws.slug, "profile") },
    { key: "notifications", label: "Notifications", icon: <Bell size={16} strokeWidth={1.5} aria-hidden />, href: routes.settings(ws.slug, "notifications") },
  ];
  const workspace: NavItem[] = [
    { key: "general", label: "General", icon: <Building2 size={16} strokeWidth={1.5} aria-hidden />, href: routes.settings(ws.slug, "general") },
    { key: "members", label: "Members", icon: <Users size={16} strokeWidth={1.5} aria-hidden />, href: routes.settings(ws.slug, "members") },
    { key: "roles", label: "Roles", icon: <KeyRound size={16} strokeWidth={1.5} aria-hidden />, href: routes.settings(ws.slug, "roles") },
  ];
  // Board 31: audit log is admins-only; hidden (not disabled) without audit.view.
  if (can("audit.view", ws.my_permissions)) {
    workspace.push({ key: "audit", label: "Audit log", icon: <ShieldCheck size={16} strokeWidth={1.5} aria-hidden />, href: routes.settings(ws.slug, "audit") });
  }
  // Board 29: workspace Trash (its own page, /:ws/trash); hidden for users who can't restore anything.
  if (canOpenTrash(ws.my_permissions, projects.data ?? [])) {
    workspace.push({ key: "trash", label: "Trash", icon: <Trash2 size={16} strokeWidth={1.5} aria-hidden />, href: routes.trash(ws.slug) });
  }
  if (can("workspace.delete", ws.my_permissions)) {
    workspace.push({
      key: "danger",
      label: "Danger zone",
      icon: <TriangleAlert size={16} strokeWidth={1.5} aria-hidden />,
      href: `${routes.settings(ws.slug, "general")}#danger-zone`,
      danger: true,
    });
  }
  const isActive = (k: NavItem["key"]) => k !== "danger" && k !== "trash" && route.section === k;

  return (
    <div className="flex h-full min-h-0 max-[760px]:flex-col">
      {/* Wide: vertical nav */}
      <nav
        aria-label="Settings"
        className="flex w-[220px] flex-none flex-col gap-0.5 overflow-y-auto border-r border-line bg-surface px-2.5 pb-2.5 pt-4 max-[760px]:hidden"
      >
        <h2 className="m-0 mb-2.5 flex h-[30px] items-center px-2 text-[13px] font-semibold">Settings</h2>
        <NavGroup label="Account" items={account} isActive={isActive} />
        <NavGroup label="Workspace" items={workspace} isActive={isActive} />
        {user && (
          <div className="mt-auto flex items-center gap-2.5 border-t border-line p-2 pt-3">
            <Avatar name={user.name} hue={user.hue} size={28} decorative ring={false} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-semibold">{user.name}</span>
              <span className="truncate text-[11px] text-fg-3">
                {myRole ? `${myRole.name} · ` : ""}
                {ws.name}
              </span>
            </div>
          </div>
        )}
      </nav>

      {/* Mobile: horizontal scroller */}
      <nav
        aria-label="Settings"
        className="hidden flex-none gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-2 [scrollbar-width:none] max-[760px]:flex"
      >
        {[...account, ...workspace].map((it) => (
          <Link
            key={it.key}
            href={it.href}
            aria-current={isActive(it.key) ? "page" : undefined}
            className={cn(
              "inline-flex h-11 flex-none items-center gap-2 rounded-[8px] px-3 text-[14px] font-medium text-fg-2",
              "aria-[current=page]:bg-accent-s aria-[current=page]:text-fg",
              it.danger && "text-danger",
            )}
          >
            <span className={cn("flex", it.danger ? "text-danger" : isActive(it.key) ? "text-accent-t" : "text-fg-3")}>{it.icon}</span>
            {it.label}
          </Link>
        ))}
      </nav>

      <div className="relative min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-color:var(--line-2)_transparent] [scrollbar-width:thin]">
        {children}
      </div>
    </div>
  );
}

function NavGroup({ label, items, isActive }: { label: string; items: NavItem[]; isActive: (k: NavItem["key"]) => boolean }) {
  return (
    <>
      <div className="px-2 pb-1.5 pt-3 font-mono text-[11px] font-medium uppercase tracking-[0.07em] text-fg-3">{label}</div>
      {items.map((it) => {
        const on = isActive(it.key);
        return (
          <Link
            key={it.key}
            href={it.href}
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex h-[30px] items-center gap-2.5 rounded-[7px] px-2 text-[13px] font-medium text-fg-2",
              "transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg",
              on && "bg-accent-s text-fg hover:bg-accent-s",
            )}
          >
            <span className={cn("flex", it.danger ? "text-danger" : on ? "text-accent-t" : "text-fg-3")}>{it.icon}</span>
            {it.label}
          </Link>
        );
      })}
    </>
  );
}

/** Page frame inside the settings shell: max 880, padding 28/40/96, h2 header. */
export function SettingsPage({
  title,
  actions,
  children,
  wide,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Members / roles use the wider 980px frame (board 18). */
  wide?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col px-10 pb-24 pt-7 animate-[fade-in_180ms_var(--ease)] max-[1023px]:px-6 max-[760px]:px-4 max-[760px]:pt-4",
        wide ? "max-w-[1060px]" : "max-w-[880px]",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-3 pb-5">
        <h1 className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.015em]">{title}</h1>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/** Section row (board 20 .st-row): 168px heading column + controls column. */
export function SettingsSection({
  title,
  description,
  children,
  id,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={id ? `${id}-h` : undefined}
      className={cn(
        "grid scroll-mt-6 grid-cols-[168px_minmax(0,1fr)] gap-x-8 gap-y-2.5 border-t border-line py-5 max-[760px]:grid-cols-1 max-[760px]:py-4",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <h2 id={id ? `${id}-h` : undefined} className="m-0 text-[13px] font-semibold leading-8 max-[760px]:leading-[18px]">
          {title}
        </h2>
        {description && <p className="m-0 text-[12px] leading-4 text-fg-3">{description}</p>}
      </div>
      <div className="flex min-w-0 max-w-[560px] flex-col gap-3.5">{children}</div>
    </section>
  );
}
