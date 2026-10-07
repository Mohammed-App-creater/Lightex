import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/*
 * Empty-state illustrations (board 35). 160×120 grid, 1.5px line, radius 6, one accent element
 * (--accent-t) and one spark (--spark), all colours from theme tokens so they work in navy, black
 * and light. Each has exactly one idle motion (.il-* in globals.css); motion pauses with `still`
 * and is removed under prefers-reduced-motion.
 */

export type IllustrationName = "projects" | "tasks" | "results" | "notifs" | "caught" | "denied" | "error" | "offline";

const sparkPath = (r: number) => {
  const c = +(r * 0.24).toFixed(2);
  return `M0-${r}L${c}-${c} ${r} 0 ${c} ${c} 0 ${r}-${c} ${c}-${r} 0-${c}-${c}Z`;
};

function Spark({ x, y, r = 5, className }: { x: number; y: number; r?: number; className?: string }) {
  // The CSS animation (twinkle) sets `transform`, which would override a transform attribute on
  // the same node, so the position lives on a wrapper group.
  return (
    <g transform={`translate(${x} ${y})`}>
      <path className={className} d={sparkPath(r)} fill="var(--spark)" stroke="none" />
    </g>
  );
}

const Ground = () => <path d="M28 102H132" stroke="var(--line-2)" />;

const ART: Record<IllustrationName, { label: string; motion: string; art: ReactNode }> = {
  projects: {
    label: "No projects",
    motion: "bob",
    art: (
      <>
        <Ground />
        <path d="M40 46a6 6 0 0 1 6-6h20l7 7h41a6 6 0 0 1 6 6v37a6 6 0 0 1-6 6H46a6 6 0 0 1-6-6Z" fill="var(--surface)" stroke="var(--text-2)" />
        <path d="M40 58H120" stroke="var(--text-3)" />
        <path d="M52 72h30M52 80h18" stroke="var(--text-3)" strokeDasharray="2 4" />
        <g className="il-bob">
          <circle cx="116" cy="40" r="12" fill="var(--bg)" stroke="var(--accent-t)" />
          <path d="M116 34.5v11M110.5 40h11" stroke="var(--accent-t)" />
        </g>
        <Spark x={134} y={25} />
      </>
    ),
  },
  tasks: {
    label: "No tasks",
    motion: "breathe",
    art: (
      <>
        <Ground />
        <rect x="30" y="28" width="100" height="68" rx="6" fill="var(--surface)" stroke="var(--text-2)" />
        <path d="M63.3 28v68M96.7 28v68" stroke="var(--text-3)" />
        <path d="M38 38h14M71 38h14M104 38h14" stroke="var(--text-3)" />
        <rect className="il-breathe" x="69.5" y="47" width="21" height="16" rx="3" stroke="var(--accent-t)" strokeDasharray="3 3" />
        <Spark x={94} y={43} />
      </>
    ),
  },
  results: {
    label: "No results",
    motion: "sway",
    art: (
      <>
        <Ground />
        <rect x="32" y="28" width="76" height="66" rx="6" fill="var(--surface)" stroke="var(--text-3)" />
        <path d="M42 42h40M42 54h52M42 66h30M42 78h44" stroke="var(--text-3)" opacity=".6" />
        <g className="il-sway">
          <circle cx="104" cy="62" r="17" fill="var(--surface)" stroke="var(--accent-t)" />
          <path d="M116.5 74.5L128 86" stroke="var(--text-2)" />
          <path d="M97 62h14" stroke="var(--text-3)" />
        </g>
        <Spark x={96} y={51} r={4} />
      </>
    ),
  },
  notifs: {
    label: "No notifications",
    motion: "swing",
    art: (
      <>
        <Ground />
        <g className="il-swing">
          <path d="M80 36v6" stroke="var(--text-2)" />
          <path d="M62 78V60a18 18 0 0 1 36 0v18l5 6H57Z" fill="var(--surface)" stroke="var(--text-2)" />
          <path d="M74 88a6 6 0 0 0 12 0" stroke="var(--text-3)" />
        </g>
        <path d="M106 36h8l-8 9h8M119 24h6l-6 7h6" stroke="var(--accent-t)" />
        <Spark x={52} y={42} />
      </>
    ),
  },
  caught: {
    label: "All caught up",
    motion: "twinkle",
    art: (
      <>
        <Ground />
        <path d="M38 68l10-26h64l10 26v22a6 6 0 0 1-6 6H44a6 6 0 0 1-6-6Z" fill="var(--surface)" stroke="var(--text-2)" />
        <path d="M38 68h24l4 8h28l4-8h24" stroke="var(--text-2)" />
        <circle cx="80" cy="34" r="12" fill="var(--bg)" stroke="var(--accent-t)" />
        <path d="M74.5 34.5l4 4 7-8" stroke="var(--accent-t)" />
        <Spark x={102} y={20} r={5.5} className="il-twinkle" />
      </>
    ),
  },
  denied: {
    label: "Permission denied",
    motion: "lift",
    art: (
      <>
        <Ground />
        <rect x="38" y="24" width="58" height="72" rx="6" fill="var(--surface)" stroke="var(--text-3)" />
        <path d="M48 38h30M48 48h38M48 58h24" stroke="var(--text-3)" />
        <path className="il-lift" d="M98 66v-8a10 10 0 0 1 20 0v8" stroke="var(--accent-t)" />
        <rect x="92" y="66" width="32" height="26" rx="6" fill="var(--surface)" stroke="var(--text-2)" />
        <path d="M108 76v6" stroke="var(--text-2)" />
        <Spark x={128} y={50} />
      </>
    ),
  },
  error: {
    label: "Error",
    motion: "blink",
    art: (
      <>
        <Ground />
        <rect x="30" y="26" width="100" height="70" rx="6" fill="var(--surface)" stroke="var(--text-2)" />
        <path d="M30 38h100" stroke="var(--text-3)" />
        <path d="M37 32h.01M42 32h.01M47 32h.01" stroke="var(--text-3)" strokeWidth="2.5" />
        <path d="M40 84l10-9 9 5 7-9" stroke="var(--text-3)" />
        <path d="M94 74l8 4 12-14" stroke="var(--text-3)" strokeDasharray="2 4" />
        <g className="il-blink">
          <path d="M80 48l12.5 21h-25Z" fill="var(--bg)" stroke="var(--accent-t)" />
          <path d="M80 56v6M80 65.5h.01" stroke="var(--accent-t)" />
        </g>
        <Spark x={106} y={50} r={4.5} />
      </>
    ),
  },
  offline: {
    label: "Offline",
    motion: "drift",
    art: (
      <>
        <Ground />
        <g className="il-drift">
          <path d="M54 78H108a14 14 0 0 0 0-28a20 20 0 0 0-38-6a17 17 0 0 0-16 34Z" fill="var(--surface)" stroke="var(--text-2)" />
          <path d="M56 94L108 32" stroke="var(--accent-t)" />
        </g>
        <path d="M70 90h.01M80 90h.01M90 90h.01" stroke="var(--text-3)" strokeWidth="2.5" />
        <Spark x={120} y={30} />
      </>
    ),
  },
};

export const ILLUSTRATIONS = (Object.keys(ART) as IllustrationName[]).map((name) => ({
  name,
  label: ART[name].label,
  motion: ART[name].motion,
}));

/**
 * One empty-state illustration. Decorative by default (the empty state's title says the same);
 * pass `title` to expose it as an image.
 */
export function Illustration({
  name,
  width = 160,
  still,
  title,
  className,
}: {
  name: IllustrationName;
  /** Rendered width in px; height keeps the 4:3 grid. */
  width?: number;
  /** Pause the idle motion. */
  still?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 160 120"
      width={width}
      height={(width * 3) / 4}
      className={cn("illustration flex-none", still && "il-still", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-illustration={name}
    >
      <g fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {ART[name].art}
      </g>
    </svg>
  );
}
