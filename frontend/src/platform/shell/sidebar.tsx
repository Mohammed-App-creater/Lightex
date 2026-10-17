"use client";

import { motion } from "motion/react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Inbox,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Sun,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useMemo, useState, type ReactNode } from "react";
import { AppIcon } from "@/ui/brand/logo";
import { Avatar, ProjectBadge } from "@/ui/avatar";
import { Kbd } from "@/ui/kbd";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@/ui/menu";
import { toast } from "@/ui/toast";
import { Tooltip } from "@/ui/tooltip";
import { useSession } from "@/platform/auth/session";
import { useProjects, useRoles, useUnreadCount, useWorkspaces, useMyTasks } from "@/platform/workspace/queries";
import type { Workspace } from "@/api/types";
import { can, useCan, useCurrentWorkspace } from "@/platform/roles/can";
import { routes, useRouteInfo } from "@/platform/routes";
import { cn } from "@/lib/utils/cn";
import { useModKey } from "@/lib/hooks/use-platform";
import { moduleNavItems, projectNavItems, sidebarProjectCards, sidebarSections } from "@/registry";
import { shell } from "./shell-state";

/** Project links from the module registry that this project's permissions allow. */
export const subItemsFor = (perms: string[]) => projectNavItems().filter((s) => !s.gate || s.gate(perms));

const itemBase =
  "relative flex h-[30px] w-full items-center gap-2.5 rounded-[7px] px-2 text-[13px] font-medium text-fg-2 transition-colors duration-[var(--dur-fast)] ease-out hover:bg-hover hover:text-fg max-[1023px]:h-[42px]";

function NavItem({
  href,
  icon,
  label,
  active,
  trailing,
  onNavigate,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  trailing?: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} onClick={onNavigate} className={cn(itemBase, active && "bg-hover text-fg")}>
      <span className="flex size-4 flex-none items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </Link>
  );
}

function SectionHeader({ label, open, onToggle, count, action }: { label: string; open: boolean; onToggle: () => void; count?: number; action?: ReactNode }) {
  return (
    <div className="mt-3.5 flex h-7 items-center gap-1 pl-2 pr-1 font-mono text-[11px] font-medium uppercase leading-none tracking-[0.07em] text-fg-3">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left hover:text-fg-2">
        <ChevronDown size={10} strokeWidth={2} aria-hidden className={cn("flex-none transition-transform duration-[180ms] ease-out", !open && "-rotate-90")} />
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="tracking-normal">{count}</span>}
      </button>
      {action}
    </div>
  );
}

function WorkspaceMenu({ current, rail, children }: { current: Workspace; rail?: boolean; children: ReactNode }) {
  const router = useRouter();
  const { data: workspaces = [] } = useWorkspaces();
  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent align="start" side={rail ? "right" : "bottom"} width={240}>
        <MenuRadioGroup value={current.slug} onValueChange={(slug) => router.push(routes.home(slug))}>
          {workspaces.map((w) => (
            <MenuRadioItem key={w.id} value={w.slug} icon={<ProjectBadge code={initials(w.name)} hue={w.hue} size={18} />}>
              {w.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        {can("core.workspace.update", current.my_permissions) && (
          <MenuItem icon={<Settings size={14} aria-hidden />} onSelect={() => router.push(routes.settings(current.slug, "general"))}>
            Workspace settings
          </MenuItem>
        )}
        <MenuItem icon={<Plus size={14} aria-hidden />} onSelect={() => router.push(`${routes.onboarding()}?new=1`)}>
          Create workspace
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function AccountMenu({ rail, children, ws }: { rail?: boolean; children: ReactNode; ws: string }) {
  const { user, signOut } = useSession();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent side={rail ? "right" : "top"} align={rail ? "end" : "start"} width={rail ? 240 : undefined} className={rail ? undefined : "w-[var(--radix-dropdown-menu-trigger-width)]"}>
        <div className="mb-1 border-b border-line px-2 pb-2.5 pt-2">
          <div className="font-semibold">{user?.name}</div>
          <div className="truncate text-[12px] text-fg-3">{user?.email}</div>
        </div>
        <MenuItem keys={["G", "P"]} onSelect={() => router.push(routes.settings(ws, "profile"))}>
          Profile
        </MenuItem>
        <MenuItem onSelect={() => router.push(routes.settings(ws, "notifications"))}>Preferences</MenuItem>
        <MenuSub>
          <MenuSubTrigger>Theme</MenuSubTrigger>
          <MenuSubContent>
            <MenuRadioGroup value={theme ?? "dark"} onValueChange={setTheme}>
              <MenuRadioItem value="dark" icon={<Moon size={14} aria-hidden />}>
                Navy
              </MenuRadioItem>
              <MenuRadioItem value="black" icon={<Moon size={14} aria-hidden className="fill-current" />}>
                Near-black
              </MenuRadioItem>
              <MenuRadioItem value="light" icon={<Sun size={14} aria-hidden />}>
                Light
              </MenuRadioItem>
              <MenuRadioItem value="system" icon={<Monitor size={14} aria-hidden />}>
                System
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuSubContent>
        </MenuSub>
        <MenuSeparator />
        <MenuItem
          onSelect={async () => {
            // The logout request revokes the refresh cookie server-side; it can take a moment in live mode.
            const id = toast.info("Signing out…", { id: "sign-out", duration: 0 });
            try {
              await signOut();
            } finally {
              toast.dismiss(id);
            }
            router.replace(routes.login());
          }}
        >
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** The expanded / rail sidebar. `touch` = mobile drawer (42–44px targets). */
export function Sidebar({ rail, touch, onClose }: { rail?: boolean; touch?: boolean; onClose?: () => void }) {
  const ws = useCurrentWorkspace()!;
  const { user } = useSession();
  const route = useRouteInfo();
  const { data: projects = [] } = useProjects(ws.slug);
  const { data: unread = 0 } = useUnreadCount(ws.id);
  const { data: myTasks = [] } = useMyTasks(ws.slug);
  const { data: roles = [] } = useRoles(ws.slug);
  const canCreateProject = useCan("tracking.project.create");
  const canManageMembers = useCan("core.workspace.manage_members");
  const canCreateTask = projects.some((p) => can("tracking.task.create", p.my_permissions));
  // Module sidebar sections (registry), open by default.
  const [closedSections, setClosedSections] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSection = (id: string) =>
    setClosedSections((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(route.projectKey);
  const [filter, setFilter] = useState("");
  const [prevRouteKey, setPrevRouteKey] = useState(route.projectKey);
  if (route.projectKey !== prevRouteKey) {
    // Navigating to another project opens it in the accordion (state derived from props).
    setPrevRouteKey(route.projectKey);
    if (route.projectKey) setOpenKey(route.projectKey);
  }

  const roleName = roles.find((r) => r.id === ws.myRoleId)?.name ?? "";
  const activeProject = projects.find((p) => p.key === route.projectKey) ?? projects[0];
  const openMine = myTasks.filter((t) => !t.completedAt);
  const shownProjects = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase() === q);
  }, [projects, filter]);
  const nav = () => onClose?.();
  const mod = useModKey();

  if (rail) {
    return (
      <nav aria-label="Main navigation (collapsed)" className="flex h-full flex-col items-center gap-1 py-2.5">
        <WorkspaceMenu current={ws} rail>
          <button type="button" aria-label={`Workspace: ${ws.name}`} className="flex h-9 w-10 items-center justify-center rounded-md hover:bg-hover">
            <AppIcon size={24} />
          </button>
        </WorkspaceMenu>
        <RailButton label="Search" keys={["⌘", "K"]} onClick={() => shell.openPalette()}>
          <Search size={16} strokeWidth={1.6} aria-hidden />
        </RailButton>
        {canCreateTask && (
          <RailButton label="New task" keys={["C"]} onClick={() => shell.openCreateTask()} bordered>
            <Plus size={16} strokeWidth={1.8} aria-hidden />
          </RailButton>
        )}
        <span aria-hidden className="my-1.5 h-px w-7 bg-line" />
        <RailLink href={routes.inbox(ws.slug)} label={`Inbox${unread ? ` · ${unread} unread` : ""}`} keys={["G", "I"]} active={route.page === "inbox"}>
          <Inbox size={16} strokeWidth={1.6} aria-hidden />
          {unread > 0 && <span aria-hidden className="absolute right-2 top-[7px] size-[7px] rounded-full bg-accent-t shadow-[0_0_0_2px_var(--surface)]" />}
        </RailLink>
        {moduleNavItems().map((item) => (
          <RailLink key={item.id} href={item.href(ws.slug)} label={item.label} keys={item.keys} active={route.page === item.page}>
            <item.icon size={16} strokeWidth={1.6} aria-hidden />
          </RailLink>
        ))}
        <span aria-hidden className="my-1.5 h-px w-7 bg-line" />
        {projects.slice(0, 6).map((p) => (
          <RailLink key={p.id} href={routes.project(ws.slug, p.key)} label={p.name} active={route.projectKey === p.key}>
            <ProjectBadge code={p.key.slice(0, 2)} hue={p.hue} size={22} />
          </RailLink>
        ))}
        <span className="flex-1" />
        {sidebarProjectCards().map(({ id, Component }) => (
          <Component key={id} project={activeProject} ws={ws.slug} rail />
        ))}
        <RailLink href={routes.settings(ws.slug, "profile")} label="Settings" keys={["⌘", ","]} active={route.page === "settings"}>
          <Settings size={16} strokeWidth={1.6} aria-hidden />
        </RailLink>
        <RailButton label="Expand" keys={["⌘", "B"]} onClick={() => shell.setCollapsed(false)}>
          <PanelLeftOpen size={16} strokeWidth={1.6} aria-hidden />
        </RailButton>
        <AccountMenu rail ws={ws.slug}>
          <button type="button" aria-label={`Account: ${user?.name}`} className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-hover">
            <Avatar name={user?.name ?? "?"} hue={user?.hue} size={28} decorative />
          </button>
        </AccountMenu>
      </nav>
    );
  }

  return (
    <nav aria-label="Main navigation" className={cn("flex h-full flex-col", touch && "touch")}>
      <div className="relative flex items-center gap-1 px-2.5 pb-2 pt-2.5">
        <WorkspaceMenu current={ws}>
          <button
            type="button"
            className="flex h-9 min-w-0 flex-1 items-center gap-[9px] rounded-md px-2 text-[13px] font-semibold text-fg transition-colors hover:bg-hover data-[state=open]:bg-hover max-[1023px]:h-11"
          >
            <AppIcon size={24} />
            <span className="min-w-0 flex-1 truncate text-left">{ws.name}</span>
            <ChevronDown size={16} strokeWidth={1.5} className="text-fg-3" aria-hidden />
          </button>
        </WorkspaceMenu>
        {onClose ? (
          <button type="button" aria-label="Close navigation" onClick={onClose} className="flex size-11 items-center justify-center rounded-[7px] text-fg-3 hover:bg-hover hover:text-fg">
            <X size={16} aria-hidden />
          </button>
        ) : (
          <Tooltip content="Collapse" keys={["⌘", "B"]} side="bottom">
            <button
              type="button"
              aria-label="Collapse sidebar"
              onClick={() => shell.setCollapsed(true)}
              className="flex size-[30px] items-center justify-center rounded-[7px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
            >
              <PanelLeftClose size={16} strokeWidth={1.4} aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>

      <div className="px-2.5">
        <button
          type="button"
          onClick={() => shell.openPalette()}
          className="group relative flex h-[34px] w-full items-center gap-2 rounded-[9px] border border-line-2 bg-bg pl-8 pr-11 text-left text-[13px] text-fg-3 transition-[border-color,box-shadow] duration-150 hover:border-control max-[1023px]:h-11"
        >
          <Search size={16} strokeWidth={1.5} className="absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden />
          Search or jump…
          <span className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      </div>

      {canCreateTask && (
        <button
          type="button"
          onClick={() => {
            nav();
            shell.openCreateTask(activeProject && can("tracking.task.create", activeProject.my_permissions) ? { projectId: activeProject.id } : {});
          }}
          className="mx-2.5 mb-1 mt-2 flex h-8 items-center gap-2 rounded-md border border-line-2 bg-raised pl-2.5 pr-2 text-[13px] font-medium transition-[background-color,border-color,transform] duration-[var(--dur-fast)] hover:border-control hover:bg-hover active:scale-[.98] max-[1023px]:h-11"
        >
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          <span className="flex-1 text-left">New task</span>
          <Kbd>C</Kbd>
        </button>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-2.5 pt-1 [mask-image:linear-gradient(to_bottom,transparent_0,#000_8px,#000_calc(100%-20px),transparent_100%)]">
        <NavItem
          href={routes.inbox(ws.slug)}
          icon={<Inbox size={16} strokeWidth={1.6} aria-hidden />}
          label="Inbox"
          active={route.page === "inbox"}
          onNavigate={nav}
          trailing={
            unread > 0 ? (
              <span aria-label={`${unread} unread`} className="inline-flex h-[18px] min-w-5 items-center justify-center rounded-full bg-accent-s px-1.5 font-mono text-[11px] font-semibold text-accent-t">
                {unread}
              </span>
            ) : null
          }
        />
        {/* Module links come from the registry (src/registry). */}
        {moduleNavItems().map((item) => (
          <NavItem
            key={item.id}
            href={item.href(ws.slug)}
            icon={<item.icon size={16} strokeWidth={1.6} aria-hidden />}
            label={item.label}
            active={route.page === item.page}
            onNavigate={nav}
            trailing={item.id === "my-tasks" ? <span className="font-mono text-[11px] font-medium text-fg-3">{openMine.length}</span> : undefined}
          />
        ))}

        {/* Saved views pinned by me (board 30): Manage / Done, Alt+↑↓ reorder. */}
        {sidebarSections().map(({ id, Component }) => (
          <Component key={id} open={!closedSections.has(id)} onToggle={() => toggleSection(id)} onNavigate={nav} />
        ))}

        <SectionHeader
          label="Projects"
          count={projects.length}
          open={projectsOpen}
          onToggle={() => setProjectsOpen((o) => !o)}
          action={
            canCreateProject ? (
              <Tooltip content="New project" side="right">
                <Link
                  href={`${routes.home(ws.slug)}?new-project=1`}
                  aria-label="New project"
                  onClick={nav}
                  className="flex size-[22px] items-center justify-center rounded-[5px] text-fg-3 hover:bg-hover hover:text-fg"
                >
                  <Plus size={12} strokeWidth={1.8} aria-hidden />
                </Link>
              </Tooltip>
            ) : null
          }
        />
        <div className="collapse-rows" data-open={projectsOpen}>
          <div>
            {projects.length > 8 && (
              <input
                type="search"
                aria-label="Filter projects"
                placeholder="Filter projects…"
                maxLength={60}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="my-1 h-7 w-full rounded-[7px] border border-line bg-bg px-2.5 text-[12px] outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-s)]"
              />
            )}
            {shownProjects.length === 0 && (
              <p className="mx-2 my-1.5 text-[12px] text-fg-3">{projects.length ? "No projects match." : "No projects yet."}</p>
            )}
            {shownProjects.map((p) => {
              const open = openKey === p.key;
              const active = route.projectKey === p.key;
              const subs = subItemsFor(p.my_permissions);
              const subIndex = active ? subs.findIndex((s) => s.view === route.view) : -1;
              return (
                <div key={p.id}>
                  <div className="flex items-center">
                    <Link
                      href={routes.project(ws.slug, p.key)}
                      onClick={() => {
                        setOpenKey(p.key);
                        nav();
                      }}
                      aria-current={active && route.view === "overview" ? "page" : undefined}
                      className={cn(itemBase, "pr-1", active && (!open || route.view === "overview") && "bg-hover text-fg")}
                    >
                      <ProjectBadge code={p.key.slice(0, 2)} hue={p.hue} size={18} />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    </Link>
                    <button
                      type="button"
                      aria-label={`${open ? "Collapse" : "Expand"} ${p.name}`}
                      aria-expanded={open}
                      onClick={() => setOpenKey(open ? null : p.key)}
                      className="ml-0.5 flex size-[26px] flex-none items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg max-[1023px]:size-10"
                    >
                      <ChevronRight size={12} strokeWidth={1.6} aria-hidden className={cn("transition-transform duration-200", open && "rotate-90")} />
                    </button>
                  </div>
                  <div className="collapse-rows" data-open={open}>
                    <div>
                      <ul role="list" className="relative mb-1.5 ml-4 mt-0.5 border-l border-line pl-2.5">
                        {subs.map((s, i) => {
                          const on = i === subIndex;
                          return (
                            <li key={s.view} className="relative mb-0.5">
                              {on && (
                                <motion.span
                                  layoutId={`sb-ind-${p.id}`}
                                  transition={{ type: "spring", stiffness: 520, damping: 38 }}
                                  className="absolute inset-0 rounded-[7px] bg-accent-s"
                                />
                              )}
                              <Link
                                href={routes.project(ws.slug, p.key, s.view)}
                                onClick={nav}
                                aria-current={on ? "page" : undefined}
                                className={cn(
                                  "relative z-[1] flex h-[30px] items-center gap-[9px] rounded-[7px] px-2 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg max-[1023px]:h-[42px]",
                                  on && "text-fg [&_svg]:text-accent-t",
                                )}
                              >
                                <s.icon size={16} strokeWidth={1.6} aria-hidden />
                                {s.label}
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-0.5 border-t border-line px-2.5 pb-2.5 pt-2">
        {sidebarProjectCards().map(({ id, Component }) => (
          <Component key={id} project={activeProject} ws={ws.slug} onNavigate={nav} />
        ))}
        <div className="flex items-end gap-0.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {canManageMembers && (
              <NavItem
                href={routes.settings(ws.slug, "members")}
                icon={<Users size={16} strokeWidth={1.6} aria-hidden />}
                label="Members & roles"
                active={route.section === "members" || route.section === "roles"}
                onNavigate={nav}
              />
            )}
            <NavItem
              href={routes.settings(ws.slug, can("core.workspace.update", ws.my_permissions) ? "general" : "profile")}
              icon={<Settings size={16} strokeWidth={1.6} aria-hidden />}
              label="Settings"
              active={route.page === "settings" && route.section !== "members" && route.section !== "roles"}
              onNavigate={nav}
              trailing={<span className="font-mono text-[11px] text-fg-3">{mod},</span>}
            />
          </div>
          <Tooltip content="Shortcuts" keys={["?"]} side="top">
            <button
              type="button"
              aria-label="Keyboard shortcuts"
              onClick={() => shell.setShortcuts(true)}
              className="flex size-[30px] items-center justify-center rounded-[7px] text-fg-3 hover:bg-hover hover:text-fg max-[1023px]:size-11"
            >
              <CircleHelp size={16} strokeWidth={1.5} aria-hidden />
            </button>
          </Tooltip>
        </div>
        <AccountMenu ws={ws.slug}>
          <button
            type="button"
            aria-label={`Account: ${user?.name}`}
            className="mt-1 flex items-center gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-hover data-[state=open]:bg-hover"
          >
            <Avatar name={user?.name ?? "?"} hue={user?.hue} size={30} presence decorative />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-semibold leading-4">{user?.name}</span>
              <span className="truncate text-[11px] leading-[14px] text-fg-3">
                {roleName} · {ws.name}
              </span>
            </span>
            <ChevronsUpDown size={16} strokeWidth={1.5} className="text-fg-3" aria-hidden />
          </button>
        </AccountMenu>
      </div>
    </nav>
  );
}

function RailButton({ label, keys, onClick, children, bordered }: { label: string; keys?: string[]; onClick: () => void; children: ReactNode; bordered?: boolean }) {
  return (
    <Tooltip content={label} keys={keys} side="right">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(
          "relative flex h-9 w-10 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-hover hover:text-fg",
          bordered && "border border-line-2 bg-raised",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function RailLink({ href, label, keys, active, children }: { href: string; label: string; keys?: string[]; active?: boolean; children: ReactNode }) {
  return (
    <Tooltip content={label} keys={keys} side="right">
      <Link
        href={href}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex h-9 w-10 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-hover hover:text-fg",
          active && "bg-hover text-fg",
        )}
      >
        {children}
      </Link>
    </Tooltip>
  );
}
