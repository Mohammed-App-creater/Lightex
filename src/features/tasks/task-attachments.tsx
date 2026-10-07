"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2, Upload, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Attachment, TaskDetail } from "@/lib/api/types";
import { uploadAttachment } from "@/lib/api/uploads";
import { ACCEPT_ATTR, MAX_FILES_PER_DROP, extOf, formatBytes, isRasterImage, validateUpload } from "@/lib/files";
import { can } from "@/lib/permissions/can";
import { cn } from "@/lib/utils/cn";

type Upload = { id: string; name: string; size: number; pct: number; error?: string; ctrl?: AbortController };

/**
 * Attachments (board 14 §2.9). Raster images get an inline preview; every other type
 * (code, text, SVG, HTML) is a download only and is never rendered as markup.
 */
export function TaskAttachments({ task, canUpload, deleted }: { task: TaskDetail; canUpload: boolean; deleted: boolean }) {
  const qc = useQueryClient();
  const me = useMe();
  const { data: files = [], isPending } = useQuery({ queryKey: qk.attachments(task.id), queryFn: () => api.attachments.list(task.id) });
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const canDeleteAny = can("attachment.delete_any", task.project.my_permissions);

  const remove = useMutation({
    mutationFn: (a: Attachment) => api.attachments.remove(a.id),
    onMutate: async (a) => {
      await qc.cancelQueries({ queryKey: qk.attachments(task.id) });
      const prev = qc.getQueryData<Attachment[]>(qk.attachments(task.id));
      qc.setQueryData<Attachment[]>(qk.attachments(task.id), (l) => l?.filter((x) => x.id !== a.id));
      return { prev };
    },
    onError: (e, a, ctx) => {
      qc.setQueryData(qk.attachments(task.id), ctx?.prev);
      toast.error(`Couldn’t delete ${a.fileName}`, { body: errorMessage(e) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.attachments(task.id) }),
  });

  const patchUpload = (id: string, patch: Partial<Upload>) => setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));

  const addFiles = (list: FileList | File[]) => {
    const picked = Array.from(list).slice(0, MAX_FILES_PER_DROP);
    for (const file of picked) {
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`;
      const problem = validateUpload(file);
      const entry: Upload = { id, name: file.name.slice(0, 120), size: file.size, pct: 0, error: problem ?? undefined };
      if (problem) {
        setUploads((u) => [...u, entry]);
        continue;
      }
      const ctrl = new AbortController();
      setUploads((u) => [...u, { ...entry, ctrl }]);
      uploadAttachment(task.id, file, (pct) => patchUpload(id, { pct }), ctrl.signal)
        .then((att) => {
          setUploads((u) => u.filter((x) => x.id !== id));
          qc.setQueryData<Attachment[]>(qk.attachments(task.id), (l) => [...(l ?? []), att]);
          void qc.invalidateQueries({ queryKey: qk.taskActivity(task.id) });
        })
        .catch((e: unknown) => {
          if ((e as Error)?.name === "AbortError") return;
          patchUpload(id, { error: errorMessage(e, "Upload failed") });
        });
    }
    if (Array.from(list).length > MAX_FILES_PER_DROP) toast.info(`Only the first ${MAX_FILES_PER_DROP} files were added`);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  if (!files.length && !uploads.length && !canUpload) return null;

  return (
    <section aria-label="Attachments">
      <div className="mb-2 flex items-center gap-2.5">
        <h3 className="m-0 text-[13px] font-semibold">Attachments</h3>
        <span className="font-mono text-[11px] font-medium text-fg-3">{files.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {uploads.map((u) => (
          <div key={u.id} role="status" className={cn("flex items-center gap-2.5 rounded-md border bg-bg px-2.5 py-2", u.error ? "border-danger" : "border-line")}>
            <ExtBadge name={u.name} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-medium">{u.name}</span>
                <span className={cn("whitespace-nowrap font-mono text-[11px] font-medium", u.error ? "text-danger" : "text-fg-3")}>
                  {u.error ?? `${u.pct}% · ${formatBytes(u.size)}`}
                </span>
              </div>
              {!u.error && (
                <div className="h-1 overflow-hidden rounded-full bg-raised" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuenow={u.pct} aria-valuemin={0} aria-valuemax={100}>
                  <span className="block h-full origin-left rounded-full bg-accent transition-transform duration-[120ms] ease-linear" style={{ transform: `scaleX(${u.pct / 100})` }} />
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label={u.error ? "Dismiss" : "Cancel upload"}
              onClick={() => {
                u.ctrl?.abort();
                setUploads((list) => list.filter((x) => x.id !== u.id));
              }}
              className="flex size-[26px] items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
            >
              <X size={13} aria-hidden />
            </button>
          </div>
        ))}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
          {isPending && <div className="skeleton h-[104px] rounded-md" />}
          {files.map((f) => (
            <FileTile
              key={f.id}
              file={f}
              canDelete={!deleted && ((f.uploaderId === me.id && canUpload) || canDeleteAny)}
              onDelete={() => remove.mutate(f)}
            />
          ))}
          {canUpload && !deleted && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={onDrop}
              className={cn(
                "relative flex min-h-[70px] flex-col items-center justify-center gap-1 rounded-md border-[1.5px] border-dashed border-line-2 p-2.5 text-center text-fg-2 transition-[border-color,background-color,box-shadow] focus-within:shadow-[var(--focus-ring)]",
                over && "border-accent bg-accent-s shadow-[0_0_0_4px_var(--accent-s)]",
              )}
            >
              <Upload size={16} aria-hidden />
              <span className="text-[12px] font-medium text-fg">{over ? "Drop to upload" : "Drop files or browse"}</span>
              <span className="text-[11px] text-fg-3">Images or code · 10 MB max</span>
              <input
                ref={input}
                type="file"
                multiple
                accept={ACCEPT_ATTR}
                aria-label="Upload attachments"
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ExtBadge({ name }: { name: string }) {
  return (
    <span className="flex size-[26px] flex-none items-center justify-center rounded-sm border border-line-2 bg-raised font-mono text-[8.5px] font-semibold uppercase">
      {extOf(name).slice(0, 4) || "FILE"}
    </span>
  );
}

function FileTile({ file, canDelete, onDelete }: { file: Attachment; canDelete: boolean; onDelete: () => void }) {
  const raster = file.kind === "image" && isRasterImage(file.fileName, file.mimeType) && file.previewUrl;
  return (
    <div className="group/tile relative overflow-hidden rounded-md border border-line bg-bg">
      {raster ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed blob/data URLs; next/image can't optimise them
        <img src={file.previewUrl!} alt={file.fileName} className="h-[70px] w-full border-b border-line object-cover" loading="lazy" />
      ) : file.kind === "image" ? (
        <div className="flex h-[70px] items-center justify-center border-b border-line bg-[repeating-linear-gradient(135deg,var(--raised)_0_8px,var(--surface)_8px_16px)] font-mono text-[11px] font-medium uppercase text-fg-3">
          {extOf(file.fileName)}
        </div>
      ) : (
        <div className="h-[70px] overflow-hidden whitespace-pre border-b border-line px-2.5 py-2 font-mono text-[10.5px] leading-[15px] text-fg-2">{`// ${file.fileName}`}</div>
      )}
      <div className="flex flex-col gap-0.5 px-2.5 py-[7px]">
        <span className="truncate text-[12px] font-medium" title={file.fileName}>
          {file.fileName}
        </span>
        <span className="text-[11px] text-fg-3">{formatBytes(file.size)}</span>
      </div>
      <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/tile:opacity-100 max-[1023px]:opacity-100">
        <a
          href={file.downloadUrl}
          download={file.fileName}
          rel="noopener"
          aria-label={`Download ${file.fileName}`}
          className="flex size-6 items-center justify-center rounded-sm border border-line-2 bg-raised text-fg-2 hover:text-fg"
        >
          <Download size={12} aria-hidden />
        </a>
        {canDelete && (
          <button
            type="button"
            aria-label={`Delete ${file.fileName}`}
            onClick={onDelete}
            className="flex size-6 items-center justify-center rounded-sm border border-line-2 bg-raised text-fg-2 hover:text-danger"
          >
            <Trash2 size={12} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
