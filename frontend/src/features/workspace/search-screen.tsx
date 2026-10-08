"use client";

import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar, ProjectBadge } from "@/components/ui/avatar";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { StatusGlyph } from "@/components/ui/glyphs";
import { Input } from "@/components/ui/input";
import { FilterPills } from "@/components/ui/tabs";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";

type Kind = "all" | "task" | "project" | "user";

/** The backend caps `limit` at 50, applied per result type (apps/search/views.py). */
const SEARCH_LIMIT = 50;

/** Global search results page (/[workspace]/search?q=). The palette is the fast path; this is the full list. */
export function SearchScreen() {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const kind = (params.get("type") as Kind | null) ?? "all";
  const [draft, setDraft] = useState(q);
  const [prevQ, setPrevQ] = useState(q);
  if (q !== prevQ) {
    setPrevQ(q);
    setDraft(q);
  }

  useEffect(() => {
    const id = setTimeout(() => {
      if (draft.trim() === q) return;
      const sp = new URLSearchParams(params.toString());
      if (draft.trim()) sp.set("q", draft.trim());
      else sp.delete("q");
      router.replace(`${pathname}?${sp}`);
    }, 250);
    return () => clearTimeout(id);
  }, [draft, q, params, pathname, router]);

  const res = useQuery({
    queryKey: qk.search(ws.slug, q, kind),
    queryFn: ({ signal }) => api.search.query(ws.slug, q, kind === "all" ? undefined : [kind], SEARCH_LIMIT, signal),
    enabled: q.length > 0,
  });
  const results = res.data ?? [];
  const counts = { task: results.filter((r) => r.type === "task").length, project: results.filter((r) => r.type === "project").length, user: results.filter((r) => r.type === "user").length };
  // A type that returned the full page may have more matches the server didn't send.
  const capped = { task: counts.task >= SEARCH_LIMIT, project: counts.project >= SEARCH_LIMIT, user: counts.user >= SEARCH_LIMIT };
  const anyCapped = kind === "all" ? capped.task || capped.project || capped.user : results.length >= SEARCH_LIMIT;
  /** Pill label + count; a capped count reads "50+" (FilterPills counts are numbers, so it goes in the label). */
  const pill = (label: string, n: number | undefined, isCapped: boolean) =>
    n !== undefined && isCapped
      ? {
          label: (
            <>
              {label} <span className="font-mono text-[11px] font-medium text-fg-3">{n}+</span>
            </>
          ),
          count: undefined,
        }
      : { label, count: n };
  const setKind = (k: Kind) => {
    const sp = new URLSearchParams(params.toString());
    if (k === "all") sp.delete("type");
    else sp.set("type", k);
    router.replace(`${pathname}?${sp}`);
  };

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-8 pb-16 pt-7 max-[760px]:px-4">
      <h1 className="m-0 text-h3">Search</h1>
      <Input
        autoFocus
        inputSize="lg"
        type="search"
        aria-label="Search tasks, projects and people"
        placeholder="Search tasks, projects and people…"
        leading={<Search size={15} aria-hidden />}
        value={draft}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
      />
      <FilterPills
        label="Result type"
        value={kind}
        onChange={setKind}
        items={[
          { value: "all", ...pill("All", q ? results.length : undefined, anyCapped) },
          { value: "task", ...pill("Tasks", q && kind === "all" ? counts.task : undefined, capped.task) },
          { value: "project", ...pill("Projects", q && kind === "all" ? counts.project : undefined, capped.project) },
          { value: "user", ...pill("People", q && kind === "all" ? counts.user : undefined, capped.user) },
        ]}
      />
      {!q ? (
        <EmptyState icon={<Search size={20} aria-hidden />} title="Search everything" body="Find tasks by key or title, projects by name, and people by name or email. Press ⌘K anywhere for the quick palette." />
      ) : res.isPending ? (
        <SkeletonRows rows={6} label="Searching" />
      ) : res.isError ? (
        <ErrorState title="Search is unavailable" onRetry={() => void res.refetch()} />
      ) : results.length === 0 ? (
        <EmptyState icon={<Search size={20} aria-hidden />} title={`No results for “${q}”`} body="Try a task key like PRJ-42, or fewer words." />
      ) : (
        <>
          {anyCapped && (
            <p role="status" className="m-0 -mb-2 text-[12px] text-fg-3">
              Showing the first {SEARCH_LIMIT} matches{kind === "all" ? " of each type" : ""}. Add words to narrow it down.
            </p>
          )}
          <ul role="list" aria-label="Results" className="m-0 flex list-none flex-col divide-y divide-line rounded-lg border border-line bg-surface p-0">
            {results.map((r) => {
              if (r.type === "task")
                return (
                  <li key={`t-${r.task.id}`}>
                    <Link href={`${routes.project(ws.slug, r.projectKey, "board")}?task=${r.task.key}`} className="flex h-12 items-center gap-3 px-4 hover:bg-hover">
                      <StatusGlyph kind={r.status.glyph} label={r.status.name} />
                      <span className="w-[60px] font-mono text-[12px] text-fg-3">{r.task.key}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{r.task.title}</span>
                      <span className="text-meta text-fg-3">{r.projectName}</span>
                    </Link>
                  </li>
                );
              if (r.type === "project")
                return (
                  <li key={`p-${r.project.id}`}>
                    <Link href={routes.project(ws.slug, r.project.key)} className="flex h-12 items-center gap-3 px-4 hover:bg-hover">
                      <ProjectBadge code={r.project.key.slice(0, 2)} hue={r.project.hue} size={22} />
                      <span className="min-w-0 flex-1 truncate font-medium">{r.project.name}</span>
                      <span className="text-meta text-fg-3">{r.project.openTaskCount} open</span>
                    </Link>
                  </li>
                );
              return (
                <li key={`u-${r.user.id}`}>
                  <Link href={`${routes.myTasks(ws.slug)}?assignee=${r.user.id}`} className="flex h-12 items-center gap-3 px-4 hover:bg-hover">
                    <Avatar name={r.user.name} hue={r.user.hue} size={24} decorative />
                    <span className="min-w-0 flex-1 truncate font-medium">{r.user.name}</span>
                    <span className="font-mono text-[11px] text-fg-3">{r.user.email}</span>
                    <span className="text-meta text-fg-3">{r.roleName}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
