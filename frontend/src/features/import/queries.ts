"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { ImportColumnMapping, ImportJob, ImportMapping, ImportTaskType } from "@/lib/api/types";
import { createStore } from "@/lib/utils/store";
import { isActiveStatus, isTerminalStatus } from "./import-lib";

/*
 * Board 40 queries (§6.4). The server owns the job: no optimistic job state. Progress is polled
 * every 1 s while queued / running and the tab is visible, and refetched on focus otherwise.
 */

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

export function useImportJob(id: string | null) {
  return useQuery({
    queryKey: qk.importJob(id ?? ""),
    queryFn: () => api.imports.get(id!),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s && isActiveStatus(s) && visible() ? 1000 : false;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: (count, e) => !(isApiError(e) && (e.status === 403 || e.status === 404)) && count < 2,
  });
}

export function useImportHistory(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.imports(projectId ?? ""),
    queryFn: () => api.imports.list(projectId!),
    enabled: Boolean(projectId) && enabled,
    staleTime: 10_000,
  });
}

/* ───────── finishing: invalidation once per job, toast when the wizard is closed ───────── */

const handled = new Set<string>();

/** §6.3: a job reached a terminal state → refresh everything the import touched, once. */
export function invalidateAfterImport(qc: QueryClient, job: Pick<ImportJob, "id" | "projectId">, slug: string) {
  if (handled.has(job.id)) return false;
  handled.add(job.id);
  void qc.invalidateQueries({ queryKey: qk.scope(job.projectId) });
  void qc.invalidateQueries({ queryKey: ["project", slug] });
  void qc.invalidateQueries({ queryKey: qk.projects(slug) });
  void qc.invalidateQueries({ queryKey: qk.views(slug) });
  void qc.invalidateQueries({ queryKey: qk.imports(job.projectId) });
  void qc.invalidateQueries({ queryKey: ["notifications"] });
  return true;
}

/** Jobs started in this tab that should toast when they finish while the wizard is closed. */
export const watchedImports = createStore<string[]>([]);
export const watchImport = (id: string) => watchedImports.set((l) => (l.includes(id) ? l : [...l, id]));
export const unwatchImport = (id: string) => watchedImports.set((l) => l.filter((x) => x !== id));

/** Runs the §6.3 invalidation when `job` is seen in a terminal state after a start. */
export function useImportFinished(job: ImportJob | undefined, slug: string, onFinish?: (job: ImportJob) => void) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!job || !isTerminalStatus(job.status) || !job.startedAt) return;
    if (invalidateAfterImport(qc, job, slug)) onFinish?.(job);
  }, [job, qc, slug, onFinish]);
}

/* ───────── mapping: local state at once, one PUT in flight, 300 ms debounce, latest wins ───────── */

export type LocalMapping = {
  columns: ImportColumnMapping[];
  statuses: Record<string, string | null>;
  types: Record<string, ImportTaskType | null>;
  people: Record<string, string | null>;
};

/** Explicit choices = value rows the server didn't suggest (auto false); suggestions stay implicit. */
export function localFromJob(job: ImportJob): LocalMapping {
  const v = job.validation?.values;
  const explicit = <T,>(rows: { key: string; target: string | null; auto: boolean }[] | undefined) =>
    Object.fromEntries((rows ?? []).filter((r) => !r.auto).map((r) => [r.key, r.target])) as Record<string, T | null>;
  return {
    columns: job.mapping?.columns ?? [],
    statuses: explicit<string>(v?.statuses),
    types: explicit<ImportTaskType>(v?.types),
    people: explicit<string>(v?.people),
  };
}

export function useSaveMapping(job: ImportJob) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<LocalMapping>(() => localFromJob(job));
  const [saving, setSaving] = useState(false);
  const s = useRef({ timer: undefined as ReturnType<typeof setTimeout> | undefined, inFlight: false, again: false, lastSent: job.mapping?.revision ?? 0, latest: local });

  const flush = async () => {
    const st = s.current;
    if (st.inFlight) {
      st.again = true;
      return;
    }
    st.inFlight = true;
    setSaving(true);
    const revision = st.lastSent + 1;
    const body: ImportMapping = { revision, ...st.latest };
    st.lastSent = revision;
    try {
      const next = await api.imports.saveMapping(job.id, body);
      qc.setQueryData(qk.importJob(job.id), next);
    } catch (e) {
      if (isApiError(e) && e.code === "mapping_conflict" && e.details?.current) {
        // Another tab saved a newer mapping: adopt it.
        const current = e.details.current as ImportJob;
        qc.setQueryData(qk.importJob(job.id), current);
        st.lastSent = current.mapping?.revision ?? st.lastSent;
        st.latest = localFromJob(current);
        st.again = false;
        setLocal(st.latest);
        toast.info("This import was changed in another tab", { body: "Showing the latest mapping." });
      } else {
        toast.error("Couldn’t save the mapping", { body: errorMessage(e) });
      }
    } finally {
      st.inFlight = false;
      if (st.again) {
        st.again = false;
        void flush();
      } else setSaving(false);
    }
  };

  const update = (next: LocalMapping) => {
    setLocal(next);
    s.current.latest = next;
    clearTimeout(s.current.timer);
    s.current.timer = setTimeout(() => void flush(), 300);
  };

  useEffect(() => () => clearTimeout(s.current.timer), []);
  return { local, update, saving };
}

export function useImportRows(job: ImportJob | undefined) {
  const revision = job?.mapping?.revision ?? 0;
  return useQuery({
    queryKey: qk.importRows(job?.id ?? "", "all", revision),
    queryFn: () => api.imports.rows(job!.id, { limit: 5 }),
    enabled: Boolean(job && job.status === "ready"),
    placeholderData: (prev) => prev,
  });
}

export function useStartImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.imports.start(id),
    onSuccess: (job) => {
      qc.setQueryData(qk.importJob(job.id), job);
      void qc.invalidateQueries({ queryKey: qk.imports(job.projectId) });
      watchImport(job.id);
    },
  });
}

export function useCancelImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.imports.cancel(id),
    onSuccess: (job) => {
      qc.setQueryData(qk.importJob(job.id), job);
      void qc.invalidateQueries({ queryKey: qk.imports(job.projectId) });
    },
  });
}

/** I8 then a hidden <a download> click (the URL is short-lived; no token is ever in it). */
export async function downloadErrorReport(id: string) {
  try {
    const { url, fileName } = await api.imports.errorReport(id);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    toast.error("Couldn’t download the report", { body: errorMessage(e) });
  }
}
