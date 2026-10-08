"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { Kbd } from "@/components/ui/kbd";
import { Sheet } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { useWsMembers } from "@/features/workspace/queries";
import type { NotificationTab } from "@/lib/api/endpoints";
import { isApiError } from "@/lib/api/errors";
import type { Notification, User } from "@/lib/api/types";
import { useHotkeys } from "@/lib/hooks/use-hotkeys";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { groupByDay } from "./events";
import { AlertIcon, CheckIcon, DoubleCheckIcon } from "./icons";
import { NotificationRow } from "./notification-row";
import { PreviewContent } from "./preview";
import { allUnreadIds, useInbox, useMarkAllRead, useSetRead, useUnreadAgain } from "./queries";

const TABS: { value: NotificationTab; label: string; count: "all" | "mentions" | "assigned" }[] = [
  { value: "all", label: "All", count: "all" },
  { value: "mentions", label: "Mentions", count: "mentions" },
  { value: "assigned", label: "Assigned", count: "assigned" },
];

/** Re-renders every minute so relative times ("12m") stay fresh. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function Inbox() {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const now = useNow();

  const [tab, setTab] = useState<NotificationTab>("all");
  const inbox = useInbox(tab, ws.id);
  const setRead = useSetRead(ws.id);
  const markAll = useMarkAllRead(ws.id);
  const unreadAgain = useUnreadAgain(ws.id);
  const { data: memberList = [] } = useWsMembers(ws.slug);
  const members = useMemo(() => {
    const m = new Map<string, User>(memberList.map((x) => [x.userId, x.user]));
    m.set(me.id, me);
    return m;
  }, [memberList, me]);
  const actorOf = useCallback((n: Notification) => (n.actorId ? members.get(n.actorId) ?? null : null), [members]);

  const items = useMemo(() => inbox.data?.data ?? [], [inbox.data]);
  const groups = useMemo(() => groupByDay(items, new Date(now)), [items, now]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const counts = inbox.data?.counts;
  const unread = counts?.unread ?? 0;
  const ready = inbox.isSuccess;

  /* ── selection, focus and preview ── */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastShown, setLastShown] = useState<Notification | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const hitRefs = useRef(new Map<string, HTMLButtonElement>());
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = (selectedId && (items.find((n) => n.id === selectedId) ?? (lastShown?.id === selectedId ? lastShown : null))) || null;
  const shown = selected ?? lastShown;
  const open = Boolean(selected);

  // Keep the panel content rendered during the close transition; hide it from AT once closed.
  const [panelVisible, setPanelVisible] = useState(false);
  useEffect(() => {
    if (open) return;
    const id = setTimeout(() => setPanelVisible(false), 250);
    return () => clearTimeout(id);
  }, [open]);

  const focusRow = (id: string) => {
    const el = hitRefs.current.get(id);
    el?.focus({ preventScroll: true });
    el?.closest("li")?.scrollIntoView({ block: "nearest" });
  };

  const openRow = (n: Notification, opts: { focusPanel?: boolean } = {}) => {
    setSelectedId(n.id);
    setLastShown(n);
    setPanelVisible(true);
    setFocusedId(n.id);
    if (!n.readAt) setRead.mutate({ id: n.id, read: true });
    if (opts.focusPanel !== false && !isMobile) requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
  };

  const closePreview = () => {
    const id = selectedId;
    setSelectedId(null);
    if (id && !isMobile) requestAnimationFrame(() => focusRow(id));
  };

  const toggleRead = (n: Notification) => setRead.mutate({ id: n.id, read: !n.readAt });

  /* ── mark all read with Undo ── */
  const [stagger, setStagger] = useState(false);
  const staggerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(staggerTimer.current), []);

  const markAllRead = async () => {
    if (!ready || unread === 0 || markAll.isPending) return;
    let ids: string[];
    try {
      ids = await allUnreadIds(qc, ws.id);
    } catch {
      toast.error("Couldn’t mark all as read");
      return;
    }
    if (ids.length === 0) return;
    setStagger(true);
    clearTimeout(staggerTimer.current);
    staggerTimer.current = setTimeout(() => setStagger(false), 900);
    markAll.mutate(ids, {
      onSuccess: (res) => {
        const changed = res.ids.length ? res.ids : ids;
        toast({
          id: "nb-mark-all",
          title: `${changed.length} marked read`,
          tone: "success",
          duration: 4200,
          action: { label: "Undo", onClick: () => unreadAgain.mutate(changed) },
        });
      },
    });
  };

  /* ── keyboard ── */
  const move = (delta: 1 | -1) => {
    if (flat.length === 0) return;
    const active = document.activeElement;
    const inList = Boolean(active && listRef.current?.contains(active));
    const anchor = inList ? focusedId : (selectedId ?? focusedId);
    const i = anchor ? flat.findIndex((n) => n.id === anchor) : -1;
    const next = flat[i < 0 ? (delta === 1 ? 0 : flat.length - 1) : Math.max(0, Math.min(flat.length - 1, i + delta))]!;
    setFocusedId(next.id);
    focusRow(next.id);
    if (open && !isMobile && next.id !== selectedId) openRow(next, { focusPanel: false });
  };

  const toggleTarget = () => {
    const active = document.activeElement;
    const inPanel = Boolean(active && panelRef.current?.contains(active));
    const id = inPanel ? selectedId : (focusedId ?? selectedId);
    return id ? items.find((n) => n.id === id) : undefined;
  };

  const navKeysAllowed = () => {
    const a = document.activeElement;
    return !a || a === document.body || a.id === "main" || Boolean(listRef.current?.contains(a) || panelRef.current?.contains(a) || rootRef.current?.contains(a));
  };
  useHotkeys(
    {
      j: () => move(1),
      k: () => move(-1),
      arrowdown: () => navKeysAllowed() && move(1),
      arrowup: () => navKeysAllowed() && move(-1),
      e: () => {
        const n = toggleTarget();
        if (n) toggleRead(n);
      },
      "shift+e": () => void markAllRead(),
      ...(open ? { escape: () => closePreview() } : {}),
    },
    ready,
  );

  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      closePreview();
    }
    if (e.key === "Enter" && e.target === e.currentTarget && (shown?.taskKey || shown?.type === "access")) {
      const btn = e.currentTarget.querySelector<HTMLButtonElement>("[data-open-task]");
      btn?.click();
    }
  };

  const allRead = ready && (counts?.all ?? 0) > 0 && unread === 0;
  const tabIndex = TABS.findIndex((t) => t.value === tab);
  const settingsHref = routes.settings(ws.slug, "notifications");

  const preview = shown && (
    <PreviewContent
      n={shown}
      actor={actorOf(shown)}
      me={me}
      members={members}
      slug={ws.slug}
      phone={isMobile}
      onClose={closePreview}
      onToggleRead={() => toggleRead(shown)}
      onOpenTask={(href) => router.push(href)}
    />
  );

  return (
    <div ref={rootRef} className="flex h-full min-h-0">
      <section aria-labelledby="nb-heading" className="flex min-w-0 flex-1 flex-col bg-bg">
        {/* Top bar */}
        <div className="flex h-[52px] flex-none items-center gap-2 border-b border-line pl-5 pr-3 max-[760px]:pl-4 max-[760px]:pr-2">
          <h1 id="nb-heading" className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
            Inbox
          </h1>
          {unread > 0 && (
            <span
              aria-label={`${unread} unread`}
              className="inline-flex h-[18px] items-center rounded-full bg-accent-s px-1.5 font-mono text-[11px] font-medium text-accent-t"
            >
              {unread}
            </span>
          )}
          <span className="flex-1" />
          <span role="status" aria-live="polite" className="contents">
            {allRead && (
              <span className="inline-flex animate-[fade-in_220ms_var(--ease)] items-center gap-1.5 px-2 text-[12px] text-fg-3">
                <CheckIcon size={14} className="text-ok" />
                All read
              </span>
            )}
          </span>
          {ready && unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void markAllRead()}
              aria-label="Mark all read"
              aria-keyshortcuts="Shift+E"
              className="max-[760px]:size-11 max-[760px]:px-0"
            >
              <DoubleCheckIcon />
              <span className="max-[760px]:hidden">Mark all read</span>
              <span className="max-[760px]:hidden">
                <Kbd>⇧E</Kbd>
              </span>
            </Button>
          )}
          <Button variant="ghost" size="sm" icon asChild className="max-[760px]:size-11">
            <Link href={settingsHref} aria-label="Notification settings" title="Notification settings">
              <Settings size={15} strokeWidth={1.5} aria-hidden />
            </Link>
          </Button>
        </div>

        {/* Tabs */}
        <div
          role="tablist"
          aria-label="Filter"
          className="relative flex flex-none border-b border-line px-3 [--tabw:112px] max-[760px]:[--tabw:121px]"
        >
          {TABS.map((t, i) => {
            const on = t.value === tab;
            const c = ready ? counts?.[t.count] : undefined;
            return (
              <button
                key={t.value}
                id={`nb-tab-${t.value}`}
                role="tab"
                type="button"
                aria-selected={on}
                aria-controls="nb-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => setTab(t.value)}
                onKeyDown={(e) => {
                  const n = TABS.length;
                  let next = -1;
                  if (e.key === "ArrowRight") next = (i + 1) % n;
                  if (e.key === "ArrowLeft") next = (i - 1 + n) % n;
                  if (e.key === "Home") next = 0;
                  if (e.key === "End") next = n - 1;
                  if (next >= 0) {
                    e.preventDefault();
                    setTab(TABS[next]!.value);
                    document.getElementById(`nb-tab-${TABS[next]!.value}`)?.focus();
                  }
                }}
                className={cn(
                  "inline-flex h-[38px] w-[var(--tabw)] flex-none items-center justify-center gap-[7px] rounded-t-sm text-[13px] font-medium text-fg-2 transition-colors duration-[var(--dur-fast)] hover:text-fg",
                  "max-[760px]:h-11 [@media(hover:none)]:h-11",
                  on && "text-fg",
                )}
              >
                {t.label}
                <span className="font-mono text-[11px] text-fg-3">{c ?? "–"}</span>
              </button>
            );
          })}
          <span
            aria-hidden
            className="absolute -bottom-px left-3 h-0.5 w-[var(--tabw)] rounded-[2px] bg-accent transition-transform duration-[220ms] ease-spring"
            style={{ transform: `translateX(calc(${tabIndex} * var(--tabw)))` }}
          />
        </div>

        {/* Body */}
        <div
          ref={listRef}
          id="nb-panel"
          role="tabpanel"
          aria-labelledby={`nb-tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 pt-1"
        >
          {inbox.isPending ? (
            <InboxSkeleton />
          ) : inbox.isError ? (
            <InboxError status={isApiError(inbox.error) ? inbox.error.status : 503} retrying={inbox.isFetching} onRetry={() => void inbox.refetch()} />
          ) : flat.length === 0 ? (
            <InboxEmpty settingsHref={settingsHref} />
          ) : (
            groups.map((g) => (
              <section key={g.id} aria-labelledby={`nb-g-${g.id}`}>
                <h2
                  id={`nb-g-${g.id}`}
                  className="m-0 flex items-center gap-2 px-3 pb-1.5 pt-3.5 font-mono text-[11px] font-medium uppercase leading-none tracking-[.07em] text-fg-3"
                >
                  {g.label}
                  <span className="tracking-normal">{g.items.length}</span>
                </h2>
                <ul role="list" className="m-0 flex list-none flex-col p-0">
                  {g.items.map((n) => (
                    <NotificationRow
                      key={n.id}
                      ref={(el) => {
                        if (el) hitRefs.current.set(n.id, el);
                        else hitRefs.current.delete(n.id);
                      }}
                      n={n}
                      actor={actorOf(n)}
                      selected={n.id === selectedId}
                      stagger={stagger ? flat.indexOf(n) : null}
                      now={now}
                      onOpen={() => openRow(n)}
                      onToggleRead={() => toggleRead(n)}
                      onFocusRow={() => setFocusedId(n.id)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </section>

      {/* Preview: 380px side panel on desktop, bottom sheet on phones */}
      {isMobile ? (
        <Sheet
          open={open}
          onOpenChange={(o) => !o && closePreview()}
          title={shown?.taskKey ? `Preview ${shown.taskKey}` : "Notification preview"}
          height="auto"
          className="max-h-[84dvh]"
        >
          {preview}
        </Sheet>
      ) : (
        <aside
          aria-label="Notification preview"
          aria-hidden={!open || undefined}
          className={cn(
            "flex-none overflow-hidden bg-surface transition-[width] duration-[250ms] ease-out motion-reduce:transition-none",
            open ? "w-[380px] border-l border-line" : "w-0",
          )}
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            role="region"
            aria-labelledby="nb-preview-title"
            onKeyDown={onPanelKey}
            className="flex h-full w-[380px] flex-col outline-none"
            style={{ visibility: open || panelVisible ? "visible" : "hidden" }}
          >
            {preview}
          </div>
        </aside>
      )}
    </div>
  );
}

/* ───────────── States ───────────── */

const SK = [
  { dot: 1, w1: 46, w2: 70 },
  { dot: 1, w1: 38, w2: 58 },
  { dot: 0, w1: 52, w2: 64 },
  { dot: 1, w1: 30, w2: 74, sys: true },
  { dot: 0, w1: 44, w2: 52 },
  { dot: 0, w1: 36, w2: 66 },
];

function InboxSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading inbox">
      <div className="px-3 pb-2 pt-3.5">
        <Skeleton className="h-2.5 w-[52px]" />
      </div>
      {SK.map((r, i) => (
        <div key={i} className="grid h-[60px] grid-cols-[12px_36px_1fr_28px] items-center gap-x-2.5 py-2 pl-2.5 pr-3.5 max-[760px]:h-[68px]">
          <span className="flex justify-center">
            <Skeleton className="size-2 rounded-full" style={{ opacity: r.dot }} />
          </span>
          <span className="flex justify-center">
            <Skeleton className={cn("size-[30px]", r.sys ? "rounded-md" : "rounded-full")} />
          </span>
          <span className="flex flex-col gap-[7px]">
            <Skeleton className="h-[11px]" style={{ width: `${r.w1}%` }} />
            <Skeleton className="h-2.5" style={{ width: `${r.w2}%` }} />
          </span>
          <Skeleton className="h-[9px] w-6" />
        </div>
      ))}
    </div>
  );
}

function CenterIcon({ children, pop }: { children: ReactNode; pop?: boolean }) {
  return (
    <span
      className={cn(
        "relative flex size-[52px] items-center justify-center rounded-full border-[1.5px] border-line-2 bg-surface",
        pop && "animate-[checkpop_320ms_var(--spring)]",
      )}
    >
      {children}
    </span>
  );
}

const SPARKS: [number, number][] = [
  [0, -34],
  [30, -16],
  [30, 17],
  [0, 34],
  [-30, 17],
  [-30, -16],
];

function InboxEmpty({ settingsHref }: { settingsHref: string }) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-2.5 p-6 text-center">
      <span className="relative">
        <CenterIcon pop>
          <CheckIcon size={22} className="text-ok" />
        </CenterIcon>
        {SPARKS.map(([x, y], i) => (
          <span
            key={i}
            aria-hidden
            className="absolute left-1/2 top-1/2 -ml-0.5 -mt-0.5"
            style={{ transform: `translate(${x}px, ${y}px)` }}
          >
            <span className="block size-1 rounded-full bg-spark opacity-0 animate-[spark_640ms_var(--ease)_120ms_both]" />
          </span>
        ))}
      </span>
      <h2 className="m-0 mt-1.5 text-[15px] font-semibold">All caught up</h2>
      <p className="m-0 text-[13px] text-fg-3">New activity on your tasks lands here.</p>
      <Button variant="secondary" size="sm" asChild>
        <Link href={settingsHref}>Notification settings</Link>
      </Button>
    </div>
  );
}

function InboxError({ status, onRetry, retrying }: { status: number; onRetry: () => void; retrying: boolean }) {
  return (
    <div role="alert" className="flex min-h-[240px] flex-col items-center justify-center gap-2.5 p-6 text-center">
      <CenterIcon>
        <span className="text-danger">
          <AlertIcon />
        </span>
      </CenterIcon>
      <h2 className="m-0 mt-1.5 text-[15px] font-semibold">Couldn’t load inbox</h2>
      <p className="m-0 font-mono text-[11px] text-fg-3">{status || 503} · notifications service</p>
      <Button variant="secondary" size="sm" onClick={onRetry} loading={retrying}>
        Retry
      </Button>
    </div>
  );
}
