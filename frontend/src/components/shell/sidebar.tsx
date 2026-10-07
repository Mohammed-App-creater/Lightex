"use client";

import { motion } from "motion/react";
import {
  BarChart3,
  Calendar,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  CircleHelp,
  Columns3,
  Filter,
  Flag,
  Inbox,
  ListTodo,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCcw,
  Search,
  Settings,
  Sun,
  Target,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useMemo, useState, type ReactNode } from "react";
import { AppIcon } from "@/components/brand/logo";
import { Avatar, ProjectBadge } from "@/components/ui/avatar";
import { Kbd } from "@/components/ui/kbd";
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
} from "@/components/ui/menu";
import { ProgressRing } from "@/components/ui/feedback";
import { Tooltip } from "@/components/ui/tooltip";
import { useSession } from "@/features/auth/session";
import { useActiveSprint } from "@/features/projects/queries";
import { useProjects, useRoles, useUnreadCount, useWorkspaces, useMyTasks } from "@/features/workspace/queries";
import type { Project, Workspace } from "@/lib/api/types";
import { can, useCan, useCurrentWorkspace } from "@/lib/permissions/can";
import { daysUntil } from "@/lib/domain/progress";
import { routes, useRouteInfo, type ProjectView } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { useModKey } from "@/lib/hooks/use-platform";
import { addDaysISO, todayISO } from "@/lib/utils/dates";
import { shell } from "./shell-state";

const SUB_ITEMS: { view: ProjectView; label: string; icon: ReactNode; gate?: (perms: string[]) => boolean }[] = [
  { view: "board", label: "Board", icon: <Columns3 size={16} strokeWidth={1.6} aria-hidden /> },
  { view: "backlog", label: "Backlog", icon: <ListTodo size={16} strokeWidth={1.6} aria-hidden /> },
  {
    view: "sprints",
    label: "Sprints",
    icon: <RefreshCcw size={16} strokeWidth={1.6} aria-hidden />,
    // People who plan or move work see sprints; read-only viewers don't (board 13).
    gate: (p) => can("sprint.manage", p) || can("task.move", p),
  },
  { view: "objectives", label: "Objectives", icon: <Target size={16} strokeWidth={1.6} aria-hidden /> },
  { view: "milestones", label: "Milestones", icon: <Flag size={16} strokeWidth={1.6} aria-hidden /> },
  { view: "reports", label: "Reports", icon: <BarChart3 size={16} strokeWidth={1.6} aria-hidden />, gate: (p) => can("report.view", p) },
];

export const subItemsFor = (perms: string[]) => SUB_ITEMS.filter((s) => !s.gate || s.gate(perms));

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

function SprintCard({ project, ws, rail, onNavigate }: { project: Project | undefined; ws: string; rail?: boolean; onNavigate?: () => void }) {
  const { data: sprint } = useActiveSprint(project?.id);
  if (!project || !sprint) return null;
  const pct = sprint.progress.percent;
  const left = Math.max(0, daysUntil(sprint.endDate));
  const label = `${sprint.name}, ${pct} percent, ${left} days left. Open board`;
  const href = routes.project(ws, project.key, "board");
  if (rail) {
    return (
      <Tooltip content={`${sprint.name} · ${pct}% · ${left}d left`} side="right">
        <Link href={href} aria-label={label} className="flex h-9 w-10 items-center justify-center rounded-md hover:bg-hover">
          <ProgressRing value={pct} size={24} stroke={4} color="var(--accent-t)" label={sprint.name} />
        </Link>
      </Tooltip>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      onClick={onNavigate}
      className="mb-1.5 flex items-center gap-2.5 rounded-[10px] border border-line bg-bg px-2.5 py-[9px] transition-[border-color,background-color,transform] duration-150 [transition-timing-function:var(--spring)] hover:-translate-y-px hover:border-line-2 hover:bg-raised"
    >
      <ProgressRing value={pct} size={30} stroke={3.5} color="var(--accent-t)" label={sprint.name} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="truncate text-[13px] font-semibold leading-4">{sprint.name}</span>
        <span className="font-mono text-[11px] leading-[14px] text-fg-3">
          {pct}% · {left}d left
        </span>
      </span>
      <ChevronRight size={14} className="text-fg-3" aria-hidden />
    </Link>
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
        {can("workspace.update", current.my_permissions) && (
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
            await signOut();
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
  const canCreateProject = useCan("project.create");
  const canManageMembers = useCan("workspace.manage_members");
  const canCreateTask = projects.some((p) => can("task.create", p.my_permissions));
  const [pinnedOpen, setPinnedOpen] = useState(true);
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
  const bugCount = openMine.filter((t) => t.type === "bug").length;
  const weekAhead = addDaysISO(todayISO(), 7);
  const dueCount = openMine.filter((t) => t.dueDate && t.dueDate <= weekAhead).length;
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
        <RailLink href={routes.myTasks(ws.slug)} label="My tasks" keys={["G", "M"]} active={route.page === "my-tasks"}>
          <CircleCheck size={16} strokeWidth={1.6} aria-hidden />
        </RailLink>
        <span aria-hidden className="my-1.5 h-px w-7 bg-line" />
        {projects.slice(0, 6).map((p) => (
          <RailLink key={p.id} href={routes.project(ws.slug, p.key)} label={p.name} active={route.projectKey === p.key}>
            <ProjectBadge code={p.key.slice(0, 2)} hue={p.hue} size={22} />
          </RailLink>
        ))}
        <span className="flex-1" />
        <SprintCard project={activeProject} ws={ws.slug} rail />
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
            shell.openCreateTask(activeProject && can("task.create", activeProject.my_permissions) ? { projectId: activeProject.id } : {});
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
        <NavItem
          href={routes.myTasks(ws.slug)}
          icon={<CircleCheck size={16} strokeWidth={1.6} aria-hidden />}
          label="My tasks"
          active={route.page === "my-tasks"}
          onNavigate={nav}
          trailing={<span className="font-mono text-[11px] font-medium text-fg-3">{openMine.length}</span>}
        />

        <SectionHeader label="Pinned views" open={pinnedOpen} onToggle={() => setPinnedOpen((o) => !o)} />
        <div className="collapse-rows" data-open={pinnedOpen}>
          <div>
            <NavItem href={routes.myTasks(ws.slug, "bugs")} icon={<Filter size={16} strokeWidth={1.6} aria-hidden />} label="My open bugs" onNavigate={nav} trailing={<span className="font-mono text-[11px] text-fg-3">{bugCount}</span>} />
            <NavItem href={routes.myTasks(ws.slug, "due")} icon={<Calendar size={16} strokeWidth={1.6} aria-hidden />} label="Due this week" onNavigate={nav} trailing={<span className="font-mono text-[11px] text-fg-3">{dueCount}</span>} />
          </div>
        </div>

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
                                  "relative z-[1] flex h-[30px] items-center gap-[9px] rounded-[7px] px-2 text-[13px] font-medium text-fg-2 transition-colors hover:bg-[rgba(128,140,170,.08)] hover:text-fg max-[1023px]:h-[42px]",
                                  on && "text-fg [&_svg]:text-accent-t",
                                )}
                              >
                                {s.icon}
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
        <SprintCard project={activeProject} ws={ws.slug} onNavigate={nav} />
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
              href={routes.settings(ws.slug, can("workspace.update", ws.my_permissions) ? "general" : "profile")}
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
