import {
  Building2,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  Columns3,
  Contact,
  FileBarChart,
  LayoutDashboard,
  Settings,
  Target,
  TrendingUp,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/api/types";
import { can } from "@/platform/roles/can";
import { salesRoutes, type SalesArea } from "./routes";
import { hasAnySales } from "./scope";

export type SalesNavItem = { area: SalesArea; label: string; icon: LucideIcon; permission: Permission; href: (ws: string) => string };

/** The Sales sidebar section, in order; each item needs its own view permission. */
export const SALES_NAV: SalesNavItem[] = [
  { area: "dashboard", label: "Dashboard", icon: LayoutDashboard, permission: "sales.dashboard.view", href: salesRoutes.dashboard },
  { area: "pipeline", label: "Pipeline", icon: Columns3, permission: "sales.opportunity.view", href: salesRoutes.pipeline },
  { area: "leads", label: "Leads", icon: UserPlus, permission: "sales.lead.view", href: salesRoutes.leads },
  { area: "companies", label: "Companies", icon: Building2, permission: "sales.company.view", href: salesRoutes.companies },
  { area: "contacts", label: "Contacts", icon: Contact, permission: "sales.contact.view", href: salesRoutes.contacts },
  { area: "followUps", label: "Follow-ups", icon: CalendarClock, permission: "sales.followup.view", href: salesRoutes.followUps },
  { area: "targets", label: "Targets", icon: Target, permission: "sales.target.view", href: salesRoutes.targets },
  { area: "dailyReport", label: "Daily report", icon: ClipboardCheck, permission: "sales.dailyreport.submit", href: salesRoutes.dailyReport },
  { area: "dailyReports", label: "Team reports", icon: ClipboardList, permission: "sales.dailyreport.view", href: salesRoutes.dailyReports },
  { area: "performance", label: "Performance", icon: TrendingUp, permission: "sales.performance.view", href: salesRoutes.performance },
  { area: "reports", label: "Reports", icon: FileBarChart, permission: "sales.report.view", href: salesRoutes.reports },
  { area: "settings", label: "Settings", icon: Settings, permission: "sales.settings.manage", href: salesRoutes.settings },
];

/**
 * The items the viewer sees: none unless they hold some `sales.*` code (the registry already drops the section
 * while the module is off), then each item by its permission.
 */
export function salesNavItems(perms: readonly string[] | undefined | null): SalesNavItem[] {
  if (!hasAnySales(perms)) return [];
  return SALES_NAV.filter((i) => can(i.permission, perms));
}

