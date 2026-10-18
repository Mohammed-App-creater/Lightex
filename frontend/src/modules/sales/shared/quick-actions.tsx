"use client";

import { CalendarPlus, ClipboardCheck, MapPin, Phone, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, useContext, useState, type ComponentType, type ReactNode } from "react";
import type { Permission, SalesBody } from "@/api/types";
import { usePermissions } from "@/platform/roles/can";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { toast } from "@/ui/toast";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils/cn";
import { devToolsEnabled } from "@/lib/env";
import { AddFollowUpDialog, LogCallDialog, LogVisitDialog } from "../activities/activity-dialogs";
import { useSlug } from "../api/queries";
import { salesRoutes } from "./routes";

/*
 * Quick actions (mobile-first): log a call, log a visit, add a follow-up, submit today's report. Anything in the sales
 * area calls `useQuickActions().open(kind, target?)`; the provider (mounted by the sales layout) renders the dialog
 * registered for that kind in `QUICK_ACTION_DIALOGS` (phase B fills it). "submit-report" navigates to the daily
 * report page instead.
 */

export type QuickActionKind = "log-call" | "log-visit" | "add-follow-up" | "submit-report";
/** The record the action is about (prefills the dialog), e.g. from an opportunity page. */
/** Activities also take contacts (`sales.contact`); follow-ups take leads, opportunities and companies. */
export type QuickActionTargetType = SalesBody<"sales_activities_create">["targetType"];
export type QuickActionTarget = { targetType: QuickActionTargetType; targetId: string; name?: string };
export type QuickActionDialogProps = { target: QuickActionTarget | null; onClose: () => void };

/** Phase B: register each dialog here (`QUICK_ACTION_DIALOGS["log-call"] = LogActivityDialog`). */
export const QUICK_ACTION_DIALOGS: Partial<Record<Exclude<QuickActionKind, "submit-report">, ComponentType<QuickActionDialogProps>>> = {
  "log-call": LogCallDialog,
  "log-visit": LogVisitDialog,
  "add-follow-up": AddFollowUpDialog,
};

export const QUICK_ACTIONS: { kind: QuickActionKind; label: string; icon: ComponentType<{ size?: number }>; permission: Permission }[] = [
  { kind: "log-call", label: "Log call", icon: Phone, permission: "sales.activity.create" },
  { kind: "log-visit", label: "Log visit", icon: MapPin, permission: "sales.activity.create" },
  { kind: "add-follow-up", label: "Add follow-up", icon: CalendarPlus, permission: "sales.followup.create" },
  { kind: "submit-report", label: "Submit daily report", icon: ClipboardCheck, permission: "sales.dailyreport.submit" },
];

type Open = { kind: QuickActionKind; target: QuickActionTarget | null };
type Ctx = { current: Open | null; open: (kind: QuickActionKind, target?: QuickActionTarget | null) => void; close: () => void };

const QuickCtx = createContext<Ctx | null>(null);

export function QuickActionsProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Open | null>(null);
  const router = useRouter();
  const slug = useSlug();
  const open = (kind: QuickActionKind, target: QuickActionTarget | null = null) => {
    if (kind === "submit-report") {
      router.push(salesRoutes.dailyReport(slug));
      return;
    }
    if (!QUICK_ACTION_DIALOGS[kind]) {
      toast.info("Coming soon");
      return;
    }
    setCurrent({ kind, target });
  };
  const close = () => setCurrent(null);
  const Dialog = current && current.kind !== "submit-report" ? QUICK_ACTION_DIALOGS[current.kind] : undefined;
  return (
    <QuickCtx.Provider value={{ current, open, close }}>
      {children}
      {Dialog && current && <Dialog target={current.target} onClose={close} />}
    </QuickCtx.Provider>
  );
}

/** `open(kind, target?)`; a no-op outside the sales area. */
export function useQuickActions(): Ctx {
  return useContext(QuickCtx) ?? { current: null, open: () => undefined, close: () => undefined };
}

/** The actions the viewer may use (hidden means not rendered). */
export function useAllowedQuickActions() {
  const check = usePermissions();
  return QUICK_ACTIONS.filter((a) => check(a.permission));
}

function Items({ target }: { target?: QuickActionTarget | null }) {
  const { open } = useQuickActions();
  return useAllowedQuickActions().map((a) => (
    <MenuItem key={a.kind} icon={<a.icon size={14} />} onSelect={() => open(a.kind, target)}>
      {a.label}
    </MenuItem>
  ));
}

/** A "Log activity" button with the menu, for screen headers (desktop). */
export function QuickActionsMenu({ target, className }: { target?: QuickActionTarget | null; className?: string }) {
  if (useAllowedQuickActions().length === 0) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" className={className}>
          <Plus size={14} aria-hidden /> Quick add
        </Button>
      </MenuTrigger>
      <MenuContent align="end" width={220}>
        <Items target={target} />
      </MenuContent>
    </Menu>
  );
}

/** The floating action button (below 1024px), mounted once by the sales layout. */
export function QuickActionsFab({ className }: { className?: string }) {
  if (useAllowedQuickActions().length === 0) return null;
  return (
    <Menu>
      <MenuTrigger
        aria-label="Quick actions"
        className={cn(
          "fixed right-4 z-30 flex size-14 items-center justify-center rounded-full on-accent bg-accent text-white shadow-pop min-[1024px]:hidden",
          // The mock's "Dev" pill sits at the bottom right: stay above it.
          devToolsEnabled ? "bottom-[calc(64px+env(safe-area-inset-bottom))]" : "bottom-[calc(16px+env(safe-area-inset-bottom))]",
          className,
        )}
      >
        <Plus size={22} aria-hidden />
      </MenuTrigger>
      <MenuContent align="end" side="top" width={240}>
        <Items />
      </MenuContent>
    </Menu>
  );
}
