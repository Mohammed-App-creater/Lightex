"use client";

import { Menu as MenuIcon, Search } from "lucide-react";
import Link from "next/link";
import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProjectBadge } from "@/components/ui/avatar";
import { Kbd } from "@/components/ui/kbd";
import { useProjects } from "@/features/workspace/queries";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes, useRouteInfo } from "@/lib/routes";
import { shell } from "./shell-state";

const VIEW_LABEL: Record<string, string> = {
  overview: "Overview",
  board: "Board",
  list: "List",
  backlog: "Backlog",
  sprints: "Sprints",
  objectives: "Objectives",
  milestones: "Milestones",
  epics: "Epics",
  reports: "Reports",
  settings: "Settings",
};
const PAGE_LABEL: Record<string, string> = {
  home: "Home",
  inbox: "Inbox",
  "my-tasks": "My tasks",
  search: "Search",
  settings: "Settings",
  trash: "Trash",
};

/* Pages put their actions into the top bar through a portal slot. */
const SlotCtx = createContext<HTMLElement | null>(null);

export function TopBarActions({ children }: { children: ReactNode }) {
  const slot = useContext(SlotCtx);
  return slot ? createPortal(children, slot) : null;
}

export function TopBarSlotProvider({ children }: { children: (setSlot: (el: HTMLElement | null) => void) => ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return <SlotCtx.Provider value={slot}>{children(setSlot)}</SlotCtx.Provider>;
}

export function TopBar({ compact, setSlot }: { compact: boolean; setSlot: (el: HTMLElement | null) => void }) {
  const ws = useCurrentWorkspace()!;
  const route = useRouteInfo();
  const { data: projects = [] } = useProjects(ws.slug);
  const project = projects.find((p) => p.key === route.projectKey);

  let crumbs: ReactNode;
  if (route.page === "projects" && route.projectKey) {
    crumbs = (
      <>
        <Link href={routes.project(ws.slug, route.projectKey)} className="flex min-w-0 items-center gap-2 text-fg-2 hover:text-fg">
          {project && <ProjectBadge code={project.key.slice(0, 2)} hue={project.hue} size={18} />}
          <span className="truncate">{project?.name ?? route.projectKey}</span>
        </Link>
        <span className="text-fg-3">/</span>
        <span className="truncate font-semibold text-fg">{VIEW_LABEL[route.view ?? "overview"]}</span>
      </>
    );
  } else if (route.page === "tasks" && route.taskKey) {
    const key = route.taskKey.toUpperCase();
    const p = projects.find((x) => key.startsWith(`${x.key}-`));
    crumbs = (
      <>
        {p && (
          <>
            <Link href={routes.project(ws.slug, p.key, "board")} className="flex min-w-0 items-center gap-2 text-fg-2 hover:text-fg">
              <ProjectBadge code={p.key.slice(0, 2)} hue={p.hue} size={18} />
              <span className="truncate">{p.name}</span>
            </Link>
            <span className="text-fg-3">/</span>
          </>
        )}
        <span className="font-mono text-[12.5px] font-semibold text-fg">{key}</span>
      </>
    );
  } else {
    crumbs = (
      <>
        <span className="truncate text-fg-3 max-[760px]:hidden">{ws.name}</span>
        <span className="text-fg-3 max-[760px]:hidden">/</span>
        <span className="truncate font-semibold text-fg">{PAGE_LABEL[route.page] ?? ""}</span>
      </>
    );
  }

  return (
    <header className="flex h-[52px] flex-none items-center gap-3 border-b border-line px-4 max-[760px]:gap-1 max-[760px]:px-1.5">
      {compact && (
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => shell.setDrawer(true)}
          className="flex size-11 flex-none items-center justify-center rounded-[10px] text-fg-2 hover:bg-hover hover:text-fg"
        >
          <MenuIcon size={18} strokeWidth={1.6} aria-hidden />
        </button>
      )}
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
        {crumbs}
      </nav>
      <div ref={setSlot} className="ml-auto flex min-w-0 items-center gap-1.5" />
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => shell.openPalette()}
        className="flex h-8 w-[260px] flex-none items-center gap-2 rounded-[7px] border border-line-2 bg-raised pl-2.5 pr-1.5 text-[13px] text-fg-3 transition-[border-color,color] duration-[var(--dur-fast)] hover:border-control hover:text-fg-2 max-[1279px]:w-auto max-[760px]:size-11 max-[760px]:justify-center max-[760px]:border-0 max-[760px]:bg-transparent max-[760px]:p-0"
      >
        <Search size={14} strokeWidth={1.6} aria-hidden />
        <span className="flex-1 text-left max-[1279px]:hidden">Search</span>
        <span className="flex gap-0.5 max-[760px]:hidden">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
        <span className="sr-only">Search and commands</span>
      </button>
    </header>
  );
}
