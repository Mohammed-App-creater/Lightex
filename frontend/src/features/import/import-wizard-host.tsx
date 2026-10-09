"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { qk } from "@/lib/api/query-keys";
import type { Project } from "@/lib/api/types";
import { lazyWithPreload, whenIdle } from "@/lib/hooks/lazy-with-preload";
import { useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { pushUrl } from "@/lib/routes";
import { canImportInto, importNotificationText, isTerminalStatus } from "./import-lib";
import { invalidateAfterImport, unwatchImport, useImportJob, watchedImports } from "./queries";

/*
 * Board 40: hosts the import wizard on every project view (`?import=new|<jobId>`, §6.5). The wizard
 * is code-split (lazyWithPreload) and warmed at idle when an entry point renders. The watcher keeps
 * polling jobs started in this tab after the wizard closes and toasts when they finish (§6.4).
 */

const { Component: ImportWizard, preload: preloadImportWizard } = lazyWithPreload(() => import("./import-wizard").then((m) => m.ImportWizard));

/** Entry points call this so the first open renders without a Suspense fallback. */
export function useWarmImportWizard(enabled = true) {
  useEffect(() => (enabled ? whenIdle(preloadImportWizard, 3000) : undefined), [enabled]);
}

/** Opens the wizard on the current view (query-string only: pushUrl, never router.push). */
export function openImportWizard() {
  const sp = new URLSearchParams(window.location.search);
  sp.set("import", "new");
  pushUrl(`${window.location.pathname}?${sp.toString()}`);
}

/**
 * "Import CSV" entry point (board 06 empty state, board 12 checklist). Not rendered unless the
 * viewer holds project.import and task.create on an active project.
 */
export function ImportCsvButton({ project, variant = "ghost", size, className }: { project: Pick<Project, "my_permissions" | "status">; variant?: ButtonProps["variant"]; size?: ButtonProps["size"]; className?: string }) {
  const allowed = canImportInto(project);
  useWarmImportWizard(allowed);
  if (!allowed) return null;
  return (
    <Button variant={variant} size={size} onClick={openImportWizard} className={className}>
      Import CSV
    </Button>
  );
}

export function ImportWizardHost() {
  const search = useSearchParams();
  const pathname = usePathname();
  const project = useCurrentProject();
  const param = search.get("import");
  const close = () => {
    const sp = new URLSearchParams(window.location.search);
    sp.delete("import");
    const qs = sp.toString();
    pushUrl(qs ? `${pathname}?${qs}` : pathname);
  };
  return (
    <>
      <ImportWatcher openId={param} />
      {param && project && <ImportWizard param={param} project={project} onClose={close} />}
    </>
  );
}

const none: string[] = [];

function ImportWatcher({ openId }: { openId: string | null }) {
  const ids = useSyncExternalStore(watchedImports.subscribe, watchedImports.get, () => none);
  return (
    <>
      {ids
        .filter((id) => id !== openId)
        .map((id) => (
          <Watch key={id} id={id} />
        ))}
    </>
  );
}

function Watch({ id }: { id: string }) {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const router = useRouter();
  const q = useImportJob(id);
  const job = q.data;
  useEffect(() => {
    if (q.isError) unwatchImport(id);
    if (!job || !isTerminalStatus(job.status)) return;
    unwatchImport(id);
    if (!invalidateAfterImport(qc, job, ws.slug)) return;
    const project = qc.getQueryData<Project[]>(qk.projects(ws.slug))?.find((p) => p.id === job.projectId);
    const projectKey = project?.key ?? job.result?.firstKey?.split("-")[0] ?? null;
    const t = importNotificationText({
      importStatus: job.status === "completed" ? "completed" : job.status,
      imported: job.result?.imported ?? 0,
      skipped: job.result?.skipped ?? 0,
      projectKey: projectKey ?? undefined,
    });
    toast({
      tone: job.status === "failed" ? "error" : "success",
      title: `${t.lead} · ${t.rest}`,
      action: projectKey ? { label: "View", onClick: () => router.push(`/${ws.slug}/projects/${projectKey}/board?import=${encodeURIComponent(job.id)}`) } : undefined,
    });
  }, [job, q.isError, id, qc, ws.slug, router]);
  return null;
}
