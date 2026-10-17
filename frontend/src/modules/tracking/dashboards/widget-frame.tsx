"use client";

import { createContext, useContext, type HTMLAttributes, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { cn } from "@/lib/utils/cn";

/*
 * Widget card chrome (design `db-card`, spec §1.4 edit table): grip ⠿ left of the title (edit
 * mode), title, mono meta, the settings gear and × (edit mode), the resize handle and size badge.
 * The grid provides the edit controls through context; each widget renders its own frame so it
 * can put its meta in the header. Per-widget loading / error / empty live inside the card.
 */

export type WidgetChrome = {
  name: string;
  editing: boolean;
  /** The ⠿ handle's props (pointer drag + arrow-key reorder). */
  grip?: HTMLAttributes<HTMLButtonElement> & { ref?: (el: HTMLButtonElement | null) => void };
  /** The corner handle's props (pointer resize + arrow-key resize). */
  resize?: HTMLAttributes<HTMLButtonElement>;
  sizeLabel?: string;
  showSize?: boolean;
  onRemove?: () => void;
  settings?: ReactNode;
  /** Whole-card flash (a changed chart). */
  flash?: boolean;
};

const ChromeCtx = createContext<WidgetChrome>({ name: "", editing: false });
export const WidgetChromeProvider = ChromeCtx.Provider;
export const useWidgetChrome = () => useContext(ChromeCtx);

const GripIcon = () => (
  <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" aria-hidden>
    <circle cx="3.5" cy="3" r="1.3" />
    <circle cx="8.5" cy="3" r="1.3" />
    <circle cx="3.5" cy="7" r="1.3" />
    <circle cx="8.5" cy="7" r="1.3" />
    <circle cx="3.5" cy="11" r="1.3" />
    <circle cx="8.5" cy="11" r="1.3" />
  </svg>
);
const XIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
const ResizeIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
    <path d="M9 3L3 9M9 6.5L6.5 9" />
  </svg>
);

const iconBtn =
  "inline-flex size-6 flex-none items-center justify-center rounded-sm text-fg-3 transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg max-[1023px]:size-8";

export function WidgetFrame({ meta, children, className }: { meta?: ReactNode; children: ReactNode; className?: string }) {
  const c = useWidgetChrome();
  return (
    <section
      aria-label={c.name}
      className={cn(
        "db-card relative flex h-full min-w-0 flex-col gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-3",
        c.editing && "border-line-2 hover:border-control",
        c.flash && "hl",
        className,
      )}
    >
      <header className="flex min-h-6 flex-none items-center gap-2">
        {c.editing && c.grip && (
          <button
            type="button"
            {...c.grip}
            aria-roledescription="drag handle"
            aria-label={`Move ${c.name}. Arrow keys reorder`}
            className={cn(iconBtn, "-ml-1.5 cursor-grab touch-none active:cursor-grabbing")}
          >
            <GripIcon />
          </button>
        )}
        <h2 className="m-0 min-w-0 truncate text-[13px] font-semibold leading-[18px]">{c.name}</h2>
        {meta ? <span className="whitespace-nowrap font-mono text-[11px] font-medium leading-none text-fg-3">{meta}</span> : null}
        <span className="flex-1" />
        {c.editing && c.settings}
        {c.editing && c.onRemove && (
          <button type="button" aria-label={`Remove ${c.name}`} onClick={c.onRemove} className={cn(iconBtn, "-mr-1.5 hover:bg-danger-s hover:text-danger")}>
            <XIcon />
          </button>
        )}
      </header>
      <div className="db-body relative flex min-h-0 flex-1 flex-col gap-2">{children}</div>
      {c.editing && c.resize && (
        <>
          <button
            type="button"
            {...c.resize}
            aria-label={`Resize ${c.name}, ${c.sizeLabel}. Arrow keys resize`}
            className={cn(
              "absolute bottom-0.5 right-0.5 z-[3] inline-flex size-[22px] cursor-nwse-resize touch-none items-center justify-center rounded-sm text-fg-3 hover:bg-accent-s hover:text-accent-t",
              c.showSize && "bg-accent-s text-accent-t",
            )}
          >
            <ResizeIcon />
          </button>
          {c.showSize && (
            <span aria-hidden className="absolute bottom-1.5 right-7 z-[4] h-5 rounded-[5px] border border-line-2 bg-raised px-[7px] font-mono text-[11px] font-semibold leading-[18px] text-fg shadow-pop">
              {c.sizeLabel}
            </span>
          )}
        </>
      )}
    </section>
  );
}

/* ───────── per-widget states ───────── */

export function WidgetLoading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-1 flex-col gap-2.5 pt-1" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-2.5 w-24" />
      <Skeleton className="min-h-8 w-full flex-1 rounded-md" />
      {lines > 2 && <Skeleton className="h-2.5 w-3/5" />}
    </div>
  );
}

export function WidgetError({ onRetry, retrying }: { onRetry: () => void; retrying?: boolean }) {
  return (
    <div role="alert" className="flex flex-1 items-center justify-center gap-2 text-[12.5px] text-fg-2">
      <span aria-hidden className="inline-flex size-3.5 items-center justify-center rounded-full bg-danger text-[9px] font-bold leading-none text-bg">
        !
      </span>
      Couldn’t load
      <Button size="sm" variant="secondary" loading={retrying} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function WidgetEmpty({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center px-2 text-center text-[12.5px] text-fg-3">{children}</div>;
}

/** Legend row (design `.leg`). */
export function WidgetLegend({ items }: { items: { kind: "line" | "dash" | "rect" | "tick"; label: string; color?: string }[] }) {
  return (
    <div className="flex flex-none flex-wrap gap-3 text-[11.5px] leading-[14px] text-fg-2">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          {it.kind === "line" && <i aria-hidden className="h-0.5 w-3.5 rounded-[1px]" style={{ background: it.color ?? "var(--c1)" }} />}
          {it.kind === "dash" && <i aria-hidden className="h-0 w-3.5 border-t-2 border-dashed border-cref" />}
          {it.kind === "rect" && <i aria-hidden className="size-[9px] rounded-[2px]" style={{ background: it.color ?? "var(--c1)" }} />}
          {it.kind === "tick" && <i aria-hidden className="h-[11px] w-0.5 rounded-[1px] bg-fg" />}
          {it.label}
        </span>
      ))}
    </div>
  );
}
