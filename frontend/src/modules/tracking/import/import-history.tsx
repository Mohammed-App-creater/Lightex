"use client";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { useProjectMembers } from "@/features/projects/queries";
import { PanelHeader } from "@/features/settings/project-parts";
import type { ImportJobSummary, ImportStatus, Project } from "@/lib/api/types";
import { pushUrl } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { agoLong } from "@/lib/utils/dates";
import { openImportWizard, useWarmImportWizard } from "./import-wizard-host";
import { STATUS_LABEL, canImportInto, formatKeyRange } from "./import-lib";
import { DownloadGlyph, ImportIcon } from "./parts";
import { downloadErrorReport, useImportHistory } from "./queries";

/*
 * Project settings → Import (board 40 E3, `?tab=import`, last tab): the project's import history
 * (I9: newest first, max 20, drafts excluded) and **New import**. Loading skeleton, empty state,
 * error with Retry.
 */

const TONE: Record<ImportStatus, string> = {
  draft: "text-fg-3 border-line bg-raised",
  ready: "text-fg-2 border-line bg-raised",
  queued: "text-accent-t border-accent-s bg-accent-s",
  running: "text-accent-t border-accent-s bg-accent-s",
  completed: "text-ok border-ok-s bg-ok-s",
  failed: "text-danger border-danger-s bg-danger-s",
  canceled: "text-warn border-warn-s bg-warn-s",
};

function openJob(id: string) {
  const sp = new URLSearchParams(window.location.search);
  sp.set("import", id);
  pushUrl(`${window.location.pathname}?${sp.toString()}`);
}

export function ImportHistoryPanel({ project }: { project: Project }) {
  const q = useImportHistory(project.id);
  const members = useProjectMembers(project.id);
  const canStart = canImportInto(project);
  useWarmImportWizard(canStart);
  const nameOf = (id: string | null) => members.data?.find((m) => m.userId === id)?.user ?? null;

  const newButton = canStart && (
    <Button variant="primary" size="sm" onClick={openImportWizard}>
      <ImportIcon size={13} />
      New import
    </Button>
  );

  return (
    <section aria-labelledby="ps-import-title" className="flex flex-col">
      <h2 id="ps-import-title" className="sr-only">
        Import
      </h2>
      <PanelHeader title="Imports" count={q.data?.length}>
        {newButton}
      </PanelHeader>
      <p className="m-0 mb-4 text-[13px] leading-5 text-fg-2">Bring tasks in from a CSV, or a Jira, Linear or Asana CSV export. Reports are kept for 30 days.</p>
      {q.isPending ? (
        <div aria-busy="true" aria-label="Loading imports" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[60px] w-full rounded-[10px]" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState title="Couldn’t load imports" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : !q.data.length ? (
        <div className="rounded-[10px] border border-dashed border-line-2 px-5 py-8">
          <EmptyState
            align="center"
            icon={<ImportIcon size={18} />}
            title="No imports yet"
            body="Imports you and your teammates run in this project show up here."
            actions={newButton || undefined}
          />
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-[10px] border border-line p-0 [&>li+li]:border-t [&>li+li]:border-line">
          {q.data.map((j) => (
            <HistoryRow key={j.id} job={j} who={nameOf(j.createdById)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryRow({ job, who }: { job: ImportJobSummary; who: { name: string; hue: number } | null }) {
  const range = formatKeyRange({ first: job.firstKey, last: job.lastKey });
  const when = job.finishedAt ?? job.startedAt ?? job.createdAt;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-bg px-3.5 py-3 max-[760px]:px-3">
      <span className={cn("inline-flex h-[22px] flex-none items-center rounded-[6px] border px-2 font-mono text-[11px] font-medium", TONE[job.status])}>{STATUS_LABEL[job.status]}</span>
      <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
        <b className="truncate font-medium">{job.fileName}</b>
        <span className="truncate font-mono text-[11px] text-fg-3">
          {[range, `${job.imported} imported`, job.skipped ? `${job.skipped} skipped` : null].filter(Boolean).join(" · ")}
          {job.error ? ` · ${job.error.message}` : ""}
        </span>
      </span>
      <span className="inline-flex items-center gap-1.5 text-[12px] text-fg-2">
        {who && <Avatar name={who.name} hue={who.hue} size={18} ring={false} decorative />}
        <span className="truncate">{who?.name ?? "Former member"}</span>
        <span className="font-mono text-[11px] text-fg-3">· {agoLong(when)}</span>
      </span>
      <span className="ml-auto inline-flex items-center gap-1.5">
        {job.hasErrorReport && (
          <Button variant="ghost" size="sm" onClick={() => void downloadErrorReport(job.id)}>
            <DownloadGlyph />
            Report
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={() => openJob(job.id)} aria-label={`Open import ${job.fileName}`}>
          Open
        </Button>
      </span>
    </li>
  );
}
