"use client";

import { CalendarClock, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import type { SalesOpportunity } from "@/api/types";
import { cn } from "@/lib/utils/cn";
import { useCan } from "@/platform/roles/can";
import { Avatar } from "@/ui/avatar";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { useSlug } from "../api";
import { formatMoney } from "../shared/money";
import { salesRoutes } from "../shared/routes";
import { formatDay } from "./url-state";

export type CardAction = "won" | "lost";

/** Flag chips: overdue close, no next step, stale (computed by the server). */
export function OppFlags({ opp, className }: { opp: SalesOpportunity; className?: string }) {
  const f = opp.flags;
  if (!f || (!f.overdueClose && !f.noNextStep && !f.stale)) return null;
  const chip = "inline-flex h-[18px] items-center rounded-sm px-1.5 text-[11px] font-medium";
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {f.overdueClose && <span className={cn(chip, "bg-danger-s text-danger")}>Overdue close</span>}
      {f.noNextStep && <span className={cn(chip, "bg-warn-s text-warn")}>No next step</span>}
      {f.stale && <span className={cn(chip, "bg-raised text-fg-2")}>Stale</span>}
    </span>
  );
}

/** A pipeline card (title, company, value, owner, close date, flags) with the Won / Lost menu. */
export function OppCard({
  opp,
  onAction,
  dragging,
  overlay,
}: {
  opp: SalesOpportunity;
  onAction?: (a: CardAction, opp: SalesOpportunity) => void;
  dragging?: boolean;
  overlay?: boolean;
}) {
  const ws = useSlug();
  const canClose = useCan("sales.opportunity.close") && opp.canClose && opp.status === "open";
  return (
    <article
      className={cn(
        "group relative flex flex-col gap-1.5 rounded-md border border-line bg-surface p-3 text-left shadow-edge transition-[box-shadow,opacity] duration-[var(--dur-fast)]",
        dragging && "opacity-40",
        overlay && "rotate-[1.5deg] shadow-pop",
      )}
    >
      <div className="flex items-start gap-2">
        <Link href={salesRoutes.opportunity(ws, opp.id)} className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-fg hover:underline" onPointerDown={(e) => e.stopPropagation()}>
          {opp.title}
        </Link>
        {canClose && onAction && (
          <Menu>
            <MenuTrigger
              aria-label={`Actions for ${opp.title}`}
              onPointerDown={(e) => e.stopPropagation()}
              className="-mr-1 -mt-0.5 rounded-sm p-0.5 text-fg-3 hover:bg-hover hover:text-fg max-[1023px]:p-1.5"
            >
              <MoreHorizontal size={14} aria-hidden />
            </MenuTrigger>
            <MenuContent align="end" width={180}>
              <MenuItem onSelect={() => onAction("won", opp)}>Mark won…</MenuItem>
              <MenuItem onSelect={() => onAction("lost", opp)}>Mark lost…</MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      <span className="truncate text-[12px] text-fg-2">{opp.company.name}</span>
      <div className="flex items-center gap-2">
        <span className="tabular font-mono text-[12px] font-medium">{formatMoney(opp.expectedValue, { compact: true })}</span>
        {opp.expectedCloseDate && (
          <span className={cn("inline-flex items-center gap-1 text-[11px]", opp.flags?.overdueClose ? "text-danger" : "text-fg-3")}>
            <CalendarClock size={12} aria-hidden />
            {formatDay(opp.expectedCloseDate)}
          </span>
        )}
        {opp.owner && (
          <span className="ml-auto" title={opp.owner.name}>
            <Avatar name={opp.owner.name} hue={opp.owner.hue} size={20} />
          </span>
        )}
      </div>
      <OppFlags opp={opp} />
    </article>
  );
}
