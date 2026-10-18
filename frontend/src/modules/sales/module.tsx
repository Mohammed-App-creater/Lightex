import { Briefcase } from "lucide-react";
import { routes } from "@/platform/routes";
import type { ModuleDefinition } from "@/registry";
import { SalesNavSection } from "./shared/nav-section";

/*
 * The sales module (docs/sales/spec.md, frontend/docs/sales-frontend.md). The shell guards every `/sales/*` route with
 * `sales.dashboard.view` (the "can use Sales" code every sales role holds); each screen then gates itself with its
 * own view permission (`SalesGate`). The expanded sidebar shows the "Sales" section; the collapsed rail one link.
 */
export const sales: ModuleDefinition = {
  key: "sales",
  name: "Sales",
  icon: Briefcase,
  routes: [{ segment: "sales", permission: "sales.dashboard.view" }],
  nav: [{ id: "sales", label: "Sales", icon: Briefcase, href: (ws) => routes.sales(ws), page: "sales", permission: "sales.dashboard.view", railOnly: true }],
  projectNav: [],
  sidebarSections: [{ id: "sales.nav", Component: SalesNavSection }],
};
