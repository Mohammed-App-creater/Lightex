"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { StatusGlyph, glyphLabel, type GlyphKind } from "@/components/ui/glyphs";
import { useProjectMembers } from "@/features/projects/queries";
import { activityActorName, activityText } from "@/features/tasks/activity-text";
import { ActorAvatar } from "./audit-parts";
import { useWsMembers } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { ActivityEntry, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

/*
 * Activity feed (board 31 "Project activity"): a redesign of the overview / home activity lists.
 * Grouped by day with sticky day labels, a timeline rail, filter chips (All · Status · Comments ·
 * Members) and "Show older" cursor paging. Shared by project overview and workspace home; drop in
 * <ProjectActivityFeed projectId=… /> or <WorkspaceActivityFeed slug=… />.
 */

export type ActivityCategory = "all" | "status" | "comment" | "member";

const CHIPS: { key: ActivityCategory; label: string }[] = [
  { key: "all", label: "All" },
  { key: "status", label: "Status" },
  { key: "comment", label: "Comments" },
  { key: "member", label: "Members" },
];

export function activityCategory(a: Pick<ActivityEntry, "verb">): Exclude<ActivityCategory, "all"> | "other" {
  if (a.verb === "status_changed") return "status";
  if (a.verb === "commented") return "comment";
  if (a.verb === "member_added") return "member";
  return "other";
}

const GLYPH_BY_NAME: Record<string, GlyphKind> = Object.fromEntries(
  (Object.keys(glyphLabel) as GlyphKind[]).map((k) => [glyphLabel[k].toLowerCase(), k]),
);

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today", "Yesterday", or "Mon, Oct 5" (local calendar day). */
export function dayLabel(iso: string, now = new Date()) {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${WEEKDAY[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`;
}

/** Groups entries (already newest first) by local day, keeping order. */
export function groupByDay<T extends { createdAt: string }>(items: T[], now = new Date()) {
  const out: { label: string; items: T[] }[] = [];
  for (const it of items) {
    const label = dayLabel(it.createdAt, now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(it);
    else out.push({ label, items: [it] });
  }
  return out;
}

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function Key({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-xs border border-line bg-raised px-[5px] py-0.5 font-mono text-[12px] font-medium leading-none text-fg">
      {children}
    </span>
  );
}

/** Sentence body: "<b>Jordan</b> moved <PRJ-44> to ◔ In review". */
function Sentence({ a, actor }: { a: ActivityEntry; actor: string }) {
  const first = <b className="font-semibold text-fg">{actor}</b>;
  if (a.verb === "status_changed" && a.taskKey) {
    const to = String(a.data.to ?? "");
    const glyph = GLYPH_BY_NAME[to.toLowerCase()];
    return (
      <>
        {first} moved <Key>{a.taskKey}</Key> to{" "}
        <span className="inline-flex items-center gap-[5px] align-[-2px] font-medium text-fg">
          {glyph && <StatusGlyph kind={glyph} />}
          {to || "a new status"}
        </span>
      </>
    );
  }
  if (a.verb === "commented" && a.taskKey) {
    const quote = typeof a.data.quote === "string" ? a.data.quote : null;
    return (
      <>
        {first} commented on <Key>{a.taskKey}</Key>
        {quote && (
          <span className="mt-1 block truncate rounded-[7px] border-l-2 border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] leading-[18px] text-fg-2">
            {quote}
          </span>
        )}
      </>
    );
  }
  if (a.taskKey) {
    const text = activityText(a, "\u0000");
    const [before, after] = text.includes("\u0000") ? text.split("\u0000") : [text, ""];
    return (
      <>
        {first} {before}
        {text.includes("\u0000") ? <Key>{a.taskKey}</Key> : <> <Key>{a.taskKey}</Key></>}
        {after}
      </>
    );
  }
  return (
    <>
      {first} {activityText(a)}
    </>
  );
}

export type FeedPerson = Pick<User, "id" | "name" | "hue">;

export function ActivityFeed({
  entries,
  people,
  title = "Activity",
  badge,
  loading,
  error,
  onRetry,
  hasMore,
  loadingMore,
  onMore,
  className,
}: {
  entries: ActivityEntry[];
  people: Map<string, FeedPerson>;
  title?: ReactNode;
  /** Optional leading badge (e.g. a ProjectBadge). */
  badge?: ReactNode;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
  className?: string;
}) {
  const [cat, setCat] = useState<ActivityCategory>("all");
  const count = (k: ActivityCategory) => (k === "all" ? entries.length : entries.filter((a) => activityCategory(a) === k).length);
  const days = useMemo(
    () => groupByDay(entries.filter((a) => cat === "all" || activityCategory(a) === cat)),
    [entries, cat],
  );

  return (
    <section aria-label="Activity" className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface", className)}>
      <div className="flex h-12 flex-none items-center gap-2 pl-4 pr-2.5">
        {badge}
        <h3 className="m-0 text-[13.5px] font-semibold">{title}</h3>
        <span className="flex-1" />
        {!loading && !error && <span className="font-mono text-[11.5px] text-fg-3">{entries.length} events</span>}
      </div>
      <div role="group" aria-label="Show" className="flex flex-none gap-1.5 overflow-x-auto border-b border-line px-3.5 pb-3 [scrollbar-width:none]">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            aria-pressed={cat === c.key}
            onClick={() => setCat(c.key)}
            className={cn(
              "inline-flex h-7 flex-none items-center gap-1.5 whitespace-nowrap rounded-full border border-line-2 px-[11px] text-[12.5px] font-medium text-fg-2",
              "transition-colors duration-150 hover:border-control hover:text-fg max-[760px]:h-9",
              "aria-pressed:border-transparent aria-pressed:bg-accent-s aria-pressed:text-accent-t",
            )}
          >
            {c.label}
            <b className="font-mono text-[11px] font-medium opacity-80">{loading ? "–" : count(c.key)}</b>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-1 [scrollbar-color:var(--line-2)_transparent] [scrollbar-width:thin]">
        {loading ? (
          <div role="status" aria-label="Loading activity" className="flex flex-col gap-3 pt-3">
            {[60, 78, 52, 70].map((w, i) => (
              <span key={i} className="flex items-center gap-2.5">
                <Skeleton className="size-[26px] rounded-full" />
                <Skeleton style={{ width: `${w}%` }} />
              </span>
            ))}
          </div>
        ) : error ? (
          <ErrorState title="Couldn’t load activity" onRetry={onRetry} className="mt-3" />
        ) : entries.length === 0 ? (
          <div className="flex justify-center py-6">
            <EmptyState align="center" illustration="caught" title="Nothing here yet" body="Activity shows up as the team works." />
          </div>
        ) : (
          <>
            {days.length === 0 && <p className="m-0 py-7 text-center text-fg-3">Nothing here yet</p>}
            {days.map((d) => (
              <div key={d.label}>
                <div className="sticky -top-1 z-[2] flex items-center gap-2 bg-surface pb-2 pt-3 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3 after:h-px after:flex-1 after:bg-line after:content-['']">
                  {d.label}
                </div>
                <ul role="feed" aria-label={`Activity, ${d.label}`} className="relative m-0 list-none p-0 before:absolute before:bottom-3.5 before:left-3 before:top-3.5 before:w-px before:bg-line-2 before:content-['']">
                  {d.items.map((a) => {
                    const p = a.actorId ? people.get(a.actorId) : undefined;
                    const name = activityActorName(a, p?.name);
                    const integration = a.actorKind === "integration";
                    return (
                      <li key={a.id} className="relative grid grid-cols-[26px_minmax(0,1fr)_auto] gap-2.5 py-1.5 animate-[fade-in_220ms_var(--ease)]">
                        <span title={name} className={integration ? "relative flex rounded-[5px] shadow-[0_0_0_3px_var(--surface)]" : "relative rounded-full shadow-[0_0_0_3px_var(--surface)]"}>
                          {integration ? <ActorAvatar name={name} integration size={26} /> : <Avatar name={name} hue={p?.hue} size={24} decorative ring={false} className="size-[26px]" />}
                        </span>
                        <span className="min-w-0 text-[13px] leading-5 text-fg-2">
                          <Sentence a={a} actor={integration ? name : name.split(" ")[0]!} />
                        </span>
                        <time dateTime={a.createdAt} className="font-mono text-[11.5px] leading-5 text-fg-3">
                          {hhmm(a.createdAt)}
                        </time>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {hasMore && onMore && (
              <div className="flex justify-center pb-1 pt-2">
                <Button variant="ghost" size="sm" loading={loadingMore} onClick={onMore}>
                  Show older
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function useFeed(key: readonly unknown[], fetchPage: (cursor: string | null) => Promise<{ data: ActivityEntry[]; nextCursor: string | null }>) {
  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  return {
    entries: q.data?.pages.flatMap((p) => p.data) ?? [],
    loading: q.isPending,
    error: q.isError && !q.data,
    onRetry: () => void q.refetch(),
    hasMore: q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    onMore: () => void q.fetchNextPage(),
  };
}

/** Project activity (overview). Key nests under qk.activity so existing invalidations refresh it. */
export function ProjectActivityFeed({ projectId, title, badge, className }: { projectId: string; title?: ReactNode; badge?: ReactNode; className?: string }) {
  const feed = useFeed([...qk.activity(projectId), "feed"], (cursor) => api.projects.activity(projectId, { cursor, limit: 20 }));
  const { data: members = [] } = useProjectMembers(projectId);
  const people = useMemo(() => new Map(members.map((m) => [m.userId, m.user] as const)), [members]);
  return <ActivityFeed {...feed} people={people} title={title} badge={badge} className={className} />;
}

/** Workspace activity (home). */
export function WorkspaceActivityFeed({ slug, title, className }: { slug: string; title?: ReactNode; className?: string }) {
  const feed = useFeed([...qk.wsActivity(slug), "feed"], (cursor) => api.workspaces.activity(slug, { cursor, limit: 20 }));
  const { data: members = [] } = useWsMembers(slug);
  const people = useMemo(() => new Map(members.map((m) => [m.userId, m.user] as const)), [members]);
  return <ActivityFeed {...feed} people={people} title={title} className={className} />;
}
