"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleAlert, FileText, Inbox, Link2, Moon, Plus, SearchX, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Avatar, ProjectBadge } from "@/components/ui/avatar";
import {
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandScopeChip,
  CommandShell,
} from "@/components/ui/command-shell";
import { Skeleton } from "@/components/ui/feedback";
import { PriorityIcon, StatusGlyph, priorityMeta } from "@/components/ui/glyphs";
import { Kbd } from "@/components/ui/kbd";
import { toast } from "@/components/ui/toast";
import { cycleTheme } from "@/components/shell/global-hotkeys";
import { shell, useShell, type PaletteScope } from "@/components/shell/shell-state";
import { useSession } from "@/features/auth/session";
import { useProjects, useWsMembers, useRoles } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { Project, Status, Task, User } from "@/lib/api/types";
import { useIsCompact } from "@/lib/hooks/use-media-query";
import { can, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes, useRouteInfo, type ProjectView } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";

type Action = {
  id: string;
  label: string;
  keys: string[];
  icon: ReactNode;
  run: () => void | Promise<void>;
  /** Hidden unless allowed (permission-gated actions are absent, not disabled). */
  allowed: boolean;
};

type Row =
  | { kind: "task"; id: string; task: Task; projectKey: string; projectName: string; status: Pick<Status, "name" | "glyph"> }
  | { kind: "project"; id: string; project: Project }
  | { kind: "person"; id: string; user: User; role: string }
  | { kind: "action"; id: string; action: Action }
  | { kind: "suggest"; id: string; label: string; symbol: string; run: () => void }
  | { kind: "error"; id: string };

type Section = { id: string; heading: string; rows: Row[] };

const SCOPES: Record<Exclude<PaletteScope, null>, { symbol: string; label: string; placeholder: string }> = {
  cmd: { symbol: ">", label: "Commands", placeholder: "Run a command…" },
  proj: { symbol: "#", label: "Projects", placeholder: "Jump to a project…" },
  people: { symbol: "@", label: "People", placeholder: "Find a person…" },
};

/** Highlight every case-insensitive occurrence of q. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  let idx = lower.indexOf(q);
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={idx} className="bg-transparent font-semibold text-accent-t underline decoration-accent-s decoration-2 underline-offset-[3px]">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return <>{parts}</>;
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function CommandPalette() {
  const { palette, paletteScope } = useShell();
  return palette ? <PaletteInner initialScope={paletteScope} /> : null;
}

function PaletteInner({ initialScope }: { initialScope: PaletteScope }) {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const route = useRouteInfo();
  const { user } = useSession();
  const { theme, setTheme } = useTheme();
  const wide = !useIsCompact();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PaletteScope>(initialScope);
  const [value, setValue] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const { data: projects = [] } = useProjects(ws.slug);
  const { data: members = [] } = useWsMembers(ws.slug);
  const { data: roles = [] } = useRoles(ws.slug);
  const { data: recents = [] } = useQuery({ queryKey: qk.recents(), queryFn: api.search.recents, staleTime: 10_000 });

  const q = query.trim().toLowerCase();
  const dq = useDebounced(q, 120);
  const taskSearch = useQuery({
    queryKey: qk.search(ws.slug, dq, "task"),
    queryFn: ({ signal }) => api.search.query(ws.slug, dq, ["task"], 20, signal),
    enabled: scope === null,
    staleTime: 15_000,
    retry: false,
  });

  const currentProject = projects.find((p) => p.key === route.projectKey) ?? null;
  const goProject = (view: ProjectView) => {
    const p = currentProject ?? projects[0];
    if (p) router.push(routes.project(ws.slug, p.key, view));
  };
  const canCreateAnywhere = projects.some((p) => can("task.create", p.my_permissions));

  const close = () => shell.closePalette();

  const actions: Action[] = useMemo(
    () => [
      {
        id: "create",
        label: "Create task",
        keys: ["C"],
        icon: <Plus size={12} aria-hidden />,
        run: () => shell.openCreateTask(currentProject && can("task.create", currentProject.my_permissions) ? { projectId: currentProject.id } : {}),
        allowed: canCreateAnywhere,
      },
      { id: "board", label: "Go to board", keys: ["G", "B"], icon: <ArrowRight size={12} aria-hidden />, run: () => goProject("board"), allowed: projects.length > 0 },
      {
        id: "theme",
        label: "Switch theme",
        keys: ["⌘", "⇧", "L"],
        icon: <Moon size={12} aria-hidden />,
        run: () => cycleTheme(theme, setTheme),
        allowed: true,
      },
      { id: "sprints", label: "Go to sprints", keys: ["G", "S"], icon: <ArrowRight size={12} aria-hidden />, run: () => goProject("sprints"), allowed: projects.length > 0 },
      { id: "list", label: "Go to list", keys: ["G", "L"], icon: <ArrowRight size={12} aria-hidden />, run: () => goProject("list"), allowed: projects.length > 0 },
      { id: "milestones", label: "Go to milestones", keys: ["G", "M"], icon: <ArrowRight size={12} aria-hidden />, run: () => goProject("milestones"), allowed: projects.length > 0 },
      { id: "objectives", label: "Go to objectives", keys: ["G", "O"], icon: <ArrowRight size={12} aria-hidden />, run: () => goProject("objectives"), allowed: projects.length > 0 },
      { id: "inbox", label: "Go to inbox", keys: ["G", "I"], icon: <Inbox size={12} aria-hidden />, run: () => router.push(routes.inbox(ws.slug)), allowed: true },
      {
        id: "link",
        label: "Copy link",
        keys: [],
        icon: <Link2 size={12} aria-hidden />,
        run: async () => {
          try {
            if (!navigator.clipboard) throw new Error("Clipboard unavailable");
            await navigator.clipboard.writeText(window.location.href);
            toast.success("Link copied");
          } catch {
            toast.error("Couldn’t copy the link. Copy it from the address bar.");
          }
        },
        allowed: true,
      },
      {
        id: "new-project",
        label: "Create project",
        keys: [],
        icon: <Plus size={12} aria-hidden />,
        run: () => router.push(`${routes.home(ws.slug)}?new-project=1`),
        allowed: can("project.create", ws.my_permissions),
      },
      {
        id: "settings",
        label: "Open settings",
        keys: ["⌘", ","],
        icon: <Settings size={12} aria-hidden />,
        run: () => router.push(routes.settings(ws.slug, can("workspace.update", ws.my_permissions) ? "general" : "profile")),
        allowed: true,
      },
      { id: "shortcuts", label: "Keyboard shortcuts", keys: ["?"], icon: <FileText size={12} aria-hidden />, run: () => shell.setShortcuts(true), allowed: true },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, currentProject, theme, ws.slug, canCreateAnywhere],
  );
  const allowedActions = actions.filter((a) => a.allowed);

  const projectByKey = new Map(projects.map((p) => [p.key, p]));
  const people = members.filter((m) => m.status === "active");

  const taskRows: Row[] = (taskSearch.data ?? []).flatMap((r) =>
    r.type === "task" ? [{ kind: "task" as const, id: `t-${r.task.id}`, task: r.task, projectKey: r.projectKey, projectName: r.projectName, status: r.status }] : [],
  );
  const projectRows = (list: Project[]): Row[] => list.map((p) => ({ kind: "project" as const, id: `p-${p.id}`, project: p }));
  const personRows = (list: typeof people): Row[] =>
    list.map((m) => ({ kind: "person" as const, id: `u-${m.userId}`, user: m.user, role: roles.find((r) => r.id === m.roleId)?.name ?? "" }));
  const actionRows = (list: Action[]): Row[] => list.map((a) => ({ kind: "action" as const, id: `a-${a.id}`, action: a }));

  const sections: Section[] = [];
  if (scope === "cmd") {
    sections.push({ id: "cmd", heading: "Commands", rows: actionRows(allowedActions.filter((a) => !q || a.label.toLowerCase().includes(q))) });
  } else if (scope === "proj") {
    sections.push({ id: "proj", heading: "Projects", rows: projectRows(projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q))) });
  } else if (scope === "people") {
    sections.push({
      id: "people",
      heading: "People",
      rows: personRows(people.filter((m) => !q || m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q))),
    });
  } else if (!q) {
    const recentRows: Row[] = [];
    for (const r of recents.slice(0, 3)) {
      if (r.kind === "project") {
        const p = projects.find((x) => x.id === r.id);
        if (p) recentRows.push({ kind: "project", id: `rp-${p.id}`, project: p });
      } else {
        const hit = taskRows.find((t) => t.kind === "task" && t.task.id === r.id);
        if (hit && hit.kind === "task") recentRows.push({ ...hit, id: `r${hit.id}` });
      }
    }
    sections.push({ id: "recent", heading: "Recent", rows: recentRows });
    const recentTaskIds = new Set(recentRows.flatMap((r) => (r.kind === "task" ? [r.task.id] : [])));
    sections.push({ id: "tasks", heading: "Tasks", rows: taskRows.filter((r) => r.kind === "task" && !recentTaskIds.has(r.task.id)).slice(0, 3) });
    sections.push({ id: "projects", heading: "Projects", rows: projectRows(projects) });
    sections.push({ id: "actions", heading: "Actions", rows: actionRows(allowedActions.slice(0, 3)) });
    sections.push({ id: "people", heading: "People", rows: personRows(people.slice(0, 3)) });
  } else {
    sections.push({ id: "tasks", heading: "Tasks", rows: taskSearch.isError ? [{ kind: "error", id: "err" }] : taskRows.slice(0, 4) });
    sections.push({ id: "projects", heading: "Projects", rows: projectRows(projects.filter((p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q))) });
    sections.push({ id: "actions", heading: "Actions", rows: actionRows(allowedActions.filter((a) => a.label.toLowerCase().includes(q)).slice(0, 4)) });
    sections.push({ id: "people", heading: "People", rows: personRows(people.filter((m) => m.user.name.toLowerCase().includes(q)).slice(0, 3)) });
  }
  const visible = sections.filter((s) => s.rows.length > 0);
  const loading = scope === null && q !== "" && (taskSearch.isPending || dq !== q) && !taskSearch.data;
  const empty = visible.length === 0 && !loading;

  // Suggestions for the empty state ("Try").
  const suggestions: Row[] = [];
  if (empty) {
    if (q && canCreateAnywhere && scope !== "cmd")
      suggestions.push({
        kind: "suggest",
        id: "s-create",
        symbol: "+",
        label: `Create task “${query.trim().slice(0, 40)}”`,
        run: () => shell.openCreateTask({ projectId: currentProject?.id, title: query.trim() }),
      });
    if (scope !== "cmd") suggestions.push({ kind: "suggest", id: "s-cmd", symbol: ">", label: "Search commands", run: () => changeScope("cmd") });
    if (scope !== "proj") suggestions.push({ kind: "suggest", id: "s-proj", symbol: "#", label: "Browse projects", run: () => changeScope("proj") });
    if (scope !== "people") suggestions.push({ kind: "suggest", id: "s-people", symbol: "@", label: "Find people", run: () => changeScope("people") });
  }

  const allRows = empty ? suggestions : visible.flatMap((s) => s.rows);
  const active = allRows.find((r) => r.id === value) ?? allRows[0];

  function changeScope(next: PaletteScope) {
    setScope(next);
    setQuery("");
    setValue("");
  }

  function run(row: Row) {
    switch (row.kind) {
      case "task":
        close();
        router.push(`${routes.project(ws.slug, row.projectKey, "board")}?task=${row.task.key}`);
        return;
      case "project":
        close();
        router.push(routes.project(ws.slug, row.project.key, "board"));
        return;
      case "person":
        close();
        router.push(routes.myTasks(ws.slug) + (row.user.id === user?.id ? "" : `?assignee=${row.user.id}`));
        if (row.user.id !== user?.id) toast.info(`Showing ${row.user.name}’s tasks`);
        return;
      case "action":
        close();
        row.action.run();
        return;
      case "suggest":
        if (row.id === "s-create") close();
        row.run();
        return;
      case "error":
        void taskSearch.refetch();
        return;
    }
  }

  const onInputChange = (v: string) => {
    if (scope === null && v.length === 1 && (v === ">" || v === "#" || v === "@")) {
      changeScope(v === ">" ? "cmd" : v === "#" ? "proj" : "people");
      return;
    }
    setQuery(v);
    setValue("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (query) setQuery("");
      else if (scope) changeScope(null);
      else close();
      return;
    }
    // An exact task key opens that task even while results for a shorter query are still on screen
    // (search is debounced, so "PRJ-3" results can linger right after typing "PRJ-33").
    if (e.key === "Enter" && scope === null && !e.nativeEvent.isComposing) {
      const key = /^([a-z]{2,5})-(\d+)$/i.exec(query.trim());
      const project = key && projects.find((p) => p.key === key[1]!.toUpperCase());
      if (key && project && !(active?.kind === "task" && active.task.key === query.trim().toUpperCase())) {
        e.preventDefault();
        e.stopPropagation();
        close();
        router.push(`${routes.project(ws.slug, project.key, "board")}?task=${project.key}-${key[2]}`);
        return;
      }
    }
    if (e.key === "Backspace" && !query && scope) {
      e.preventDefault();
      changeScope(null);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (visible.length < 2) return;
      const idx = visible.findIndex((s) => s.rows.some((r) => r.id === active?.id));
      const next = visible[(idx + (e.shiftKey ? -1 : 1) + visible.length) % visible.length]!;
      setValue(next.rows[0]!.id);
    }
  };

  const verb = active && (active.kind === "action" || active.kind === "suggest" || active.kind === "error") ? "Run" : "Open";
  const placeholder = scope ? SCOPES[scope].placeholder : "Search or type > # @";

  return (
    <CommandShell open onOpenChange={(o) => !o && close()} wide={wide} value={active?.id ?? ""} onValueChange={setValue}>
      <div onKeyDownCapture={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <CommandInput
          value={query}
          onValueChange={onInputChange}
          placeholder={placeholder}
          aria-label="Search tasks, projects, people and commands"
          onBack={close}
          chip={scope ? <CommandScopeChip symbol={SCOPES[scope].symbol} label={SCOPES[scope].label} onClear={() => changeScope(null)} /> : null}
        />
        {!wide && !scope && (
          <div className="flex gap-1.5 overflow-x-auto border-b border-line px-3 py-2">
            {(["cmd", "proj", "people"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => changeScope(s)}
                className="h-8 flex-none rounded-md border border-line-2 bg-raised px-2.5 text-[12.5px] font-medium"
              >
                <b className="mr-1 font-mono text-[12px] font-semibold text-accent-t">{SCOPES[s].symbol}</b>
                {SCOPES[s].label}
              </button>
            ))}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <CommandList ref={listRef} aria-busy={loading || undefined}>
              {loading && <PaletteSkeleton />}
              {!loading &&
                visible.map((s) => (
                  <CommandGroup key={s.id} heading={s.heading} count={s.rows.length}>
                    {s.rows.map((row) => (
                      <PaletteRow key={row.id} row={row} q={q} active={active?.id === row.id} onRun={() => run(row)} wide={wide} />
                    ))}
                  </CommandGroup>
                ))}
              {empty && (
                <>
                  <div role="status" className="flex flex-col items-center gap-2 px-4 pb-2.5 pt-7 text-center">
                    <span className="flex size-10 items-center justify-center rounded-[10px] border border-dashed border-line-2 text-fg-3">
                      <SearchX size={18} aria-hidden />
                    </span>
                    <strong className="max-w-full truncate text-[14px] font-semibold">
                      No results for “{query.trim() || (scope ? SCOPES[scope].label.toLowerCase() : "")}”
                    </strong>
                  </div>
                  <CommandGroup heading="Try">
                    {suggestions.map((row) => (
                      <PaletteRow key={row.id} row={row} q="" active={active?.id === row.id} onRun={() => run(row)} wide={wide} />
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </div>
          {wide && <Preview row={loading ? undefined : active} projectByKey={projectByKey} />}
        </div>
        <CommandFooter verb={verb} />
      </div>
    </CommandShell>
  );
}

function PaletteSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-0.5 px-2 pt-3">
      <span role="status" className="sr-only">
        Searching
      </span>
      <Skeleton className="mb-2 h-2 w-[46px]" />
      {[58, 44, 66].map((w) => (
        <div key={w} className="flex h-9 items-center gap-2.5">
          <Skeleton className="size-3.5 rounded-full" />
          <Skeleton className="h-[9px] w-11" />
          <Skeleton className="h-2.5" style={{ width: `${w}%` }} />
        </div>
      ))}
      <Skeleton className="mb-2 mt-3 h-2 w-[60px]" />
      {[40, 30].map((w) => (
        <div key={w} className="flex h-9 items-center gap-2.5">
          <Skeleton className="h-5 w-[22px] rounded-[5px]" />
          <Skeleton className="h-2.5" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

function PaletteRow({
  row,
  q,
  active,
  onRun,
  wide,
}: {
  row: Row;
  q: string;
  active: boolean;
  onRun: () => void;
  wide: boolean;
}) {
  let lead: ReactNode = null;
  let label: ReactNode = null;
  let meta: ReactNode = null;
  let keys: string[] | null = null;
  switch (row.kind) {
    case "task":
      lead = (
        <>
          <StatusGlyph kind={row.status.glyph} label={row.status.name} />
          <span className="w-[50px] flex-none whitespace-nowrap font-mono text-[11.5px] font-medium text-fg-3">
            <Highlight text={row.task.key} q={q} />
          </span>
        </>
      );
      label = <Highlight text={row.task.title} q={q} />;
      meta = row.status.name;
      break;
    case "project":
      lead = <ProjectBadge code={row.project.key.slice(0, 3)} hue={row.project.hue} size={22} />;
      label = <Highlight text={row.project.name} q={q} />;
      meta = `${row.project.openTaskCount} open`;
      break;
    case "person":
      lead = <Avatar name={row.user.name} hue={row.user.hue} size={20} decorative />;
      label = <Highlight text={row.user.name} q={q} />;
      meta = wide ? <span className="font-mono text-[11px]">{row.user.email}</span> : null;
      break;
    case "action":
      lead = <span className="flex h-5 w-[22px] flex-none items-center justify-center rounded-[5px] border border-line bg-raised text-fg-2">{row.action.icon}</span>;
      label = <Highlight text={row.action.label} q={q} />;
      keys = row.action.keys;
      break;
    case "suggest":
      lead = <span className="flex h-5 w-[22px] flex-none items-center justify-center rounded-[5px] border border-line bg-raised font-mono text-[11px] font-semibold text-fg-2">{row.symbol}</span>;
      label = row.label;
      break;
    case "error":
      lead = <CircleAlert size={14} className="mx-1 text-danger" aria-hidden />;
      label = "Task search unavailable";
      meta = "Retry";
      break;
  }
  return (
    <CommandItem value={row.id} onSelect={onRun}>
      {lead}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta && <span className="whitespace-nowrap text-[12px] text-fg-3">{meta}</span>}
      {wide && keys && keys.length > 0 && (
        <span className="flex gap-[3px]">
          {keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      )}
      {wide && active && <Kbd className="ml-0.5">↵</Kbd>}
    </CommandItem>
  );
}

function Preview({ row, projectByKey }: { row: Row | undefined; projectByKey: Map<string, Project> }) {
  const body = (() => {
    if (!row || row.kind === "error" || row.kind === "suggest")
      return (
        <div className="flex h-full items-center justify-center text-fg-3">
          <FileText size={28} strokeWidth={1.4} aria-hidden />
        </div>
      );
    if (row.kind === "task") {
      const t = row.task;
      return (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-[12px] text-fg-3">{t.key}</span>
            <span className="text-[12px] text-fg-3">· {row.projectName}</span>
          </div>
          <div className="text-[15px] font-semibold leading-[21px] tracking-[-0.01em]">{t.title}</div>
          <dl className="m-0 grid grid-cols-[72px_1fr] gap-y-2.5 border-t border-line pt-3">
            <dt className="text-[11.5px] font-medium text-fg-3">Status</dt>
            <dd className="m-0 flex items-center gap-[7px] font-medium">
              <StatusGlyph kind={row.status.glyph} />
              {row.status.name}
            </dd>
            <dt className="text-[11.5px] font-medium text-fg-3">Priority</dt>
            <dd className="m-0 flex items-center gap-[7px] font-medium">
              <PriorityIcon level={t.priority} />
              {priorityMeta[t.priority].label}
            </dd>
            <dt className="text-[11.5px] font-medium text-fg-3">Due</dt>
            <dd className="m-0 font-medium">{t.dueDate ?? "—"}</dd>
            <dt className="text-[11.5px] font-medium text-fg-3">Comments</dt>
            <dd className="m-0 font-medium">{t.commentCount}</dd>
          </dl>
        </>
      );
    }
    if (row.kind === "project") {
      const p = projectByKey.get(row.project.key) ?? row.project;
      return (
        <>
          <ProjectBadge code={p.key.slice(0, 3)} hue={p.hue} size={36} />
          <div className="text-[15px] font-semibold">{p.name}</div>
          <dl className="m-0 grid grid-cols-[72px_1fr] gap-y-2.5 border-t border-line pt-3">
            <dt className="text-[11.5px] font-medium text-fg-3">Key</dt>
            <dd className="m-0 font-mono font-medium">{p.key}</dd>
            <dt className="text-[11.5px] font-medium text-fg-3">Open</dt>
            <dd className="m-0 font-medium">{p.openTaskCount} tasks</dd>
          </dl>
        </>
      );
    }
    if (row.kind === "person") {
      return (
        <>
          <Avatar name={row.user.name} hue={row.user.hue} size={36} decorative />
          <div className="text-[15px] font-semibold">{row.user.name}</div>
          <dl className="m-0 grid grid-cols-[72px_1fr] gap-y-2.5 border-t border-line pt-3">
            <dt className="text-[11.5px] font-medium text-fg-3">Email</dt>
            <dd className="m-0 truncate font-medium">{row.user.email}</dd>
            <dt className="text-[11.5px] font-medium text-fg-3">Role</dt>
            <dd className="m-0 font-medium">{row.role}</dd>
          </dl>
        </>
      );
    }
    return (
      <>
        <div className="text-[15px] font-semibold">{row.action.label}</div>
        {row.action.keys.length > 0 && (
          <div className="flex gap-1">
            {row.action.keys.map((k) => (
              <Kbd key={k} className="h-6 min-w-6 text-[12px]">
                {k}
              </Kbd>
            ))}
          </div>
        )}
      </>
    );
  })();
  return (
    <aside aria-label="Preview" className={cn("flex w-[300px] flex-none flex-col gap-3.5 border-l border-line bg-bg p-[18px]")}>
      {body}
    </aside>
  );
}

