"use client";

import dynamic from "next/dynamic";
import { useRouter, usePathname } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";
import { AppLoader } from "@/components/brand/app-loader";
import { Drawer } from "@/components/ui/modal";
import { useSession } from "@/features/auth/session";
import { SessionExpiredModal } from "@/features/auth/session-expired";
import { useWorkspace } from "@/features/workspace/queries";
import { isNotFound } from "@/lib/api/errors";
import { useIsCompact } from "@/lib/hooks/use-media-query";
import { WorkspaceScope } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { ErrorScreen, NotFoundScreen } from "./edge-screens";
import { DevTools } from "./dev-tools";
import { GlobalHotkeys } from "./global-hotkeys";
import { OfflineBanner } from "./offline-banner";
import { shell, useShell } from "./shell-state";
import { Sidebar } from "./sidebar";
import { TopBar, TopBarSlotProvider } from "./top-bar";

// Overlays open on demand: split out of the shell chunk so first paint doesn't wait for cmdk/Tiptap.
const CommandPalette = dynamic(() => import("@/features/palette/command-palette").then((m) => m.CommandPalette), { ssr: false });
const CreateTaskDialog = dynamic(() => import("@/features/tasks/create-task-dialog").then((m) => m.CreateTaskDialog), { ssr: false });
const ShortcutsDialog = dynamic(() => import("./shortcuts-dialog").then((m) => m.ShortcutsDialog), { ssr: false });

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
    <AuthGate>
      <WorkspaceLoader slug={slug}>{children}</WorkspaceLoader>
    </AuthGate>
  );
}

function WorkspaceLoader({ slug, children }: { slug: string; children: ReactNode }) {
  const ws = useWorkspace(slug);
  if (ws.isPending) return <AppLoader />;
  if (ws.isError) {
    if (isNotFound(ws.error)) return <NotFoundScreen path={`/${slug}`} />;
    return <ErrorScreen error={ws.error} onRetry={() => void ws.refetch()} />;
  }
  return (
    <WorkspaceScope workspace={ws.data}>
      <Shell>{children}</Shell>
    </WorkspaceScope>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { collapsed, drawer } = useShell();
  const compact = useIsCompact();
  useEffect(() => shell.hydrate(), []);

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
