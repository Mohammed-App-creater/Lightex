"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/feedback";
import { can, useCurrentWorkspace } from "@/platform/roles/can";
import { routes, useRouteInfo } from "@/platform/routes";
import { routeAccess } from "@/registry";

/*
 * Platform Stage 3 route guard (docs/platform/stage3-contract.md §5): a route owned by a module that is turned off
 * renders "Module disabled" (people with core.modules.manage get a link to Settings → Modules); a module route
 * the viewer has no permission for renders a 403. Built from the registry plus `enabledModules` / `my_permissions`.
 */

function Frame({ children }: { children: ReactNode }) {
  return <div className="flex min-h-full items-center justify-center p-6">{children}</div>;
}

export function ModuleDisabledScreen({ name }: { name: string }) {
  const ws = useCurrentWorkspace()!;
  const manager = can("core.modules.manage", ws.my_permissions);
  return (
    <Frame>
      <EmptyState
        align="center"
        illustration="denied"
        title={`${name} is turned off`}
        body={
          manager
            ? `${name} is turned off for ${ws.name}. Turn it back on in Settings → Modules; its data was kept.`
            : `${name} is turned off for ${ws.name}. Ask a workspace owner or admin to turn it on.`
        }
        actions={
          manager ? (
            <Button variant="primary" asChild>
              <Link href={routes.settings(ws.slug, "modules")}>Open Modules settings</Link>
            </Button>
          ) : (
            <Button asChild>
              <Link href={routes.home(ws.slug)}>Back to My work</Link>
            </Button>
          )
        }
      />
    </Frame>
  );
}

export function ModuleForbiddenScreen({ name }: { name: string }) {
  const ws = useCurrentWorkspace()!;
  return (
    <Frame>
      <EmptyState
        align="center"
        illustration="denied"
        title={`You don’t have access to ${name}`}
        body="Your workspace role doesn’t include this module. A workspace admin can change that in Settings → Roles."
        actions={
          <Button asChild>
            <Link href={routes.home(ws.slug)}>Back to My work</Link>
          </Button>
        }
      />
    </Frame>
  );
}

/** Wraps the shell's page: renders the module screens above instead of a guarded route. */
export function ModuleRouteGuard({ children }: { children: ReactNode }) {
  const ws = useCurrentWorkspace()!;
  const { pathname } = useRouteInfo();
  const access = routeAccess(ws, pathname.split("/").filter(Boolean)[1]);
  if (access.kind === "disabled") return <ModuleDisabledScreen name={access.module.name} />;
  if (access.kind === "forbidden") return <ModuleForbiddenScreen name={access.module.name} />;
  return <>{children}</>;
}
