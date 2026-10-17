"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { AuditEntry } from "@/lib/api/types";
import { rangeSince, type AuditActionKind, type AuditEntityType, type AuditRange } from "@/lib/audit";

export type AuditFilters = {
  actors: string[];
  action: AuditActionKind | "any";
  entity: AuditEntityType | "any";
  range: AuditRange;
};

export const DEFAULT_FILTERS: AuditFilters = { actors: [], action: "any", entity: "any", range: "30d" };

export const isDefaultFilters = (f: AuditFilters) =>
  f.actors.length === 0 && f.action === "any" && f.entity === "any" && f.range === DEFAULT_FILTERS.range;

function toQuery(f: AuditFilters) {
  return {
    actor: f.actors.length ? f.actors : undefined,
    action: f.action === "any" ? undefined : f.action,
    entity: f.entity === "any" ? undefined : f.entity,
    since: rangeSince(f.range),
  };
}

/** Cursor-paged audit list. Desktop shows one page at a time; mobile shows every loaded page. */
export function useAuditLog(slug: string, enabled: boolean) {
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_FILTERS);
  const [size, setSize] = useState<25 | 50 | 100>(25);
  const [page, setPage] = useState(0);

  const query = useInfiniteQuery({
    queryKey: [...qk.audit(slug), filters, size],
    queryFn: ({ pageParam }) => api.audit.list(slug, { cursor: pageParam, limit: size, filter: toQuery(filters) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });

  const pages = query.data?.pages ?? [];
  const total = pages[0]?.total;
  const current = pages[Math.min(page, Math.max(0, pages.length - 1))]?.data ?? [];
  const all: AuditEntry[] = pages.flatMap((p) => p.data);

  const update = (patch: Partial<AuditFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  const next = async () => {
    if (page + 1 < pages.length) return setPage(page + 1);
    if (!query.hasNextPage) return;
    const r = await query.fetchNextPage();
    if (!r.isError) setPage(page + 1);
  };

  return {
    query,
    filters,
    update,
    reset: () => update(DEFAULT_FILTERS),
    size,
    setSize: (s: 25 | 50 | 100) => {
      setSize(s);
      setPage(0);
    },
    page,
    current,
    all,
    total,
    hasPrev: page > 0,
    hasNext: page + 1 < pages.length || Boolean(query.hasNextPage),
    prev: () => setPage((p) => Math.max(0, p - 1)),
    next,
  };
}

/** Pages through every row matching the filters (export). Capped to keep the browser responsive. */
export async function fetchAllAudit(slug: string, filters: AuditFilters, cap = 5000) {
  const out: AuditEntry[] = [];
  let cursor: string | null = null;
  do {
    const res = await api.audit.list(slug, { cursor, limit: 200, filter: toQuery(filters) });
    out.push(...res.data);
    cursor = res.nextCursor;
  } while (cursor && out.length < cap);
  return out;
}
