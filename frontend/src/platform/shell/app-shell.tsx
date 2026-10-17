"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, usePathname } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";
import { AppLoader } from "@/components/brand/app-loader";
import { Drawer } from "@/components/ui/modal";
import { useSession } from "@/features/auth/session";
import { SessionExpiredModal } from "@/features/auth/session-expired";
import { PushSync } from "@/features/notifications/channels/sw-bridge";
import { useWorkspace } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { isNotFound } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import { lazyWithPreload, whenIdle } from "@/lib/hooks/lazy-with-preload";
import { useIsCompact } from "@/lib/hooks/use-media-query";
import { WorkspaceScope } from "@/lib/permissions/can";
import { routes, useRouteInfo } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { ErrorScreen, NotFoundScreen } from "./edge-screens";
import { DevTools } from "./dev-tools";
import { GlobalHotkeys } from "./global-hotkeys";
import { OfflineBanner } from "./offline-banner";
import { shell, useShell } from "./shell-state";
import { Sidebar } from "./sidebar";
import { TopBar, TopBarSlotProvider } from "./top-bar";

// Overlays open on demand: split out of the shell chunk so first paint doesn't wait for cmdk/Tiptap.
// They are warmed once the shell is idle, so the first ⌘K / "c" / "?" opens without a Suspense delay.
const { Component: CommandPalette, preload: preloadPalette } = lazyWithPreload(() => import("@/features/palette/command-palette").then((m) => m.CommandPalette));
const { Component: CreateTaskDialog, preload: preloadCreateTask } = lazyWithPreload(() => import("@/features/tasks/create-task-dialog").then((m) => m.CreateTaskDialog));
const { Component: ShortcutsDialog, preload: preloadShortcuts } = lazyWithPreload(() => import("./shortcuts-dialog").then((m) => m.ShortcutsDialog));

/** Redirects anonymous visitors to /login?next=… and shows the loader while the session boots. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (status === "anonymous") router.replace(routes.login(pathname));
  }, [status, router, pathname]);
  if (status !== "authenticated") return <AppLoader />;
  return <>{children}</>;
}

export function WorkspaceShell({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <>
      <RoutePrefetch slug={slug} />
      <AuthGate>
        <WorkspaceLoader slug={slug}>{children}</WorkspaceLoader>
      </AuthGate>
    </>
  );
}

/**
 * Starts the workspace, project-list and current-project requests as soon as the transport can
 * send them, in parallel with /auth/me, instead of one after another once the gate opens.
 * The gated screens below use the same query keys, so they pick up these in-flight requests.
 */
function RoutePrefetch({ slug }: { slug: string }) {
  const { ready, status } = useSession();
  const { projectKey } = useRouteInfo();
  const enabled = ready && status !== "anonymous";
  useQuery({ queryKey: qk.workspace(slug), queryFn: () => api.workspaces.get(slug), enabled });
  useQuery({ queryKey: qk.projects(slug), queryFn: () => api.projects.list(slug), enabled });
  useQuery({
    queryKey: qk.project(slug, projectKey ?? ""),
    queryFn: () => api.projects.get(slug, projectKey!),
    enabled: enabled && Boolean(projectKey),
  });
  return null;
}

function WorkspaceLoader({ slug, children }: { slug: string; children: ReactNode }) {
  const ws = useWorkspace(slug);
  if (ws.isPending) return <AppLoader />;
  if (ws.isError) {
    if (isNotFound(ws.error)) return <NotFoundScreen path={`/${slug}`} />;
    return <ErrorScreen error={ws.error} onRetry={() => ws.refetch()} />;
  }
  return (
    <WorkspaceScope workspace={ws.data}>
      {/* Board 38: re-sync this browser's push subscription once per tab session. */}
      <PushSync />
      <Shell>{children}</Shell>
    </WorkspaceScope>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { collapsed, drawer } = useShell();
  const compact = useIsCompact();
  useEffect(() => shell.hydrate(), []);
  useEffect(
    () =>
      whenIdle(() => {
        preloadPalette();
        preloadCreateTask();
        preloadShortcuts();
      }),
    [],
  );

  return (
    <TopBarSlotProvider>
      {(setSlot) => (
        <div className="flex h-dvh overflow-hidden bg-bg">
          <a
            href="#main"
            className="sr-only-focusable fixed left-3 top-3 z-[100] rounded-md bg-accent px-3 py-2 font-medium text-white"
          >
            Skip to content
          </a>
          {!compact && (
            <aside
              className={cn(
                "relative z-[3] h-full flex-none border-r border-line bg-surface transition-[width] duration-[220ms] ease-out motion-reduce:transition-none",
                collapsed ? "w-16 overflow-visible" : "w-[264px] overflow-hidden",
              )}
            >
              <Sidebar rail={collapsed} />
            </aside>
          )}
          {compact && (
            <Drawer open={drawer} onOpenChange={shell.setDrawer} title="Navigation">
              <Sidebar touch onClose={() => shell.setDrawer(false)} />
            </Drawer>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar compact={compact} setSlot={setSlot} />
            <OfflineBanner />
            <main id="main" tabIndex={-1} className="relative min-h-0 flex-1 overflow-auto outline-none">
              {children}
            </main>
          </div>
          <GlobalHotkeys />
          <CommandPalette />
          <CreateTaskDialog />
          <ShortcutsDialog />
          <SessionExpiredModal />
          <Suspense fallback={null}>
            <DevTools />
          </Suspense>
        </div>
      )}
    </TopBarSlotProvider>
  );
}
