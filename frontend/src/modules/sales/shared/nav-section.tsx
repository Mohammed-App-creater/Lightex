"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SidebarSectionProps } from "@/registry";
import { useCurrentWorkspace } from "@/platform/roles/can";
import { cn } from "@/lib/utils/cn";
import { salesNavItems } from "./nav";
import { salesAreaOf } from "./routes";

const itemBase =
  "relative flex h-[30px] w-full items-center gap-2.5 rounded-[7px] px-2 text-[13px] font-medium text-fg-2 transition-colors duration-[var(--dur-fast)] ease-out hover:bg-hover hover:text-fg max-[1023px]:h-[42px]";

/** The expanded sidebar's collapsible "Sales" section (the rail shows the single Sales link instead). */
export function SalesNavSection({ open, onToggle, onNavigate }: SidebarSectionProps) {
  const ws = useCurrentWorkspace();
  const pathname = usePathname();
  const items = salesNavItems(ws?.my_permissions);
  if (!ws || items.length === 0) return null;
  const active = salesAreaOf(pathname);
  return (
    <>
      <div className="mt-3.5 flex h-7 items-center gap-1 pl-2 pr-1 font-mono text-[11px] font-medium uppercase leading-none tracking-[0.07em] text-fg-3">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left hover:text-fg-2">
          <ChevronDown size={10} strokeWidth={2} aria-hidden className={cn("flex-none transition-transform duration-[180ms] ease-out", !open && "-rotate-90")} />
          <span className="truncate">Sales</span>
        </button>
      </div>
      <div className="collapse-rows" data-open={open}>
        <div>
          <nav aria-label="Sales">
            {items.map((i) => (
              <Link
                key={i.area}
                href={i.href(ws.slug)}
                onClick={onNavigate}
                aria-current={active === i.area ? "page" : undefined}
                className={cn(itemBase, active === i.area && "bg-hover text-fg")}
              >
                <span className="flex size-4 flex-none items-center justify-center">
                  <i.icon size={16} strokeWidth={1.6} aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate">{i.label}</span>
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </>
  );
}
