"use client";

import { ProjectBadge } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { ImportJob, ImportResult, Project } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { createsLine, formatKeyRange, skipSummary } from "./import-lib";
import { ArrowGlyph, DownloadGlyph, Note, Section, SourceGlyph, Stat } from "./parts";
import { downloadErrorReport } from "./queries";

/* Step 4 · Import (board 40 S4 / RUN / RES): summary → running → complete / stopped / failed. */

export function StepSummary({ job, project }: { job: ImportJob; project: Project }) {
  const v = job.validation!;
  const skips = skipSummary(v.skipReasons);
  const creates = createsLine(v.creates, project.my_permissions);
  return (
    <>
      <div className="grid grid-cols-4 gap-2.5 max-[760px]:grid-cols-2">
        <Stat label="Tasks" value={v.counts.tasks} meta={v.counts.epics ? `+ ${v.counts.epics} ${v.counts.epics === 1 ? "epic" : "epics"}` : undefined} />
        <Stat label="Will skip" value={v.counts.skipped} tone={v.counts.skipped ? "warn" : undefined} />
        <Stat label="Statuses" value={v.counts.statuses} />
        <Stat label="People" value={v.counts.people} />
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-bg px-3.5 py-3">
        <span className="inline-flex min-w-0 items-center gap-2 font-medium">
          <span className="inline-flex size-7 flex-none items-center justify-center rounded-[9px] border border-line-2 bg-raised text-fg-2">
            <SourceGlyph source={job.source} size={15} />
          </span>
          <span className="truncate">{job.file.name}</span>
        </span>
        <ArrowGlyph className="flex-none text-fg-3" />
        <span className="inline-flex min-w-0 items-center gap-2 font-medium">
          <ProjectBadge code={project.key} hue={project.hue} />
          <span className="truncate">{project.name}</span>
        </span>
        <span className="ml-auto font-mono text-[11px] text-fg-3">{formatKeyRange(v.keyRange)}</span>
      </div>
      {skips && <Note tone="warn">{skips}</Note>}
      {creates && <Note tone="info">{creates}</Note>}
    </>
  );
}

export function StepRunning({ job }: { job: ImportJob }) {
  const p = job.progress;
  const total = p?.total ?? job.file.rowCount;
  const processed = p?.processed ?? 0;
  const pct = total ? Math.round((processed / total) * 100) : 0;
  const lines = (p?.recent ?? []).slice(-7);
  // Announce at most one line per poll (1 s): the newest one.
  const last = lines.at(-1);
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5">
          <b className="flex-1 text-[14px] font-semibold">{job.cancelRequested ? "Stopping" : "Importing"}</b>
          <span className="font-mono text-[11px] text-fg-3">
            {processed} / {total} rows
          </span>
          <span className="font-mono text-[11px] text-fg">{pct}%</span>
        </div>
        <div role="progressbar" aria-label="Import progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="relative h-2 overflow-hidden rounded-[4px] border border-line bg-raised">
          <span className="iw-bar-fill block h-full rounded-[4px] bg-accent" style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
      </div>
      {job.cancelRequested && <Note live>Stopping after the current batch…</Note>}
      <div role="log" aria-live="polite" aria-label="Import log" className="flex min-h-[150px] flex-1 flex-col justify-end overflow-hidden rounded-[10px] border border-line bg-bg px-3 py-2.5 font-mono text-[12px] leading-5 text-fg-2">
        {lines.map((l) => (
          <div key={`${l.row}-${l.outcome}`} aria-hidden className="iw-ll flex gap-2.5 overflow-hidden whitespace-nowrap">
            <span className={cn("w-[30px] flex-none", l.outcome === "skipped" ? "text-danger" : "text-ok")}>{l.outcome === "skipped" ? "skip" : l.outcome === "epic" ? "epic" : "ok"}</span>
            <span className="flex-none text-fg">{l.key ?? `row ${l.row}`}</span>
            <span className="truncate">{l.outcome === "skipped" ? l.reason : l.title}</span>
          </div>
        ))}
        <span className="sr-only">
          {last ? `${last.outcome === "skipped" ? `Skipped row ${last.row}: ${last.reason}` : `${last.key ?? `Row ${last.row}`} ${last.title}`}` : ""}
        </span>
      </div>
    </>
  );
}

export function StepResult({ job, project }: { job: ImportJob; project: Project }) {
  const r: ImportResult | null = job.result;
  const imported = r?.imported ?? job.progress?.imported ?? 0;
  const skipped = r?.skipped ?? job.progress?.skipped ?? 0;
  const title = job.status === "failed" ? "Import failed" : job.status === "canceled" ? "Import stopped" : "Import complete";
  const range = formatKeyRange({ first: r?.firstKey ?? null, last: r?.lastKey ?? null });
  const ok = job.status === "completed";
  return (
    <>
      <div className="flex items-center gap-4">
        <span aria-hidden className={cn("iw-pop inline-flex size-11 flex-none items-center justify-center rounded-full", ok ? "bg-ok text-bg" : job.status === "failed" ? "bg-danger-s text-danger" : "bg-warn-s text-warn")}>
          {ok ? (
            <svg width={20} height={20} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
          ) : (
            <svg width={20} height={20} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
              <path d={job.status === "failed" ? "M8 4.5v4.5M8 11.5h.01" : "M5.5 5v6M10.5 5v6"} />
            </svg>
          )}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="m-0 text-[18px] font-semibold tracking-[-0.015em]">{title}</h3>
          <span className="font-mono text-[11px] text-fg-3">{range ? `${range} · ${project.name}` : project.name}</span>
        </div>
      </div>
      {job.status === "failed" && job.error && (
        <p role="alert" className="m-0 rounded-[8px] border border-line bg-raised px-3 py-2.5 text-[12.5px] leading-[18px] text-fg-2">
          {job.error.message}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2.5">
        <Stat label="Imported" value={imported} tone="ok" meta={r?.epics ? `+ ${r.epics} ${r.epics === 1 ? "epic" : "epics"}` : undefined} />
        <Stat label="Skipped" value={skipped} tone={skipped ? "bad" : undefined} />
      </div>
      {r && r.issues.length > 0 && <ErrorReportTable job={job} result={r} />}
    </>
  );
}

export function ErrorReportTable({ job, result }: { job: ImportJob; result: ImportResult }) {
  const more = result.issueCount - result.issues.length;
  return (
    <Section
      title="Error report"
      actions={
        result.hasErrorReport && (
          <Button variant="secondary" size="sm" onClick={() => void downloadErrorReport(job.id)} className="max-[760px]:h-10">
            <DownloadGlyph />
            Download report
          </Button>
        )
      }
    >
      <div className="overflow-hidden rounded-[10px] border border-line">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              {["Row", "Reason", "Value"].map((h) => (
                <th key={h} className="bg-raised px-3 py-2 text-left font-mono text-[11px] font-medium uppercase tracking-[.04em] text-fg-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.issues.map((i) => (
              <tr key={`${i.row}-${i.reason}`}>
                <td className="w-14 border-t border-line px-3 py-2 align-top font-mono text-[12px] text-fg-2">{i.row}</td>
                <td className="border-t border-line px-3 py-2 align-top">
                  {i.reason}
                  {i.severity === "warning" && <span className="ml-1.5 font-mono text-[10.5px] text-fg-3">imported</span>}
                </td>
                <td className="max-w-[140px] overflow-hidden text-ellipsis whitespace-nowrap border-t border-line px-3 py-2 align-top font-mono text-[11.5px] text-fg-3">{i.value || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 && <span className="font-mono text-[11px] text-fg-3">and {more} more in the report</span>}
    </Section>
  );
}
