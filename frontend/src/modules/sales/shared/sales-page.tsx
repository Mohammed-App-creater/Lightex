"use client";

import type { ReactNode } from "react";
import type { Permission } from "@/api/types";
import { useCan } from "@/platform/roles/can";
import { ModuleForbiddenScreen } from "@/platform/shell/module-screens";
import { EmptyState } from "@/ui/feedback";

/**
 * Page-level gate. The shell's route guard only checks `sales.dashboard.view` for every `/sales/*` route; each
 * screen wraps itself in `SalesGate` with its own view permission (docs: frontend/docs/sales-frontend.md §Gating).
 */
export function SalesGate({ permission, name, children }: { permission: Permission; name: string; children: ReactNode }) {
  return useCan(permission) ? <>{children}</> : <ModuleForbiddenScreen name={name} />;
}

/** The standard sales page frame: title row (with optional actions) and body. */
export function SalesPageFrame({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col gap-5 px-6 pb-24 pt-[22px] max-[760px]:px-4 max-[760px]:pt-4 min-[1024px]:pb-7">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 min-w-0 truncate text-[20px] font-semibold leading-7 tracking-[-0.015em] max-[760px]:text-[17px]">{title}</h1>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/** Phase A placeholder; phase B replaces each `<Area>Screen` with the real one. */
export function SalesPlaceholder({ title, permission }: { title: string; permission: Permission }) {
  return (
    <SalesGate permission={permission} name={title}>
      <SalesPageFrame title={title}>
        <EmptyState title={`${title} is coming soon`} body="This sales screen is being built." />
      </SalesPageFrame>
    </SalesGate>
  );
}
