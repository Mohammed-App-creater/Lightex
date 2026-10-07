"use client";

import { useId, type CSSProperties } from "react";
import { cn } from "@/lib/utils/cn";

/*
 * "The cut x" (board 08, final). Straight stroke is neutral (--text), the bolt is --logo.
 * A mask cuts a 2.5-unit gap out of the straight stroke where the bolt crosses.
 * Text cut for > 64px and the wordmark; icon cut (strokes +15%) at ≤ 64px.
 */

const CUTS = {
  text: { bolt: "M50 -5L27 17H38L-4 44", boltW: 8.5, barW: 9.5, maskW: 13.5 },
  icon: { bolt: "M50 -5L26 18H39L-4 44", boltW: 10, barW: 11, maskW: 16 },
} as const;

export function LogoMark({
  cut = "text",
  className,
  style,
  bar = "var(--text)",
  bolt = "var(--logo)",
  title,
  parts,
}: {
  cut?: keyof typeof CUTS;
  className?: string;
  style?: CSSProperties;
  bar?: string;
  bolt?: string;
  title?: string;
  /** Class names for animating the individual parts (loader). */
  parts?: { bar?: string; bolt?: string; flash?: string; whole?: string };
}) {
  const uid = useId().replace(/:/g, "");
  const c = CUTS[cut];
  return (
    <svg
      viewBox="0 0 46 39"
      className={cn("overflow-visible", className)}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <clipPath id={`c${uid}`}>
          <rect width="46" height="39" />
        </clipPath>
        <mask id={`m${uid}`} maskUnits="userSpaceOnUse" x="-10" y="-10" width="70" height="60">
          <rect x="-10" y="-10" width="70" height="60" fill="#fff" />
          <path d={c.bolt} fill="none" stroke="#000" strokeWidth={c.maskW} strokeLinejoin="miter" strokeMiterlimit={10} />
        </mask>
      </defs>
      <g className={parts?.whole} style={{ transformBox: "fill-box", transformOrigin: "center" }}>
        <g clipPath={`url(#c${uid})`}>
          <path
            d="M-4 -4L50 43"
            stroke={bar}
            strokeWidth={c.barW}
            fill="none"
            mask={`url(#m${uid})`}
            className={parts?.bar}
          />
          <path
            d={c.bolt}
            stroke={bolt}
            strokeWidth={c.boltW}
            fill="none"
            strokeLinejoin="miter"
            strokeMiterlimit={10}
            className={parts?.bolt}
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
          />
        </g>
        {parts?.flash && (
          <circle
            cx="23"
            cy="19.5"
            r="24"
            fill="none"
            stroke="var(--spark)"
            strokeWidth="1.5"
            className={parts.flash}
            style={{ transformBox: "fill-box", transformOrigin: "center", opacity: 0 }}
          />
        )}
      </g>
    </svg>
  );
}

/** "Lighte" + cut x. Inter 600, −0.04em; x is .644em × .546em on the baseline. */
export function Wordmark({ size = 18, className, wordClassName, markParts }: {
  size?: number;
  className?: string;
  wordClassName?: string;
  markParts?: Parameters<typeof LogoMark>[0]["parts"];
}) {
  return (
    <span
      role="img"
      aria-label="Lightex"
      className={cn("inline-flex items-baseline whitespace-nowrap font-semibold leading-none tracking-[-0.04em] text-fg", className)}
      style={{ fontSize: size }}
    >
      <span aria-hidden className={wordClassName}>
        Lighte
      </span>
      <LogoMark className="ml-[.02em] h-[.546em] w-[.644em] flex-none" parts={markParts} />
    </span>
  );
}

/** App icon tile with the icon cut. Used for collapsed sidebar, favicons and the loader. */
export function AppIcon({ size = 24, className, variant = "tile" }: {
  size?: number;
  className?: string;
  variant?: "tile" | "plain";
}) {
  if (variant === "plain") return <LogoMark cut="icon" className={className} style={{ width: size, height: size * 0.85 }} />;
  return (
    <span
      aria-hidden
      className={cn("inline-flex flex-none items-center justify-center border border-line-2 bg-raised", className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.25) }}
    >
      <LogoMark cut="icon" style={{ width: size * 0.62, height: size * 0.53 }} bar="var(--text)" />
    </span>
  );
}
