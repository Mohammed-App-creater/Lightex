import type { components } from "@/api/schema";
import type { MockDB } from "../db-types";
import { DEFAULT_TIMEZONE } from "../derive";

/*
 * Sales mock store (docs/sales/api.md). Records keep the wire fields minus the derived ones (owner briefs, can*,
 * flags, probability…), plus `workspaceId` and `deletedAt`. Everything lives in `db.sales` (optional on MockDB, so a
 * cached database without it is upgraded lazily by `salesStore`).
 */

type S = components["schemas"];
export type SalesSchemas = S;

export type SettingsRec = Omit<S["SalesSettings"], "updatedAt"> & { workspaceId: string; updatedAt: string | null };
export type CalendarRec = { workspaceId: string; weekdayWeights: number[]; updatedAt: string | null };
export type StageRec = S["SalesStage"] & { workspaceId: string };
export type ProductRec = Omit<S["SalesProduct"], never> & { workspaceId: string };
export type LostReasonRec = S["SalesLostReason"] & { workspaceId: string };
export type HolidayRec = S["SalesHoliday"] & { workspaceId: string };

type Owned = { workspaceId: string; ownerId: string | null; createdAt: string; updatedAt: string; deletedAt: string | null };

export type CompanyRec = Owned & {
  id: string;
  name: string;
  industry: string;
  region: string;
  city: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  status: S["SalesCompanyStatusEnum"];
  notes: string;
};
export type ContactRec = Owned & {
  id: string;
  companyId: string;
  name: string;
  jobTitle: string;
  phone: string;
  email: string;
  isPrimary: boolean;
  notes: string;
};
export type LeadRec = Owned & {
  id: string;
  source: S["SalesLeadSourceEnum"];
  status: S["SalesLeadStatusEnum"];
  companyId: string | null;
  companyName: string;
  contactId: string | null;
  contactName: string;
  phone: string;
  email: string;
  productId: string | null;
  estimatedValue: string | null;
  disqualifyReason: string;
  convertedOpportunityId: string | null;
  convertedAt: string | null;
  notes: string;
};
export type OpportunityRec = Owned & {
  id: string;
  title: string;
  companyId: string;
  contactId: string | null;
  productId: string | null;
  stageId: string;
  expectedValue: string;
  probabilityOverride: number | null;
  expectedCloseDate: string | null;
  nextAction: string;
  sourceLeadId: string | null;
  creditedUserId: string | null;
  wonAt: string | null;
  wonValue: string | null;
  lostAt: string | null;
  lostReasonId: string | null;
  lostNote: string;
  version: number;
  notes: string;
};
export type StageHistoryRec = {
  id: string;
  workspaceId: string;
  opportunityId: string;
  kind: "stage_created" | "stage_moved" | "stage_won" | "stage_lost" | "stage_reopened";
  fromStageId: string | null;
  fromStage: string | null;
  toStageId: string | null;
  toStage: string | null;
  actorId: string | null;
  at: string;
};
export type QuotationRec = Owned & {
  id: string;
  number: string;
  opportunityId: string;
  title: string;
  amount: string;
  status: S["SalesQuotationStatusEnum"];
  sentAt: string | null;
  validUntil: string | null;
  respondedAt: string | null;
  expiredAt: string | null;
  notes: string;
};
export type TargetType = S["SalesTargetTypeEnum"];
export type ActivityRec = Omit<Owned, "deletedAt"> & {
  id: string;
  type: S["SalesActivityTypeEnum"];
  occurredAt: string;
  durationMinutes: number | null;
  targetType: TargetType;
  targetId: string;
  companyId: string | null;
  quotationId: string | null;
  summary: string;
  outcome: string;
};
export type FollowUpRec = Omit<Owned, "deletedAt"> & {
  id: string;
  title: string;
  notes: string;
  dueDate: string;
  status: S["SalesFollowUpStatusEnum"];
  completedAt: string | null;
  completedActivityId: string | null;
  cancelledAt: string | null;
  targetType: TargetType;
  targetId: string;
  companyId: string | null;
  createdById: string | null;
};
export type TargetRec = {
  id: string;
  workspaceId: string;
  subjectType: S["SubjectTypeEnum"];
  subjectId: string | null;
  periodType: S["PeriodTypeEnum"];
  periodStart: string;
  periodEnd: string;
  amount: string;
  note: string;
  updatedAt: string;
};
export type DailyReportRec = {
  id: string;
  workspaceId: string;
  userId: string;
  reportDate: string;
  status: S["SalesDailyReportStatusEnum"];
  comments: string[];
  tomorrowPlan: S["SalesDailyPlanItem"][];
  submittedAt: string | null;
  isLate: boolean;
  reviewedById: string | null;
  reviewedAt: string | null;
  reviewComment: string;
  snapshot: S["SalesDailyMetrics"] | null;
  updatedAt: string;
};

export interface SalesStore {
  settings: SettingsRec[];
  calendars: CalendarRec[];
  stages: StageRec[];
  products: ProductRec[];
  lostReasons: LostReasonRec[];
  holidays: HolidayRec[];
  companies: CompanyRec[];
  contacts: ContactRec[];
  leads: LeadRec[];
  opportunities: OpportunityRec[];
  stageHistory: StageHistoryRec[];
  quotations: QuotationRec[];
  /** `${workspaceId}:${year}` → last quotation number. */
  quotationSeq: Record<string, number>;
  activities: ActivityRec[];
  followUps: FollowUpRec[];
  targets: TargetRec[];
  dailyReports: DailyReportRec[];
}

export function emptySalesStore(): SalesStore {
  return {
    settings: [],
    calendars: [],
    stages: [],
    products: [],
    lostReasons: [],
    holidays: [],
    companies: [],
    contacts: [],
    leads: [],
    opportunities: [],
    stageHistory: [],
    quotations: [],
    quotationSeq: {},
    activities: [],
    followUps: [],
    targets: [],
    dailyReports: [],
  };
}

export function salesStore(db: MockDB): SalesStore {
  db.sales ??= emptySalesStore();
  return db.sales;
}

/* ───────── ids, money, dates ───────── */

let seq = 0;
/** A uuid-looking id (the backend's ids are uuids; tests and the client treat them as opaque). */
export function sid() {
  seq += 1;
  const hex = (n: number, len: number) => n.toString(16).padStart(len, "0").slice(-len);
  const r = () => Math.floor(Math.random() * 0x10000);
  return `${hex(Date.now(), 8)}-${hex(seq, 4)}-4${hex(r(), 3)}-a${hex(r(), 3)}-${hex(r(), 4)}${hex(r(), 4)}${hex(r(), 4)}`;
}

export const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
export const num = (m: string | null | undefined) => (m ? Number(m) : 0);
export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
export const nowISO = () => new Date().toISOString();

const pad = (n: number) => String(n).padStart(2, "0");
export const fmtDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};
export const addDays = (s: string, n: number) => {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
};
export const addMonths = (s: string, n: number) => {
  const d = parseDate(s);
  return fmtDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate())));
};
/** Monday = 0 … Sunday = 6. */
export const weekdayIndex = (s: string) => (parseDate(s).getUTCDay() + 6) % 7;
export const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(parseDate(v).getTime()) && fmtDate(parseDate(v)) === v;
export const monthStart = (s: string) => `${s.slice(0, 7)}-01`;
export const monthEnd = (s: string) => addDays(addMonths(monthStart(s), 1), -1);

export function tzOf(db: MockDB, workspaceId: string) {
  return db.workspaces.find((w) => w.id === workspaceId)?.timezone || DEFAULT_TIMEZONE;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const partFormats = new Map<string, Intl.DateTimeFormat>();

/** The workspace date (YYYY-MM-DD) of a timestamp (default now). */
export function wsDate(db: MockDB, workspaceId: string, at: string | Date = new Date()) {
  const d = typeof at === "string" ? new Date(at) : at;
  const tz = tzOf(db, workspaceId);
  try {
    let f = dateFormats.get(tz);
    if (!f) dateFormats.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
    return f.format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
export const wsToday = (db: MockDB, workspaceId: string) => wsDate(db, workspaceId);

/** Minutes east of UTC for the workspace zone at a moment (Addis: +180). */
function offsetMinutes(db: MockDB, workspaceId: string, at: Date) {
  const tz = tzOf(db, workspaceId);
  try {
    let f = partFormats.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      partFormats.set(tz, f);
    }
    const parts = f.formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    return Math.round((local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
  } catch {
    return 0;
  }
}

/** A workspace-local wall time → ISO UTC timestamp. */
export function wsInstant(db: MockDB, workspaceId: string, date: string, hh = 12, mm = 0) {
  const guess = new Date(`${date}T${pad(hh)}:${pad(mm)}:00Z`);
  return new Date(guess.getTime() - offsetMinutes(db, workspaceId, guess) * 60_000).toISOString();
}
