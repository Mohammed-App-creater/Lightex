"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/* Board 40 building blocks (design .iw-sec, .iw-alert, .iw-note, glyphs). Token colours only. */

const svg = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const ImportIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" strokeWidth={1.5} {...svg}>
    <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 11v2.5h11V11" />
  </svg>
);
export const BoardGlyph = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" strokeWidth={1.4} {...svg}>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <rect x="4" y="4.5" width="3" height="6" rx=".8" />
    <rect x="9" y="4.5" width="3" height="4" rx=".8" />
  </svg>
);
export const IssueGlyph = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" strokeWidth={1.4} {...svg}>
    <path d="M8 1.8l6.2 6.2L8 14.2 1.8 8z" />
    <path d="M8 5.5v3.2M8 10.6h.01" />
  </svg>
);
export const FileGlyph = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" strokeWidth={1.4} {...svg}>
    <path d="M3.5 1.5h6l3 3v10h-9z" />
    <path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.5h5M8 7v6" />
  </svg>
);
export const ArrowGlyph = ({ size = 16, className }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" strokeWidth={1.5} className={className} {...svg}>
    <path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5" />
  </svg>
);
export const WarnGlyph = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" strokeWidth={1.5} className="flex-none" {...svg}>
    <path d="M8 2l6.5 11.5h-13z" />
    <path d="M8 6.5v3M8 11.6h.01" />
  </svg>
);
export const CheckGlyph = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" strokeWidth={2} {...svg}>
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);
export const DownloadGlyph = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" strokeWidth={1.6} {...svg}>
    <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" />
  </svg>
);
export const LockGlyph = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" strokeWidth={1.2} {...svg}>
    <rect x="2.5" y="5.5" width="7" height="5" rx="1.2" />
    <path d="M4 5.5V4a2 2 0 014 0v1.5" />
  </svg>
);

export function SourceGlyph({ source, size }: { source: "trello" | "jira" | "csv"; size?: number }) {
  if (source === "trello") return <BoardGlyph size={size} />;
  if (source === "jira") return <IssueGlyph size={size} />;
  return <FileGlyph size={size} />;
}

export function Section({ title, count, meta, actions, children, className }: { title: ReactNode; count?: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      <h3 className="m-0 flex items-center gap-2 text-[13px] font-semibold">
        {title}
        {count !== undefined && <span className="font-mono text-[11px] font-medium text-fg-3">{count}</span>}
        {meta && <span className="font-mono text-[11px] font-medium text-fg-3">{meta}</span>}
        {actions && (
          <>
            <span className="flex-1" />
            {actions}
          </>
        )}
      </h3>
      {children}
    </section>
  );
}

/** Design .iw-alert: danger-tinted box, title + mono meta line. */
export function Alert({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return (
    <div role="alert" className="flex animate-[fade-in_160ms_var(--ease)] items-start gap-2.5 rounded-[8px] border border-danger/40 bg-danger-s px-3 py-2.5 text-[12.5px] leading-[18px]">
      <svg width={16} height={16} viewBox="0 0 16 16" strokeWidth={1.5} className="mt-px flex-none text-danger" {...svg}>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 5v3.5M8 11h.01" />
      </svg>
      <span className="min-w-0 flex-1">
        <b className="font-semibold">{title}</b>
        {meta && <span className="mt-0.5 block font-mono text-[11px] leading-[1.3] text-fg-3">{meta}</span>}
      </span>
      {action}
    </div>
  );
}

/** Design .iw-note: muted line with a spinner or a warning glyph. */
export function Note({ children, tone = "spin", live }: { children: ReactNode; tone?: "spin" | "warn" | "info"; live?: boolean }) {
  return (
    <div role={live ? "status" : undefined} className="flex items-center gap-2 text-[12.5px] text-fg-2">
      {tone === "spin" && <span aria-hidden className="inline-block size-3.5 flex-none animate-[spin_.7s_linear_infinite] rounded-full border-2 border-line-2 border-t-fg-2" />}
      {tone === "warn" && (
        <span className="text-warn">
          <WarnGlyph />
        </span>
      )}
      {tone === "info" && (
        <span className="text-accent-t">
          <CheckGlyph size={13} />
        </span>
      )}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** Design .iw-stat tile. */
export function Stat({ label, value, tone, meta }: { label: string; value: ReactNode; tone?: "warn" | "ok" | "bad"; meta?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[10px] border border-line bg-bg px-3.5 py-3">
      <span className="text-[12px] text-fg-2">{label}</span>
      <b className={cn("text-[24px] font-semibold leading-[30px] tracking-[-0.02em] tabular-nums", tone === "warn" && "text-warn", tone === "ok" && "text-ok", tone === "bad" && "text-danger")}>{value}</b>
      {meta && <span className="font-mono text-[11px] text-fg-3">{meta}</span>}
    </div>
  );
}
