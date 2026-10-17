import type { ComponentType, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Notification, Permission, Project, User, Workspace } from "@/api/types";
import type { ProjectView, RouteInfo } from "@/platform/routes";
import { sales } from "@/modules/sales/module";
import { tracking } from "@/modules/tracking/module";

/*
 * Module registry (docs/platform-architecture.md §5 and §11). Each module declares its key, its name, the
 * navigation it adds to the shell and (platform Stage 2) the UI it contributes to platform screens: sidebar
 * sections and cards, shell overlays and command palette actions. Platform code renders these slots instead
 * of importing a module. Non-UI contributions (target types, notification text) live in `./services.ts`.
 *
 * Stage 3: every slot is filtered by the workspace's `enabledModules` plus its `my_permissions` (`ModuleContext`),
 * and each module names the workspace routes it owns so the shell can guard them.
 */

export type ModuleKey = "tracking" | "sales";

/** What the slot filters read: a workspace's enabled modules and permissions. */
export type ModuleContext = Pick<Workspace, "enabledModules" | "my_permissions">;

/** A workspace-level sidebar link (expanded sidebar and collapsed rail). */
export interface ModuleNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  href: (ws: string) => string;
  /** The `useRouteInfo().page` that marks the item active. */
  page: RouteInfo["page"];
  /** Shortcut shown in the rail tooltip. */
  keys?: string[];
  /** Workspace permission needed to see the item (and open its route). */
  permission?: Permission;
}

/** A first path segment under `/[workspace]/` owned by a module (`sales`, `projects`…). */
export interface ModuleRoute {
  segment: string;
  /** Workspace permission needed to open it; without it the shell shows a 403. */
  permission?: Permission;
}

/** Props of a notification's target preview in the inbox (the task chips for `tracking.task`). */
export type TargetPreviewProps = { n: Notification; slug: string; members: Map<string, User> };

/** A link under each project in the sidebar's project accordion. */
export interface ModuleProjectNavItem {
  view: ProjectView;
  label: string;
  icon: LucideIcon;
  /** Hidden unless this returns true for the project's `my_permissions`. */
  gate?: (perms: string[]) => boolean;
}

/** A command palette action. */
export interface PaletteAction {
  id: string;
  label: string;
  keys: string[];
  icon: ReactNode;
  run: () => void | Promise<void>;
  /** Hidden unless allowed (permission-gated actions are absent, not disabled). */
  allowed: boolean;
}

export type SidebarSectionProps = { open: boolean; onToggle: () => void; onNavigate?: () => void };
export type SidebarProjectCardProps = { project: Project | undefined; ws: string; rail?: boolean; onNavigate?: () => void };

export interface ModuleDefinition {
  key: ModuleKey;
  name: string;
  icon: LucideIcon;
  /** Workspace routes this module owns: a disabled module's routes render the "Module disabled" screen. */
  routes: ModuleRoute[];
  nav: ModuleNavItem[];
  projectNav: ModuleProjectNavItem[];
  /** Collapsible sections between the workspace links and Projects (expanded sidebar only). */
  sidebarSections?: { id: string; Component: ComponentType<SidebarSectionProps> }[];
  /** Cards for the current project at the foot of the sidebar (expanded and rail). */
  sidebarProjectCards?: { id: string; Component: ComponentType<SidebarProjectCardProps> }[];
  /** Global overlays mounted once by the app shell; `preload` warms their chunk when the shell is idle. */
  shellOverlays?: { id: string; Component: ComponentType; preload: () => void }[];
  /** Actions added to the command palette after "Create task". */
  paletteActions?: (ctx: { currentProject: Project | null }) => PaletteAction[];
  /**
   * Inbox previews of notifications by target type. `fallback` claims notifications from before Stage 2 that
   * carry no `targetType`.
   */
  targetPreviews?: { targetType: string; fallback?: (n: Notification) => boolean; Component: ComponentType<TargetPreviewProps> }[];
}

export { sales, tracking };

/** Every module, in sidebar order. */
export const MODULES: readonly ModuleDefinition[] = [tracking, sales];

/** Is the module turned on for the workspace? Core is always on. */
export const isModuleEnabled = (ctx: Pick<Workspace, "enabledModules">, key: string) => key === "core" || ctx.enabledModules.includes(key);

/** The modules turned on for the workspace, in sidebar order. */
export const activeModules = (ctx: ModuleContext, modules: readonly ModuleDefinition[] = MODULES) =>
  modules.filter((m) => isModuleEnabled(ctx, m.key));

const allowed = (ctx: ModuleContext, permission?: Permission) => !permission || (ctx.my_permissions as readonly string[]).includes(permission);

export const moduleNavItems = (ctx: ModuleContext, modules: readonly ModuleDefinition[] = MODULES) =>
  activeModules(ctx, modules).flatMap((m) => m.nav.filter((i) => allowed(ctx, i.permission)));
export const projectNavItems = (ctx: ModuleContext) => activeModules(ctx).flatMap((m) => m.projectNav);
export const sidebarSections = (ctx: ModuleContext) => activeModules(ctx).flatMap((m) => m.sidebarSections ?? []);
export const sidebarProjectCards = (ctx: ModuleContext) => activeModules(ctx).flatMap((m) => m.sidebarProjectCards ?? []);
export const shellOverlays = (ctx: ModuleContext) => activeModules(ctx).flatMap((m) => m.shellOverlays ?? []);
export const modulePaletteActions = (ctx: ModuleContext, palette: { currentProject: Project | null }) =>
  activeModules(ctx).flatMap((m) => m.paletteActions?.(palette) ?? []);

/** Where a workspace route stands: open, owned by a disabled module, or missing the route's permission. */
export type RouteAccess = { kind: "ok" } | { kind: "disabled"; module: ModuleDefinition } | { kind: "forbidden"; module: ModuleDefinition; permission: Permission };

/** The route guard: `segment` is the first path segment under `/[workspace]/` (`sales`, `projects`…). */
export function routeAccess(ctx: ModuleContext, segment: string | undefined, modules: readonly ModuleDefinition[] = MODULES): RouteAccess {
  for (const m of modules) {
    const r = m.routes.find((x) => x.segment === segment);
    if (!r) continue;
    if (!isModuleEnabled(ctx, m.key)) return { kind: "disabled", module: m };
    if (!allowed(ctx, r.permission)) return { kind: "forbidden", module: m, permission: r.permission! };
    return { kind: "ok" };
  }
  return { kind: "ok" };
}

/** The inbox previews for a notification's target (at most one), from the enabled modules. */
export function targetPreviewsFor(ctx: ModuleContext, n: Notification) {
  const previews = activeModules(ctx).flatMap((m) => m.targetPreviews ?? []);
  const hit = n.targetType ? previews.find((p) => p.targetType === n.targetType) : previews.find((p) => p.fallback?.(n));
  return hit ? [hit] : [];
}
