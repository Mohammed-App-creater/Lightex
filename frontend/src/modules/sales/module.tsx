import { Briefcase } from "lucide-react";
import { routes } from "@/platform/routes";
import type { ModuleDefinition } from "@/registry";

/*
 * The sales module (docs/platform-architecture.md §10, docs/platform/stage3-contract.md §4): a placeholder that
 * proves a toggleable module end to end (nav item, guarded route, permission, health endpoint).
 */
export const sales: ModuleDefinition = {
  key: "sales",
  name: "Sales",
  icon: Briefcase,
  routes: [{ segment: "sales", permission: "sales.health.view" }],
  nav: [{ id: "sales", label: "Sales", icon: Briefcase, href: (ws) => routes.sales(ws), page: "sales", permission: "sales.health.view" }],
  projectNav: [],
};
