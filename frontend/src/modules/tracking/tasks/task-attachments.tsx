"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { useProjectMembers } from "@/features/projects/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Attachment, TaskDetail } from "@/lib/api/types";
import { uploadAttachment } from "@/lib/api/uploads";
import { ACCEPT_ATTR, MAX_FILES_PER_DROP, formatBytes, isRasterImage, validateUpload } from "@/lib/files";
import { can } from "@/lib/permissions/can";
import { cn } from "@/lib/utils/cn";
import { AttachmentViewer, ExtBadge } from "./attachment-viewer";

type Upload = { id: string; name: string; size: number; pct: number; error?: string; ctrl?: AbortController };

/**
 * Attachments (board 14 §2.9, viewer board 34). Raster images get an inline preview and open in
 * the viewer; every other type (code, text, SVG, HTML) is a download-only card, never rendered.
 * Delete waits out a 5s Undo window before the DELETE is sent.
 */
export function TaskAttachments({ task, canUpload, deleted }: { task: TaskDetail; canUpload: boolean; deleted: boolean }) {
  const qc = useQueryClient();
  const me = useMe();
  const { data: files = [], isPending } = useQuery({ queryKey: qk.attachments(task.id), queryFn: () => api.attachments.list(task.id) });
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const canDeleteAny = can("attachment.delete_any", task.project.my_permissions);

  const { data: members = [] } = useProjectMembers(task.projectId);
  const users = useMemo(() => new Map(members.map((m) => [m.userId, m.user])), [members]);
  const [viewing, setViewing] = useState<number | null>(null);
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>());
  const canDelete = (f: Attachment) => !deleted && ((f.uploaderId === me.id && canUpload) || canDeleteAny);

  // Leaving the task (or the page) commits deletes still inside their Undo window.
  useEffect(() => {
    const map = pending.current;
    const flush = () => map.forEach((p) => p.run());
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  const remove = (a: Attachment) => {
    const key = qk.attachments(task.id);
    void qc.cancelQueries({ queryKey: key });
    qc.setQueryData<Attachment[]>(key, (l) => l?.filter((x) => x.id !== a.id));
    const run = () => {
      const p = pending.current.get(a.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.current.delete(a.id);
      api.attachments
        .remove(a.id)
        .catch((e) => {
          qc.setQueryData<Attachment[]>(key, (l) => (l?.some((x) => x.id === a.id) ? l : [...(l ?? []), a]));
          toast.error(`Couldn’t delete ${a.fileName}`, { body: `${errorMessage(e)} Restored.` });
        })
        .finally(() => void qc.invalidateQueries({ queryKey: key }));
    };
    pending.current.set(a.id, { timer: setTimeout(run, 5200), run });
    toast({
      tone: "info",
      title: `Deleted ${a.fileName}`,
      duration: 5000,
      action: {
        label: "Undo",
        key: "Z",
        onClick: () => {
          const p = pending.current.get(a.id);
          if (!p) return;
          clearTimeout(p.timer);
          pending.current.delete(a.id);
          qc.setQueryData<Attachment[]>(key, (l) =>
            l?.some((x) => x.id === a.id) ? l : [...(l ?? []), a].sort((x, y) => x.createdAt.localeCompare(y.createdAt)),
          );
        },
      },
    });
  };

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
          {files.map((f, i) => (
            <FileTile key={f.id} file={f} canDelete={canDelete(f)} onOpen={() => setViewing(i)} onDelete={() => remove(f)} />
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
      <AttachmentViewer
        files={files}
        index={viewing === null ? null : Math.min(viewing, Math.max(0, files.length - 1))}
        onIndex={setViewing}
        onClose={() => setViewing(null)}
        users={users}
        canDelete={canDelete}
        onDelete={remove}
      />
    </section>
  );
}

function FileTile({ file, canDelete, onOpen, onDelete }: { file: Attachment; canDelete: boolean; onOpen: () => void; onDelete: () => void }) {
  const raster = file.kind === "image" && isRasterImage(file.fileName, file.mimeType) && file.previewUrl;
  return (
    <div className="group/tile relative overflow-hidden rounded-md border border-line bg-bg transition-colors hover:border-control">
      <button type="button" onClick={onOpen} aria-label={`Open ${file.fileName}`} className="block w-full border-b border-line text-left">
        {raster ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed blob/data URLs; next/image can't optimise them
          <img src={file.previewUrl!} alt="" className="h-[70px] w-full object-cover" loading="lazy" />
        ) : (
          // Not a raster image: never rendered (SVG / HTML / code are download-only).
          <span className="flex h-[70px] items-center justify-center bg-[repeating-linear-gradient(135deg,var(--raised)_0_8px,var(--surface)_8px_16px)]">
            <ExtBadge name={file.fileName} size={30} />
          </span>
        )}
      </button>
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
