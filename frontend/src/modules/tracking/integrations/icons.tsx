import type { Provider } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

/* Board 37 glyphs, from the design's ICON table (16×16 strokes). */

export const DEV_ICON = {
  github: "M8 1.75a6.25 6.25 0 110 12.5 6.25 6.25 0 010-12.5zM6.2 6.2L4.4 8l1.8 1.8M9.8 6.2L11.6 8l-1.8 1.8",
  gitlab: "M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5zM6.5 5v6M9.5 5.5v.8A1.7 1.7 0 017.8 8H6.5",
  prOpen: "M4 2a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM4 11a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM12 11a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM4 5v6M12 11V7a2 2 0 00-2-2H7.5M9 3.5L7.5 5 9 6.5",
  prMerged: "M4 2a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM4 11a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM12 7.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM4 5v6M4 5c0 2.5 2 4 4.5 4h2",
  prClosed: "M4 2a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM4 11a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM12 11a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM4 5v6M12 7.5V11M10.5 3l3 3M13.5 3l-3 3",
  check: "M3.5 8.5l3 3 6-7",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  warn: "M8 2.5l6 10.5H2zM8 6.5v3M8 11.3v.1",
  branch: "M4 2.5v11M12 2.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM12 5.5v.5a3 3 0 01-3 3H4",
  commit: "M1.5 8h4M10.5 8h4M8 5.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5z",
  repo: "M3.5 12.5v-9a1 1 0 011-1h8v9h-7.5a1.5 1.5 0 00-1.5 1.5 1.5 1.5 0 001.5 1.5h7.5",
  lock: "M4 7.5h8v6H4zM5.8 7.5V5.3a2.2 2.2 0 014.4 0v2.2",
  sync: "M13 6.5A5.2 5.2 0 003.6 5M3 9.5A5.2 5.2 0 0012.4 11M3.4 2.6v2.6H6M12.6 13.4v-2.6H10",
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
  plug: "M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 01-7 0zM8 11v3",
} as const;

export function DevGlyph({ d, size = 13, className, strokeWidth = 1.5, dashed }: { d: string; size?: number; className?: string; strokeWidth?: number; dashed?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("flex-none", className)}
      style={dashed ? { strokeDasharray: "2 1.6" } : undefined}
    >
      <path d={d} />
    </svg>
  );
}

/** The 36px (or 28px) provider tile (.ig-logo). */
export function ProviderLogo({ provider, small }: { provider: Provider; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex flex-none items-center justify-center border border-line-2 bg-raised text-fg",
        small ? "size-7 rounded-[7px]" : "size-9 rounded-[9px]",
      )}
    >
      <DevGlyph d={DEV_ICON[provider]} size={small ? 15 : 18} strokeWidth={1.4} />
    </span>
  );
}

/** "Copy" / "Copied" icon. */
export function CopyGlyph({ copied }: { copied: boolean }) {
  return copied ? <DevGlyph d={DEV_ICON.check} className="text-ok" strokeWidth={1.8} /> : <DevGlyph d={DEV_ICON.copy} strokeWidth={1.4} />;
}

/** Highlighted text parts (keys in a <mark>), built as React nodes, never innerHTML. */
export function KeyText({ parts }: { parts: { text: string; key: boolean }[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.key ? (
          <mark key={i} className="rounded-[3px] bg-accent-s px-0.5 font-semibold text-accent-t">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
