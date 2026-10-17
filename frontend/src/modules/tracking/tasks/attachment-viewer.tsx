"use client";

import * as D from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { motion } from "motion/react";
import { Check, ChevronLeft, ChevronRight, Download, ImageOff, Images, Maximize, Trash2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import type { Attachment, User } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { extOf, formatBytes, isRasterImage } from "@/lib/files";
import { cn } from "@/lib/utils/cn";
import { shortDate } from "@/lib/utils/dates";

/*
 * Attachment viewer (board 34): fit / zoom (+ − 0, double-click toggles 100%), drag to pan when
 * zoomed, ← → browse, thumbnails + counter, download, delete with confirm (Undo toast is the
 * caller's). Only raster images render inline; code, text, SVG and HTML get a download-only card.
 */

export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function nextZoom(scale: number) {
  return ZOOM_STEPS.find((s) => s > scale * 1.01) ?? 4;
}
/** null = back to fit. */
export function prevZoom(scale: number, fit: number) {
  const p = ZOOM_STEPS.filter((s) => s < scale * 0.99).pop();
  return p === undefined || p <= fit ? null : p;
}
export function fitScale(img: { w: number; h: number }, vp: { w: number; h: number }, pad: number) {
  if (!img.w || !img.h || !vp.w || !vp.h) return 1;
  return Math.min((vp.w - pad) / img.w, (vp.h - pad) / img.h, 1);
}

const isRaster = (f: Attachment) => f.kind === "image" && isRasterImage(f.fileName, f.mimeType) && Boolean(f.previewUrl);

export function AttachmentViewer({
  files,
  index,
  onIndex,
  onClose,
  users,
  canDelete,
  onDelete,
}: {
  files: Attachment[];
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
  users: Map<string, User>;
  canDelete: (f: Attachment) => boolean;
  onDelete: (f: Attachment) => void;
}) {
  const open = index !== null;
  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[70] bg-[color-mix(in_oklab,var(--bg)_86%,transparent)] backdrop-blur-[14px] data-[state=open]:animate-[fade-in_180ms_var(--ease)]" />
        <D.Content aria-describedby={undefined} className="fixed inset-0 z-[71] flex flex-col outline-none data-[state=open]:animate-[modal-in_200ms_var(--ease)]">
          {open && <Viewer files={files} index={index} onIndex={onIndex} users={users} canDelete={canDelete} onDelete={onDelete} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Viewer({
  files,
  index,
  onIndex,
  users,
  canDelete,
  onDelete,
}: Omit<Parameters<typeof AttachmentViewer>[0], "index" | "onClose"> & { index: number }) {
  const mobile = useIsMobile();
  const n = files.length;
  const idx = n ? Math.min(index, n - 1) : 0;
  const cur = n ? files[idx]! : null;
  const raster = cur ? isRaster(cur) : false;

  const vpRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState<Record<string, { w: number; h: number }>>({});
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const [attempt, setAttempt] = useState<Record<string, number>>({});
  const [zoom, setZoom] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [dir, setDir] = useState<1 | -1>(1);
  const [nav, setNav] = useState(0);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useLayoutEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dims = cur ? natural[cur.id] : undefined;
  const pad = mobile ? 16 : 48;
  const fit = dims ? fitScale(dims, vp, pad) : 1;
  const scale = zoom ?? fit;
  const zoomed = Boolean(dims && (dims.w * scale > vp.w || dims.h * scale > vp.h));

  const clampPan = (x: number, y: number, s: number) => {
    if (!dims) return { x: 0, y: 0 };
    const mx = Math.max(0, (dims.w * s - vp.w) / 2 + 24);
    const my = Math.max(0, (dims.h * s - vp.h) / 2 + 24);
    return { x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
  };
  const p = clampPan(pan.x, pan.y, scale);

  const setScale = (z: number | null) => {
    const s = z ?? fit;
    setZoom(z);
    setPan(clampPan(pan.x * (s / scale), pan.y * (s / scale), s));
  };
  const zin = () => raster && setScale(nextZoom(scale));
  const zout = () => raster && setScale(prevZoom(scale, fit));
  const toFit = () => setScale(null);
  const toggle100 = () => raster && setScale(Math.abs(scale - 1) < 0.01 ? null : 1);

  const go = (i: number, d: 1 | -1) => {
    if (!n) return;
    onIndex((i + n) % n);
    setZoom(null);
    setPan({ x: 0, y: 0 });
    setConfirm(false);
    setDir(d);
    setNav((x) => x + 1);
  };
  const prev = () => go(idx - 1, -1);
  const next = () => go(idx + 1, 1);

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("[role=alertdialog]")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === "+" || k === "=") zin();
    else if (k === "-" || k === "_") zout();
    else if (k === "0") toFit();
    else if (k === "ArrowLeft" && n > 1) prev();
    else if (k === "ArrowRight" && n > 1) next();
    else return;
    e.preventDefault();
  };

  // Clear the "Downloaded" tick after a moment.
  useEffect(() => {
    if (!downloaded) return;
    const id = setTimeout(() => setDownloaded(false), 1400);
    return () => clearTimeout(id);
  }, [downloaded]);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!zoomed || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, px: p.x, py: p.y };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setPan(clampPan(d.px + e.clientX - d.x, d.py + e.clientY - d.y, scale));
  };
  const onUp = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const by = cur ? users.get(cur.uploaderId) : undefined;
  const pct = `${Math.round(scale * 100)}%`;
  const loadKey = cur ? `${cur.id}:${attempt[cur.id] ?? 0}` : "";
  const error = cur ? Boolean(broken[cur.id]) : false;
  const loading = raster && !dims && !error;

  return (
    <div className="flex h-full flex-col" onKeyDown={onKey}>
      <div className={cn("flex h-14 flex-none items-center gap-3 border-b border-line pl-5 pr-3", mobile && "h-16 gap-1.5 px-2")}>
        {mobile && (
          <D.Close asChild>
            <Button variant="ghost" icon aria-label="Close viewer" className="size-11">
              <X size={15} aria-hidden />
            </Button>
          </D.Close>
        )}
        <div className={cn("flex min-w-0 flex-1 items-center gap-2.5", mobile && "flex-col items-start gap-[5px]")}>
          {cur ? (
            <>
              <D.Title className="m-0 truncate text-[14px] font-semibold">{cur.fileName}</D.Title>
              <span className="whitespace-nowrap font-mono text-[11px] font-medium text-fg-3">
                {formatBytes(cur.size)}
                {dims && raster ? ` · ${dims.w}×${dims.h}` : ""}
              </span>
              {!mobile && (
                <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-fg-2 max-[1023px]:hidden">
                  {by && <Avatar name={by.name} hue={by.hue} size={20} decorative />}
                  {by?.name ?? "Former member"} · {shortDate(cur.createdAt.slice(0, 10))}
                </span>
              )}
            </>
          ) : (
            <D.Title className="m-0 text-[14px] font-semibold">Attachments</D.Title>
          )}
        </div>
        {cur && raster && !error && (
          <div
            role="group"
            aria-label="Zoom"
            className={cn(
              "flex items-center gap-0.5 rounded-md border border-line-2 bg-raised p-0.5",
              mobile && "fixed bottom-[84px] left-1/2 z-[2] -translate-x-1/2 shadow-pop",
            )}
          >
            <Button variant="ghost" size="sm" icon aria-label="Zoom out (−)" onClick={zout} className={mobile ? "size-10" : undefined}>
              <ZoomOut size={14} aria-hidden />
            </Button>
            <Button variant="ghost" size="sm" aria-label={`Zoom ${pct}. Toggle 100%`} aria-live="polite" onClick={toggle100} className={cn("min-w-[52px] font-mono", mobile && "h-10")}>
              {pct}
            </Button>
            <Button variant="ghost" size="sm" icon aria-label="Zoom in (+)" onClick={zin} className={mobile ? "size-10" : undefined}>
              <ZoomIn size={14} aria-hidden />
            </Button>
            <span aria-hidden className="mx-0.5 h-5 w-px bg-line-2" />
            <Button variant="ghost" size="sm" icon aria-label="Fit (0)" aria-pressed={zoom === null} onClick={toFit} className={cn("aria-pressed:bg-accent-s aria-pressed:text-accent-t", mobile && "size-10")}>
              <Maximize size={13} aria-hidden />
            </Button>
          </div>
        )}
        {cur && (
          <Button variant="secondary" size="sm" asChild className={cn(downloaded && "text-ok", mobile && "size-11 px-0")}>
            <a href={cur.downloadUrl} download={cur.fileName} rel="noopener" aria-label={`Download ${cur.fileName}`} onClick={() => setDownloaded(true)}>
              {downloaded ? <Check size={14} aria-hidden /> : <Download size={14} aria-hidden />}
              {!mobile && <span className="max-[1023px]:hidden">{downloaded ? "Downloaded" : "Download"}</span>}
            </a>
          </Button>
        )}
        {cur && canDelete(cur) && (
          <Popover.Root open={confirm} onOpenChange={setConfirm}>
            <Popover.Trigger asChild>
              <Button variant="danger-ghost" size="sm" aria-label={`Delete ${cur.fileName}`} aria-haspopup="dialog" className={mobile ? "size-11 px-0" : undefined}>
                <Trash2 size={14} aria-hidden />
                {!mobile && <span className="max-[1023px]:hidden">Delete</span>}
              </Button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                role="alertdialog"
                aria-label="Delete attachment"
                align="end"
                sideOffset={6}
                collisionPadding={8}
                className="z-[75] flex w-60 flex-col gap-3 rounded-[10px] border border-line-2 bg-raised p-3.5 shadow-pop outline-none data-[state=open]:animate-[menu-in_150ms_var(--ease)]"
                onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()}
              >
                <span className="text-[13px] font-semibold leading-[18px]">Delete {cur.fileName}?</span>
                <span className="font-mono text-[12px] text-fg-3">Removed for everyone</span>
                <div className="flex justify-end gap-1.5">
                  <Popover.Close asChild>
                    <Button size="sm" variant="ghost" autoFocus>
                      Cancel
                    </Button>
                  </Popover.Close>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setConfirm(false);
                      setZoom(null);
                      setPan({ x: 0, y: 0 });
                      onDelete(cur);
                      if (idx >= n - 1 && idx > 0) onIndex(idx - 1);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        )}
        {!mobile && (
          <>
            <span aria-hidden className="mx-0.5 h-5 w-px bg-line-2" />
            <D.Close asChild>
              <Button variant="ghost" size="sm" icon aria-label="Close viewer (Esc)" tooltip="Close" tooltipKeys={["Esc"]}>
                <X size={14} aria-hidden />
              </Button>
            </D.Close>
          </>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={vpRef}
          tabIndex={0}
          role={cur && raster ? "img" : "group"}
          aria-roledescription={cur && raster ? "image viewer" : undefined}
          aria-label={cur ? `${cur.fileName}${raster ? `, ${pct}. Plus and minus zoom, 0 fits, arrows browse, Escape closes` : ""}` : "No attachments"}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onDoubleClick={toggle100}
          className={cn(
            "absolute inset-y-0 left-14 right-14 overflow-hidden rounded-md outline-none focus-visible:shadow-[var(--focus-ring)]",
            mobile && "left-0 right-0 rounded-none",
            zoomed && "cursor-grab",
            dragging && "cursor-grabbing",
          )}
        >
          {!cur ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-fg-2">
              <Images size={40} strokeWidth={1.3} className="text-fg-3" aria-hidden />
              <span className="font-semibold text-fg">No attachments</span>
            </div>
          ) : raster ? (
            <motion.div
              key={`${cur.id}-${nav}`}
              className="absolute inset-0"
              initial={nav > 0 ? { opacity: 0, x: 48 * dir } : false}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            >
              {error ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5">
                  <ImageOff size={32} strokeWidth={1.4} className="text-danger" aria-hidden />
                  <span role="status" className="font-semibold">
                    Couldn’t load image
                  </span>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => {
                        setBroken((b) => ({ ...b, [cur.id]: false }));
                        setAttempt((a) => ({ ...a, [cur.id]: (a[cur.id] ?? 0) + 1 }));
                      }}>
                      Retry
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={cur.downloadUrl} download={cur.fileName} rel="noopener">
                        <Download size={14} aria-hidden /> Download
                      </a>
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {loading && (
                    <div aria-busy="true" aria-label="Loading image" className="absolute inset-0 flex items-center justify-center">
                      <span className="skeleton h-[40%] w-[50%] rounded-lg" />
                    </div>
                  )}
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed blob/data URLs; next/image can't optimise them */}
                  <img
                    key={loadKey}
                    src={cur.previewUrl!}
                    alt={cur.fileName}
                    draggable={false}
                    onLoad={(e) => {
                      const el = e.currentTarget;
                      setNatural((m) => ({ ...m, [cur.id]: { w: el.naturalWidth, h: el.naturalHeight } }));
                    }}
                    onError={() => setBroken((b) => ({ ...b, [cur.id]: true }))}
                    className={cn(
                      "absolute left-1/2 top-1/2 max-w-none select-none rounded-md shadow-modal",
                      !dragging && "transition-transform duration-200 ease-out",
                      !dims && "opacity-0",
                    )}
                    style={{
                      width: dims?.w,
                      height: dims?.h,
                      transform: `translate(calc(-50% + ${p.x.toFixed(1)}px), calc(-50% + ${p.y.toFixed(1)}px)) scale(${scale.toFixed(4)})`,
                    }}
                  />
                </>
              )}
            </motion.div>
          ) : (
            <FileCard key={cur.id} file={cur} />
          )}
        </div>
        {n > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous (←)"
              onClick={prev}
              className="absolute left-2 top-1/2 z-[2] -mt-5 flex size-10 items-center justify-center rounded-full border border-line-2 bg-raised text-fg transition-[background-color,transform] hover:bg-hover active:scale-[.94] max-[760px]:size-11 max-[760px]:opacity-90"
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next (→)"
              onClick={next}
              className="absolute right-2 top-1/2 z-[2] -mt-5 flex size-10 items-center justify-center rounded-full border border-line-2 bg-raised text-fg transition-[background-color,transform] hover:bg-hover active:scale-[.94] max-[760px]:size-11 max-[760px]:opacity-90"
            >
              <ChevronRight size={16} aria-hidden />
            </button>
          </>
        )}
      </div>

      <div className={cn("flex h-[84px] flex-none items-center gap-4 border-t border-line px-5", mobile && "h-[72px] px-2")}>
        {!mobile && (
          <span className="w-[120px] font-mono text-[12px] font-medium text-fg-3" aria-live="polite">
            {n ? `${idx + 1} / ${n}` : "0 / 0"}
          </span>
        )}
        <div className={cn("flex min-w-0 flex-1 gap-2 overflow-x-auto p-1", mobile ? "justify-start" : "justify-center")}>
          {files.map((f, i) => (
            <button
              key={f.id}
              type="button"
              aria-label={f.fileName}
              aria-current={i === idx ? "true" : undefined}
              onClick={() => i !== idx && go(i, i > idx ? 1 : -1)}
              className={cn(
                "flex h-12 w-16 flex-none items-center justify-center overflow-hidden rounded-sm border border-line-2 bg-bg opacity-60 transition-[opacity,border-color] hover:opacity-90 max-[760px]:h-11 max-[760px]:w-[52px]",
                i === idx && "border-accent opacity-100 shadow-[0_0_0_1px_var(--accent)]",
              )}
            >
              {isRaster(f) ? (
                // eslint-disable-next-line @next/next/no-img-element -- signed blob/data URLs
                <img src={f.previewUrl!} alt="" className="h-full w-full object-cover" loading="lazy" draggable={false} />
              ) : (
                <ExtBadge name={f.fileName} />
              )}
            </button>
          ))}
        </div>
        {!mobile && (
          <span className="flex w-[120px] items-center justify-end gap-1 text-[11px] text-fg-3" aria-hidden>
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
            {raster && (
              <>
                <Kbd>+</Kbd>
                <Kbd>−</Kbd>
                <Kbd>0</Kbd>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

export function ExtBadge({ name, size = 26 }: { name: string; size?: number }) {
  return (
    <span
      className="flex flex-none items-center justify-center rounded-sm border border-line-2 bg-raised font-mono text-[9px] font-semibold uppercase text-accent-t"
      style={{ width: size, height: size }}
    >
      {extOf(name).slice(0, 4) || "FILE"}
    </span>
  );
}

/** Non-raster files: never rendered or executed — a card with the download only. */
function FileCard({ file }: { file: Attachment }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <div className="flex w-full max-w-[360px] flex-col items-center gap-2.5 rounded-lg border border-line-2 bg-surface px-6 py-7 text-center shadow-modal">
        <ExtBadge name={file.fileName} size={40} />
        <span className="max-w-full truncate text-[14px] font-semibold">{file.fileName}</span>
        <span className="font-mono text-[11px] font-medium text-fg-3">{formatBytes(file.size)}</span>
        <p className="m-0 text-[12.5px] leading-[18px] text-fg-2">Preview isn’t available for this file type. Download it to open it in your own editor.</p>
        <Button variant="secondary" size="sm" asChild>
          <a href={file.downloadUrl} download={file.fileName} rel="noopener">
            <Download size={14} aria-hidden /> Download
          </a>
        </Button>
      </div>
    </div>
  );
}
