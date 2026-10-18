/* Sales URLs (all under `/[workspace]/sales`). Contacts have no page of their own: `?contact=<id>` opens one. */

const base = (ws: string) => `/${ws}/sales`;
const id = encodeURIComponent;

export const salesRoutes = {
  dashboard: (ws: string) => base(ws),
  pipeline: (ws: string) => `${base(ws)}/pipeline`,
  opportunity: (ws: string, oppId: string) => `${base(ws)}/opportunities/${id(oppId)}`,
  leads: (ws: string) => `${base(ws)}/leads`,
  lead: (ws: string, leadId: string) => `${base(ws)}/leads/${id(leadId)}`,
  companies: (ws: string) => `${base(ws)}/companies`,
  company: (ws: string, companyId: string) => `${base(ws)}/companies/${id(companyId)}`,
  contacts: (ws: string) => `${base(ws)}/contacts`,
  contact: (ws: string, contactId: string) => `${base(ws)}/contacts?contact=${id(contactId)}`,
  followUps: (ws: string) => `${base(ws)}/follow-ups`,
  targets: (ws: string) => `${base(ws)}/targets`,
  dailyReport: (ws: string) => `${base(ws)}/daily-report`,
  dailyReports: (ws: string) => `${base(ws)}/daily-reports`,
  performance: (ws: string) => `${base(ws)}/performance`,
  performanceUser: (ws: string, userId: string) => `${base(ws)}/performance/${id(userId)}`,
  reports: (ws: string) => `${base(ws)}/reports`,
  report: (ws: string, key: string) => `${base(ws)}/reports/${id(key)}`,
  settings: (ws: string) => `${base(ws)}/settings`,
};

export type SalesArea = Exclude<keyof typeof salesRoutes, "opportunity" | "lead" | "company" | "contact" | "performanceUser" | "report">;

/** Which area a pathname is in (`/acme/sales/leads/123` → "leads"), for the sidebar's active item. */
export function salesAreaOf(pathname: string): SalesArea | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[1] !== "sales") return null;
  const seg = parts[2];
  const map: Record<string, SalesArea> = {
    pipeline: "pipeline",
    opportunities: "pipeline",
    leads: "leads",
    companies: "companies",
    contacts: "contacts",
    "follow-ups": "followUps",
    targets: "targets",
    "daily-report": "dailyReport",
    "daily-reports": "dailyReports",
    performance: "performance",
    reports: "reports",
    settings: "settings",
  };
  return seg ? (map[seg] ?? null) : "dashboard";
}
