import type { ComponentType, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Project } from "@/api/types";
import type { ProjectView, RouteInfo } from "@/platform/routes";
import { tracking } from "@/modules/tracking/module";

/*
 * Module registry (docs/platform-architecture.md §5 and §11). Each module declares its key, its name, the
 * navigation it adds to the shell and (platform Stage 2) the UI it contributes to platform screens: sidebar
 * sections and cards, shell overlays and command palette actions. Platform code renders these slots instead
 * of importing a module. Non-UI contributions (target types, notification text) live in `./services.ts`.
 * `enabled_modules`, route groups and required permissions per module arrive in Stage 3; until then every
 * registered module is on.
 */

export type ModuleKey = "tracking";

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
}

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
}

export { tracking };

/** Every module, in sidebar order. */
export const MODULES: readonly ModuleDefinition[] = [tracking];

export const moduleNavItems = () => MODULES.flatMap((m) => m.nav);
export const projectNavItems = () => MODULES.flatMap((m) => m.projectNav);
export const sidebarSections = () => MODULES.flatMap((m) => m.sidebarSections ?? []);
export const sidebarProjectCards = () => MODULES.flatMap((m) => m.sidebarProjectCards ?? []);
export const shellOverlays = () => MODULES.flatMap((m) => m.shellOverlays ?? []);
export const modulePaletteActions = (ctx: { currentProject: Project | null }) => MODULES.flatMap((m) => m.paletteActions?.(ctx) ?? []);
