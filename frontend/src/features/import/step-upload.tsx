"use client";

import { X } from "lucide-react";
import { useState, type DragEvent } from "react";
import { Button } from "@/components/ui/button";
import type { ImportJob, ImportSource } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { fileMeta, presetNote } from "./import-lib";
import { Alert, Note, Section } from "./parts";

/* Step 2 · Upload (board 40 S2 / ERR): drop zone → uploading → reading → file card + detected columns. */

export type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; name: string; pct: number }
  | { phase: "analyzing"; name: string }
  | { phase: "error"; title: string; meta: string };

export function StepUpload({
  source,
  job,
  upload,
  onFile,
  onRemove,
  sample,
}: {
  source: ImportSource;
  /** The analysed job (`ready`), or null before. */
  job: ImportJob | null;
  upload: UploadState;
  onFile: (f: File) => void;
  onRemove: () => void;
  /** Mock mode: "Use sample file"; live mode: null ("Download template"). */
  sample: (() => void) | null;
}) {
  const [drag, setDrag] = useState(false);
  const busy = upload.phase === "uploading" || upload.phase === "analyzing";
  const err = upload.phase === "error" ? upload : null;
  const pick = (files: FileList | null | undefined) => {
    const f = files?.[0];
    if (f) onFile(f);
  };

  const status =
    upload.phase === "uploading" ? (
      <Note live>
        Uploading {upload.name} · {upload.pct}%
      </Note>
    ) : upload.phase === "analyzing" ? (
      <Note live>Reading {upload.name}</Note>
    ) : null;

  if (job && job.status === "ready") {
    const columns = job.analysis?.columns ?? [];
    const note = presetNote(job);
    return (
      <>
        <div className="flex items-center gap-3 rounded-[10px] border border-line-2 bg-bg py-2.5 pl-3 pr-2.5">
          <span className="inline-flex size-[34px] flex-none items-center justify-center rounded-[8px] bg-ok-s font-mono text-[9.5px] font-semibold text-ok">CSV</span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <b className="truncate font-semibold">{job.file.name}</b>
            <span className="font-mono text-[11px] leading-[1.3] text-fg-3">{fileMeta(job.file)}</span>
          </span>
          <label
            className={cn(
              "relative inline-flex h-7 cursor-pointer items-center rounded-sm border border-line-2 bg-raised px-2.5 text-[12px] font-medium text-fg hover:border-control hover:bg-hover",
              "focus-within:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--ring)] max-[760px]:h-10",
              busy && "pointer-events-none opacity-60",
            )}
          >
            Replace
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="Replace CSV file"
              className="absolute size-px opacity-0"
              disabled={busy}
              onChange={(e) => {
                pick(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <Button variant="ghost" icon aria-label="Remove file" onClick={onRemove} disabled={busy} className="max-[760px]:size-10">
            <X size={12} aria-hidden />
          </Button>
        </div>
        {status}
        {err && <Alert title={err.title} meta={err.meta} />}
        {note && <Note tone={job.preset === "generic" ? "warn" : "info"}>{note}</Note>}
        <Section title="Detected columns" count={columns.length}>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {columns.map((c) => (
              <li key={c.index} className="inline-flex max-w-[180px] flex-col gap-[3px] rounded-[8px] border border-line bg-bg px-2.5 py-[7px]">
                <b className="truncate text-[12px] font-semibold">{c.name}</b>
                <span className="truncate font-mono text-[11px] leading-[1.2] text-fg-3">{c.samples[0] ?? "empty"}</span>
              </li>
            ))}
          </ul>
        </Section>
      </>
    );
  }

  const over = (e: DragEvent) => {
    e.preventDefault();
    if (!busy) setDrag(true);
  };
  return (
    <>
      {source === "jira" && <p className="m-0 text-[12.5px] text-fg-2">In Jira: Filters → Export → Export CSV (all fields)</p>}
      <div
        onDragOver={over}
        onDragEnter={over}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!busy) pick(e.dataTransfer?.files);
        }}
        className={cn(
          "relative flex min-h-[190px] flex-col items-center justify-center gap-2 rounded-[12px] border-[1.5px] border-dashed border-line-2 bg-bg p-5 text-center text-fg-2",
          "transition-[border-color,background-color,box-shadow] duration-150 hover:border-control focus-within:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--ring)]",
          drag && "border-accent bg-accent-s shadow-[0_0_0_4px_var(--accent-s)]",
          err && !drag && "border-danger hover:border-danger",
          busy && "opacity-60",
        )}
      >
        <span className="inline-flex size-10 items-center justify-center rounded-[10px] border border-line-2 bg-raised text-fg-2">
          <svg width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 12V3M5.5 6.5L9 3l3.5 3.5M3 12.5V15h12v-2.5" />
          </svg>
        </span>
        <b className="text-[14px] font-semibold text-fg">{drag ? "Drop to upload" : "Drop a CSV or browse"}</b>
        <span className="font-mono text-[11px] text-fg-3">.csv · max 10 MB</span>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Choose a CSV file"
          disabled={busy}
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-progress"
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {status}
      {err && <Alert title={err.title} meta={err.meta} />}
      {sample ? (
        <Button variant="ghost" size="sm" onClick={sample} disabled={busy} className="self-center max-[760px]:h-10">
          Use sample file
        </Button>
      ) : (
        <a href="/import-template.csv" download className="self-center text-[12.5px] font-medium text-accent-t underline-offset-2 hover:underline">
          Download template
        </a>
      )}
    </>
  );
}
