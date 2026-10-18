import type { MockDB } from "../db-types";
import { sortRoleIds } from "../derive";
import { writeModule } from "../modules";
import { dailyMetrics, weightBetween } from "./kpi";
import {
  addDays,
  addMonths,
  money,
  salesStore,
  wsInstant,
  wsToday,
  type ActivityRec,
  type CompanyRec,
  type ContactRec,
  type FollowUpRec,
  type LeadRec,
  type OpportunityRec,
  type QuotationRec,
  type StageHistoryRec,
  type TargetRec,
} from "./store";
import { calendarOf, openStages, settingsOf, stagesOf } from "./views";

/*
 * Sales demo data, mirroring the backend's `modules/sales/seed.py`, in the Platform team workspace (sales on):
 * a Sales Admin, a CEO / GM, two teams (North, South) each with a Sales Manager (lead) and two Salespeople (every
 * sales person also holds Member), reference data, 20 companies, 40 leads, 60 opportunities (36 open, 14 won and
 * 10 lost in the last 90 days), quotations, activities, follow-ups, year → quarter → month targets and daily
 * reports for the last ten working days. Deterministic (seeded PRNG, dates relative to the workspace's today).
 */

const WS = "ws_platform";
const SEED = 20261017;

/** id, name, email, hue, sales role key, team. */
export const SALES_PEOPLE = [
  ["u_kal", "Kalkidan Ayele", "kal@sales.dev", 30, "sales_admin", null],
  ["u_selam", "Selam Tesfaye", "selam@sales.dev", 315, "sales_ceo", null],
  ["u_dawit", "Dawit Bekele", "dawit@sales.dev", 210, "sales_manager", "North"],
  ["u_hana", "Hana Girma", "hana@sales.dev", 170, "sales_manager", "South"],
  ["u_abel", "Abel Kebede", "abel@sales.dev", 45, "sales_salesperson", "North"],
  ["u_meron", "Meron Alemu", "meron@sales.dev", 345, "sales_salesperson", "North"],
  ["u_yonas", "Yonas Haile", "yonas@sales.dev", 120, "sales_salesperson", "South"],
  ["u_liya", "Liya Tadesse", "liya@sales.dev", 265, "sales_salesperson", "South"],
] as const;
const SELLERS = ["u_abel", "u_meron", "u_yonas", "u_liya"];
const MANAGER_OF: Record<string, string> = { u_abel: "u_dawit", u_meron: "u_dawit", u_yonas: "u_hana", u_liya: "u_hana" };

const PRODUCTS = [
  ["ERP suite", "ERP", "Software"],
  ["Payroll module", "PAY", "Software"],
  ["POS terminals", "POS", "Hardware"],
  ["Network setup", "NET", "Services"],
  ["Support contract", "SUP", "Services"],
] as const;
const LOST_REASONS = ["Price too high", "Chose a competitor", "No budget", "No decision"];
const HOLIDAYS: [number, number, string][] = [
  [1, 7, "Genna (Ethiopian Christmas)"],
  [1, 19, "Timket (Epiphany)"],
  [3, 2, "Adwa Victory Day"],
  [5, 1, "International Labour Day"],
  [5, 28, "Derg Downfall Day"],
  [9, 11, "Enkutatash (New Year)"],
  [9, 27, "Meskel"],
];
const COMPANY_WORDS = ["Abay", "Entoto", "Sheba", "Lalibela", "Axum", "Gondar", "Harar", "Bahir", "Awash", "Rift", "Simien", "Tana", "Wollo", "Jimma", "Adama", "Hawassa", "Dire", "Mekele", "Bale", "Omo"];
const COMPANY_KINDS = ["Trading PLC", "Manufacturing", "Logistics", "Hotels", "Pharma", "Construction", "Bank S.C."];
const INDUSTRIES = ["Retail", "Manufacturing", "Logistics", "Hospitality", "Healthcare", "Construction", "Finance"];
const CITIES = ["Addis Ababa", "Adama", "Hawassa", "Bahir Dar", "Dire Dawa", "Mekelle"];
const FIRST = ["Alemayehu", "Birtukan", "Chaltu", "Dereje", "Eden", "Fikru", "Genet", "Henok", "Kidist", "Mulugeta"];
const LAST = ["Assefa", "Bekele", "Desta", "Getachew", "Kassa", "Mengistu", "Negash", "Tadesse", "Wolde", "Yohannes"];
const SOURCES = ["referral", "website", "call", "event", "visit", "social"] as const;
const LOGGED = ["call", "visit", "meeting", "email", "note"] as const;

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedSales(db: MockDB, password: string) {
  const rand = prng(SEED);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]) => xs[int(0, xs.length - 1)]!;
  let n = 0;
  const id = (p: string) => `s${p}_${(++n).toString(36).padStart(4, "0")}`;
  const st = salesStore(db);
  const today = wsToday(db, WS);
  const nowMs = Date.now();
  /** A moment on `day` between 09:00 and 16:45 workspace time, never later than five minutes ago. */
  const at = (day: string, hour?: number) => {
    const iso = wsInstant(db, WS, day, hour ?? int(9, 16), pick([0, 15, 30, 45]));
    return Date.parse(iso) > nowMs - 5 * 60_000 ? new Date(nowMs - int(10, 120) * 60_000).toISOString() : iso;
  };
  const daysAgo = (lo: number, hi: number) => addDays(today, -int(lo, hi));
  const value = (lo: number, hi: number) => money(int(lo, hi) * 5000);

  /* people, roles, teams */
  writeModule(db, WS, "sales", true, "u_alex");
  const created = wsInstant(db, WS, addDays(today, -200), 9);
  for (const [uid, name, email, hue, roleKey] of SALES_PEOPLE) {
    db.users.push({ id: uid, name, email, hue, avatarUrl: null, createdAt: created, password });
    db.wsMembers.push({
      workspaceId: WS,
      userId: uid,
      roleIds: sortRoleIds(db, [`${WS}-role-member`, `${WS}-role-${roleKey}`]),
      status: "active",
      joinedAt: created,
      lastActiveAt: null,
    });
  }
  for (const [team, description] of [
    ["North", "Addis Ababa accounts"],
    ["South", "Regional accounts"],
  ] as const) {
    const teamId = `team_${team.toLowerCase()}`;
    db.teams.push({ id: teamId, workspaceId: WS, name: team, description, createdAt: created, deletedAt: null });
    for (const [uid, , , , roleKey, t] of SALES_PEOPLE) {
      if (t === team) db.teamMembers.push({ workspaceId: WS, teamId, userId: uid, isLead: roleKey === "sales_manager", addedAt: created });
    }
  }

  /* reference data */
  settingsOf(db, WS);
  calendarOf(db, WS);
  const stages = stagesOf(db, WS);
  const open = openStages(db, WS);
  const won = stages.find((s) => s.category === "won")!;
  const lost = stages.find((s) => s.category === "lost")!;
  const refAt = wsInstant(db, WS, addDays(today, -180), 9);
  const products = PRODUCTS.map(([name, code, category]) => {
    const p = { id: id("prod"), workspaceId: WS, name, code, category, isActive: true, createdAt: refAt, updatedAt: refAt };
    st.products.push(p);
    return p;
  });
  const reasons = LOST_REASONS.map((name) => {
    const r = { id: id("lr"), workspaceId: WS, name, isActive: true, createdAt: refAt, updatedAt: refAt };
    st.lostReasons.push(r);
    return r;
  });
  const year = Number(today.slice(0, 4));
  for (const [m, d, name] of HOLIDAYS) {
    st.holidays.push({ id: id("hol"), workspaceId: WS, date: `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, name });
  }

  /* companies and contacts: five per salesperson */
  const companies: Record<string, CompanyRec[]> = {};
  let w = 0;
  for (const owner of SELLERS) {
    companies[owner] = [];
    for (let i = 0; i < 5; i++) {
      const word = COMPANY_WORDS[w++]!;
      const name = `${word} ${pick(COMPANY_KINDS)}`;
      const createdAt = at(daysAgo(100, 170));
      const slug = word.toLowerCase();
      const c: CompanyRec = {
        id: id("co"),
        workspaceId: WS,
        name,
        industry: pick(INDUSTRIES),
        region: pick(["Addis Ababa", "Oromia", "Amhara", "Sidama"]),
        city: pick(CITIES),
        address: `Bole sub-city, woreda ${int(1, 14)}`,
        phone: `+251 9${int(10, 99)} ${int(10, 99)} ${int(10, 99)} ${int(10, 99)}`,
        email: `info@${slug}.example`,
        website: `https://${slug}.example`,
        status: "prospect",
        notes: "",
        ownerId: owner,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      };
      st.companies.push(c);
      companies[owner]!.push(c);
      for (let k = 0; k < int(1, 2); k++) {
        const first = pick(FIRST);
        const contact: ContactRec = {
          id: id("ct"),
          workspaceId: WS,
          companyId: c.id,
          name: `${first} ${pick(LAST)}`,
          jobTitle: pick(["CEO", "Procurement lead", "IT manager", "Finance director", "Operations manager"]),
          phone: `+251 9${int(10, 99)} ${int(100, 999)} ${int(100, 999)}`,
          email: `${first.toLowerCase()}@${slug}.example`,
          isPrimary: k === 0,
          notes: "",
          ownerId: owner,
          createdAt,
          updatedAt: createdAt,
          deletedAt: null,
        };
        st.contacts.push(contact);
      }
    }
  }
  const contactOf = (companyId: string) => st.contacts.find((c) => c.companyId === companyId && c.isPrimary)?.id ?? null;

  /* opportunities: per seller 9 open (three per stage), won and lost in the last 90 days */
  const history = (o: OpportunityRec, kind: StageHistoryRec["kind"], fromId: string | null, toId: string, when: string, actor: string) =>
    st.stageHistory.push({
      id: id("sh"),
      workspaceId: WS,
      opportunityId: o.id,
      kind,
      fromStageId: fromId,
      fromStage: fromId ? (stages.find((s) => s.id === fromId)?.name ?? null) : null,
      toStageId: toId,
      toStage: stages.find((s) => s.id === toId)?.name ?? null,
      actorId: actor,
      at: when,
    });
  const WON = [4, 4, 3, 3];
  const LOST = [2, 3, 2, 3];
  const dayOfMonth = Number(today.slice(8, 10));
  const opps: OpportunityRec[] = [];
  SELLERS.forEach((owner, si) => {
    const plan: ("open" | "won" | "lost")[] = [...Array(9).fill("open"), ...Array(WON[si]).fill("won"), ...Array(LOST[si]).fill("lost")];
    plan.forEach((kind, i) => {
      const company = companies[owner]![i % 5]!;
      const product = pick(products);
      const createdDay = daysAgo(kind === "open" ? 3 : 40, kind === "open" ? 60 : 110);
      const createdAt = at(createdDay);
      const stage = kind === "open" ? open[i % open.length]! : kind === "won" ? won : lost;
      const o: OpportunityRec = {
        id: id("op"),
        workspaceId: WS,
        title: `${company.name} – ${product.name}`,
        companyId: company.id,
        contactId: contactOf(company.id),
        productId: product.id,
        stageId: open[0]!.id,
        expectedValue: value(20, 260),
        probabilityOverride: null,
        expectedCloseDate: kind === "open" ? addDays(today, int(-10, 75)) : null,
        nextAction: kind === "open" ? pick(["Send revised proposal", "Book a demo", "Call the CFO", "Site visit", ""]) : "",
        sourceLeadId: null,
        creditedUserId: null,
        wonAt: null,
        wonValue: null,
        lostAt: null,
        lostReasonId: null,
        lostNote: "",
        version: 1,
        notes: "",
        ownerId: owner,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      };
      // The first two large deals of each seller close this week (attention list).
      if (kind === "open" && i < 2) {
        o.expectedValue = value(200, 320);
        o.expectedCloseDate = addDays(today, int(0, 3));
      }
      history(o, "stage_created", null, o.stageId, createdAt, owner);
      if (stage.id !== open[0]!.id) {
        const movedAt = at(addDays(createdDay, 2) < today ? addDays(createdDay, 2) : today);
        if (kind === "open") {
          history(o, "stage_moved", o.stageId, stage.id, movedAt, owner);
          o.stageId = stage.id;
          o.version += 1;
          o.updatedAt = movedAt;
        } else {
          // Won this month for the first two wins, otherwise in the last 90 days.
          const closeDay = kind === "won" && i - 9 < 2 ? addDays(today, -int(0, Math.max(dayOfMonth - 1, 0))) : daysAgo(1, 89);
          const closeAt = at(closeDay < createdDay ? createdDay : closeDay);
          history(o, kind === "won" ? "stage_won" : "stage_lost", o.stageId, stage.id, closeAt, owner);
          o.stageId = stage.id;
          o.version += 1;
          o.updatedAt = closeAt;
          if (kind === "won") {
            Object.assign(o, { wonAt: closeAt, wonValue: o.expectedValue, creditedUserId: owner });
            company.status = "active";
          } else {
            Object.assign(o, { lostAt: closeAt, lostReasonId: pick(reasons).id, lostNote: pick(["", "Went with the incumbent", "Budget moved to next year"]) });
          }
        }
      }
      st.opportunities.push(o);
      opps.push(o);
    });
  });

  /* leads: ten per seller (new, contacted, qualified, disqualified, two converted) */
  const LEAD_PLAN: LeadRec["status"][] = ["new", "new", "new", "contacted", "contacted", "qualified", "qualified", "disqualified", "converted", "converted"];
  SELLERS.forEach((owner) => {
    const mine = opps.filter((o) => o.ownerId === owner);
    LEAD_PLAN.forEach((status, i) => {
      const createdDay = daysAgo(0, 45);
      const createdAt = at(createdDay);
      const first = pick(FIRST);
      const l: LeadRec = {
        id: id("ld"),
        workspaceId: WS,
        source: pick(SOURCES),
        status,
        companyId: null,
        companyName: `${pick(COMPANY_WORDS)} ${pick(["Traders", "Foods", "Textiles", "Clinic", "Motors", "Coffee"])}`,
        contactId: null,
        contactName: `${first} ${pick(LAST)}`,
        phone: `+251 9${int(10, 99)} ${int(100, 999)} ${int(100, 999)}`,
        email: `${first.toLowerCase()}@lead.example`,
        productId: pick(products).id,
        estimatedValue: i % 4 === 3 ? null : value(10, 150),
        disqualifyReason: status === "disqualified" ? "No budget this year" : "",
        convertedOpportunityId: null,
        convertedAt: null,
        notes: "",
        ownerId: owner,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      };
      if (status === "converted") {
        const o = mine[i - 8]!;
        Object.assign(l, { companyId: o.companyId, contactId: o.contactId, companyName: "", convertedOpportunityId: o.id, convertedAt: o.createdAt, createdAt: wsInstant(db, WS, addDays(o.createdAt.slice(0, 10), -3), 10) });
        o.sourceLeadId = l.id;
      }
      st.leads.push(l);
    });
  });

  /* quotations */
  const seqKey = `${WS}:${year}`;
  const quote = (o: OpportunityRec, status: QuotationRec["status"]) => {
    st.quotationSeq[seqKey] = (st.quotationSeq[seqKey] ?? 0) + 1;
    const createdAt = at(addDays(o.createdAt.slice(0, 10), 1) < today ? addDays(o.createdAt.slice(0, 10), 1) : today);
    const sentAt = status === "draft" ? null : at(addDays(createdAt.slice(0, 10), 1) < today ? addDays(createdAt.slice(0, 10), 1) : today);
    const q: QuotationRec = {
      id: id("qt"),
      workspaceId: WS,
      number: `Q-${year}-${String(st.quotationSeq[seqKey]).padStart(4, "0")}`,
      opportunityId: o.id,
      title: `Proposal: ${o.title}`,
      amount: o.expectedValue,
      status,
      sentAt,
      validUntil: sentAt ? addDays(sentAt.slice(0, 10), 30) : null,
      respondedAt: status === "accepted" || status === "rejected" ? (o.wonAt ?? o.lostAt ?? sentAt) : null,
      expiredAt: null,
      notes: "",
      ownerId: o.ownerId,
      createdAt,
      updatedAt: sentAt ?? createdAt,
      deletedAt: null,
    };
    st.quotations.push(q);
    if (sentAt) {
      st.activities.push({ id: id("ac"), workspaceId: WS, type: "quotation", occurredAt: sentAt, durationMinutes: null, targetType: "sales.opportunity", targetId: o.id, companyId: o.companyId, quotationId: q.id, summary: `${q.number} sent`, outcome: "", ownerId: o.ownerId, createdAt: sentAt, updatedAt: sentAt });
    }
  };
  for (const o of opps) {
    const stage = stages.find((s) => s.id === o.stageId)!;
    if (stage.name === "Quotation") quote(o, rand() < 0.3 ? "draft" : "sent");
    else if (stage.name === "Negotiation") quote(o, "sent");
    else if (stage.category === "won") quote(o, "accepted");
    else if (stage.category === "lost" && rand() < 0.5) quote(o, "rejected");
  }

  /* activities on deals and leads */
  const act = (owner: string, targetType: ActivityRec["targetType"], targetId: string, companyId: string | null, day: string) => {
    const occurredAt = at(day);
    const type = pick(LOGGED);
    st.activities.push({
      id: id("ac"),
      workspaceId: WS,
      type,
      occurredAt,
      durationMinutes: type === "note" || type === "email" ? null : pick([15, 30, 45, 60]),
      targetType,
      targetId,
      companyId,
      quotationId: null,
      summary: pick(["Discussed scope and timeline", "Walked through pricing", "Demo with the operations team", "Checked on the decision", "Sent the brochure", "Met procurement"]),
      outcome: pick(["Positive", "Needs follow-up", "Waiting on budget", ""]),
      ownerId: owner,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
  };
  for (const o of opps) {
    const isOpen = !o.wonAt && !o.lostAt;
    const count = isOpen ? int(1, 4) : int(1, 2);
    const from = o.createdAt.slice(0, 10);
    for (let k = 0; k < count; k++) {
      // A few open deals go quiet (stale); the rest have recent activity.
      const day = isOpen && opps.indexOf(o) % 7 === 6 ? addDays(from, 0) : daysAgo(0, 12);
      act(o.ownerId!, "sales.opportunity", o.id, o.companyId, day < from ? from : day);
    }
  }
  for (const l of st.leads.filter((x) => x.workspaceId === WS && x.status !== "new")) act(l.ownerId!, "sales.lead", l.id, l.companyId, daysAgo(0, 10));
  // Today's work for each seller, so the daily report has numbers.
  for (const owner of SELLERS) {
    const mine = opps.filter((o) => o.ownerId === owner && !o.wonAt && !o.lostAt);
    for (let k = 0; k < 3; k++) {
      const o = mine[k]!;
      act(owner, "sales.opportunity", o.id, o.companyId, today);
    }
  }

  /* follow-ups: most open deals have one (overdue, today, upcoming); some done in the past */
  for (const o of opps) {
    if (o.wonAt || o.lostAt) continue;
    const idx = opps.indexOf(o);
    if (idx % 9 === 8) continue; // no next step
    const due = addDays(today, [-4, -1, 0, 0, 2, 5, 9, 14][idx % 8]!);
    const createdAt = at(addDays(today, -int(5, 15)));
    const f: FollowUpRec = {
      id: id("fu"),
      workspaceId: WS,
      title: pick(["Call back about the proposal", "Send the revised quote", "Confirm the demo date", "Check on the PO", "Visit the site"]),
      notes: "",
      dueDate: due,
      status: "pending",
      completedAt: null,
      completedActivityId: null,
      cancelledAt: null,
      targetType: "sales.opportunity",
      targetId: o.id,
      companyId: o.companyId,
      createdById: o.ownerId,
      ownerId: o.ownerId,
      createdAt,
      updatedAt: createdAt,
    };
    st.followUps.push(f);
    if (idx % 3 === 0) {
      const doneDay = daysAgo(1, 14);
      const doneAt = at(doneDay);
      st.followUps.push({ ...f, id: id("fu"), title: "Intro call", dueDate: idx % 2 ? doneDay : addDays(doneDay, -1), status: "done", completedAt: doneAt, createdAt: at(addDays(doneDay, -5)), updatedAt: doneAt });
    }
  }
  for (const l of st.leads.filter((x) => x.workspaceId === WS && (x.status === "new" || x.status === "contacted")).slice(0, 12)) {
    const createdAt = at(daysAgo(1, 6));
    st.followUps.push({ id: id("fu"), workspaceId: WS, title: "Qualify the lead", notes: "", dueDate: addDays(today, int(-2, 6)), status: "pending", completedAt: null, completedActivityId: null, cancelledAt: null, targetType: "sales.lead", targetId: l.id, companyId: null, createdById: l.ownerId, ownerId: l.ownerId, createdAt, updatedAt: createdAt });
  }

  /* targets: company, teams and sellers for the current fiscal year, allocated by working days */
  const fyStart = `${year}-${String(settingsOf(db, WS).fiscalYearStartMonth).padStart(2, "0")}-01`;
  const end = (type: TargetRec["periodType"], s: string) => addDays(addMonths(s, type === "year" ? 12 : type === "quarter" ? 3 : 1), -1);
  const target = (subjectType: TargetRec["subjectType"], subjectId: string | null, periodType: TargetRec["periodType"], periodStart: string, amount: number) =>
    st.targets.push({ id: id("tg"), workspaceId: WS, subjectType, subjectId, periodType, periodStart, periodEnd: end(periodType, periodStart), amount: money(amount), note: "", updatedAt: refAt });
  const months = Array.from({ length: 12 }, (_, i) => addMonths(fyStart, i));
  const mw = months.map((m) => weightBetween(db, WS, m, end("month", m)));
  const total = mw.reduce((a, b) => a + b, 0);
  const allocate = (subjectType: TargetRec["subjectType"], subjectId: string | null, amount: number) => {
    target(subjectType, subjectId, "year", fyStart, amount);
    for (let qi = 0; qi < 4; qi++) {
      const qw = mw.slice(qi * 3, qi * 3 + 3).reduce((a, b) => a + b, 0);
      target(subjectType, subjectId, "quarter", months[qi * 3]!, Math.round((amount * qw * 100) / total) / 100);
      for (let mi = qi * 3; mi < qi * 3 + 3; mi++) target(subjectType, subjectId, "month", months[mi]!, Math.round((amount * mw[mi]! * 100) / total) / 100);
    }
  };
  allocate("company", null, 34_000_000);
  allocate("team", "team_north", 15_000_000);
  allocate("team", "team_south", 14_000_000);
  for (const [u, amount] of [
    ["u_abel", 7_200_000],
    ["u_meron", 7_200_000],
    ["u_yonas", 6_600_000],
    ["u_liya", 6_600_000],
  ] as const) {
    allocate("user", u, amount);
  }

  /* daily reports: the last ten working days before today (a few late, a few missing, mostly reviewed) */
  const cutoff = settingsOf(db, WS).dailyReportCutoff;
  const workdays: string[] = [];
  for (let d = addDays(today, -1); workdays.length < 10; d = addDays(d, -1)) if (weightBetween(db, WS, d, d) > 0) workdays.unshift(d);
  workdays.forEach((day, di) => {
    SELLERS.forEach((u, ui) => {
      if ((di + ui) % 9 === 4) return; // missing
      const late = (di * 3 + ui) % 7 === 2;
      const [h, m] = cutoff.split(":").map(Number) as [number, number];
      const submittedAt = wsInstant(db, WS, day, late ? h + 1 : h - 1, late ? m + 20 : m);
      const reviewed = di < 8;
      st.dailyReports.push({
        id: id("dr"),
        workspaceId: WS,
        userId: u,
        reportDate: day,
        status: reviewed ? "reviewed" : "submitted",
        comments: [pick(["Good meetings today.", "Two customers asked for revised pricing.", "Slow day, followed up on quotes.", "Visited two prospects in Bole."])],
        tomorrowPlan: [{ text: pick(["Call back the hot leads", "Prepare the ERP demo", "Visit Adama clients", "Chase the open quotations"]), targetType: null, targetId: null }],
        submittedAt,
        isLate: late,
        reviewedById: reviewed ? MANAGER_OF[u]! : null,
        reviewedAt: reviewed ? wsInstant(db, WS, addDays(day, 1), 9) : null,
        reviewComment: reviewed ? pick(["Thanks, keep it up.", "Push the negotiation deals.", ""]) : "",
        snapshot: dailyMetrics(db, WS, u, day),
        updatedAt: submittedAt,
      });
    });
  });
}

/**
 * Tests: puts the seed back as it was before the sales demo (sales off in Platform team, no sales people, teams,
 * roles or records), for suites that start from "sales was never turned on".
 */
export function removeSalesDemo(db: MockDB) {
  const ids = new Set<string>(SALES_PEOPLE.map((p) => p[0]));
  db.users = db.users.filter((u) => !ids.has(u.id));
  db.wsMembers = db.wsMembers.filter((m) => !ids.has(m.userId));
  db.prefs = db.prefs.filter((p) => !ids.has(p.userId));
  db.teams = db.teams.filter((t) => t.id !== "team_north" && t.id !== "team_south");
  db.teamMembers = db.teamMembers.filter((m) => m.teamId !== "team_north" && m.teamId !== "team_south");
  db.roles = db.roles.filter((r) => !(r.workspaceId === WS && r.key?.startsWith("sales_")));
  db.workspaceModules = db.workspaceModules.filter((r) => !(r.workspaceId === WS && r.moduleKey === "sales"));
  delete db.sales;
}
