"""Sales demo data (`manage.py seed_demo_sales`, development only; docs/sales/spec.md §13 "Seed data").

`seed(workspace, owner)` fills one workspace (sales on) with:

- people: one CEO / GM, two teams (North, South) each with a Sales Manager (team lead) and two Salespeople. Every
  sales person also holds Member (multi-role); accounts use the core demo password;
- reference data: products, lost reasons, the default calendar (Saturday weight 0) and a few public holidays;
- 20 companies (five per salesperson) with one or two contacts each, 40 leads (new, contacted, qualified,
  disqualified), 60 opportunities: 36 open across the open stages, 14 won and 10 lost in the last 90 days;
- quotations (draft, sent, accepted, rejected), activities on deals and leads, follow-ups (pending, some overdue,
  some due today, some done; a few open deals have none, so the "no next step" flag shows);
- company, team and salesperson year targets for the current fiscal year, allocated to quarters and months by
  working days (`targets.allocate`);
- daily reports for the last ten working days, submitted (a few late, a few missing) and mostly reviewed.

Records are written through the services (audit entries, stage history, events, numbering), then timestamps are
moved into the past with plain updates (the services stamp "now"). Deterministic: a seeded `random.Random`, dates
relative to the workspace's today. `reset(workspace)` removes the sales records (not the people or teams).
"""

from __future__ import annotations

import datetime as dt
import random
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone

from core.workspaces.timezone import workspace_today, workspace_zone

from . import activity_services, daily_reports, pipeline_services, services, targets
from .defaults import ensure_defaults
from .models import (
    Activity,
    Company,
    Contact,
    DailyReport,
    FollowUp,
    Holiday,
    Lead,
    LostReason,
    Opportunity,
    OpportunityStageHistory,
    PipelineStage,
    Product,
    Quotation,
    Target,
)
from .workdays import WorkCalendar

SEED = 20261017
EMAIL_DOMAIN = "sales.demo"
#: (key, name, sales role system key, team or None).
PEOPLE = (
    ("ceo", "Selam Tesfaye", "sales_ceo", None),
    ("north_manager", "Dawit Bekele", "sales_manager", "North"),
    ("south_manager", "Hana Girma", "sales_manager", "South"),
    ("abel", "Abel Kebede", "sales_salesperson", "North"),
    ("meron", "Meron Alemu", "sales_salesperson", "North"),
    ("yonas", "Yonas Haile", "sales_salesperson", "South"),
    ("liya", "Liya Tadesse", "sales_salesperson", "South"),
)
SALESPEOPLE = ("abel", "meron", "yonas", "liya")
MANAGER_OF = {"abel": "north_manager", "meron": "north_manager", "yonas": "south_manager", "liya": "south_manager"}
TEAMS = (("North", "Addis Ababa accounts"), ("South", "Regional accounts"))
PRODUCTS = (
    ("ERP suite", "ERP", "Software"),
    ("Payroll module", "PAY", "Software"),
    ("POS terminals", "POS", "Hardware"),
    ("Network setup", "NET", "Services"),
    ("Support contract", "SUP", "Services"),
)
LOST_REASONS = ("Price too high", "Chose a competitor", "No budget", "No decision")
#: (month, day, name): fixed-date public holidays of the current year (Gregorian dates).
HOLIDAYS = (
    (1, 7, "Genna (Ethiopian Christmas)"),
    (1, 19, "Timket (Epiphany)"),
    (3, 2, "Adwa Victory Day"),
    (5, 1, "International Labour Day"),
    (5, 28, "Derg Downfall Day"),
    (9, 11, "Enkutatash (New Year)"),
    (9, 27, "Meskel"),
)
COMPANY_WORDS = (
    "Abay", "Entoto", "Sheba", "Lalibela", "Axum", "Gondar", "Harar", "Bahir", "Awash", "Rift",
    "Simien", "Tana", "Wollo", "Jimma", "Adama", "Hawassa", "Dire", "Mekele", "Bale", "Omo",
)  # fmt: skip
COMPANY_KINDS = ("Trading PLC", "Manufacturing", "Logistics", "Hotels", "Pharma", "Construction", "Bank S.C.")
INDUSTRIES = ("Retail", "Manufacturing", "Logistics", "Hospitality", "Healthcare", "Construction", "Finance")
CITIES = ("Addis Ababa", "Adama", "Hawassa", "Bahir Dar", "Dire Dawa", "Mekelle")
FIRST = ("Alemayehu", "Birtukan", "Chaltu", "Dereje", "Eden", "Fikru", "Genet", "Henok", "Kidist", "Mulugeta")
LAST = ("Assefa", "Bekele", "Desta", "Getachew", "Kassa", "Mengistu", "Negash", "Tadesse", "Wolde", "Yohannes")
SOURCES = ("referral", "website", "call", "event", "visit", "social")
LOGGED = (Activity.CALL, Activity.VISIT, Activity.MEETING, Activity.EMAIL, Activity.NOTE)


def _at(ws: Any, day: dt.date, hour: int, minute: int = 0) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(hour, minute), tzinfo=workspace_zone(ws))


def is_seeded(ws: Any) -> bool:
    return Company.all_objects.for_workspace(ws).filter(email__endswith=f".{EMAIL_DOMAIN}").exists()


@transaction.atomic
def reset(ws: Any) -> None:
    """Deletes the workspace's sales records (not people, teams, settings, stages or the calendar)."""
    for model in (Activity, FollowUp, DailyReport, Target):
        model.objects.for_workspace(ws).delete()
    Quotation.all_objects.for_workspace(ws).delete()
    OpportunityStageHistory.objects.for_workspace(ws).delete()
    Opportunity.all_objects.for_workspace(ws).delete()
    Lead.all_objects.for_workspace(ws).delete()
    Contact.all_objects.for_workspace(ws).delete()
    Company.all_objects.for_workspace(ws).delete()
    for ref in (Holiday, Product, LostReason):
        ref.objects.for_workspace(ws).delete()


class _Seeder:
    def __init__(self, ws: Any, owner: Any, password: str | None) -> None:
        self.ws, self.owner, self.password = ws, owner, password
        self.rng = random.Random(SEED)  # noqa: S311 (demo data, not security)
        self.today = workspace_today(ws)
        self.now = timezone.now()
        self.users: dict[str, Any] = {}
        self.teams: dict[str, Any] = {}
        self.companies: dict[str, list[Company]] = {k: [] for k in SALESPEOPLE}
        self.counts: dict[str, int] = {}

    # ── helpers ──

    def days_ago(self, lo: int, hi: int) -> dt.date:
        return self.today - dt.timedelta(days=self.rng.randint(lo, hi))

    def money(self, lo: int, hi: int) -> Decimal:
        return Decimal(self.rng.randint(lo, hi) * 5000)

    def instant(self, day: dt.date) -> dt.datetime:
        moment = _at(self.ws, day, self.rng.randint(9, 16), self.rng.choice((0, 15, 30, 45)))
        return min(moment, self.now - dt.timedelta(minutes=5))

    # ── people ──

    def people(self) -> None:
        from core.accounts.models import User
        from core.teams.models import Team, TeamMember
        from core.workspaces.models import WorkspaceMember
        from core.workspaces.services import set_member_roles

        roles = {r.system_key: r for r in self.ws.roles.filter(is_system=True)}
        for name, description in TEAMS:
            self.teams[name], _ = Team.objects.get_or_create(
                workspace=self.ws, name=name, defaults={"description": description}
            )
        for key, name, role_key, team in PEOPLE:
            email = f"{key.replace('_', '.')}@{EMAIL_DOMAIN}"
            user = User.objects.filter(email=email).first()
            if user is None:
                user = User(email=email, name=name)
                user.set_password(self.password) if self.password else user.set_unusable_password()
                user.save()
            member, _ = WorkspaceMember.objects.get_or_create(
                workspace=self.ws, user=user, defaults={"status": "active"}
            )
            set_member_roles(member, [roles["member"], roles[role_key]])
            user.__dict__.pop("_lx_access_cache", None)
            if team:
                TeamMember.objects.get_or_create(
                    workspace=self.ws,
                    team=self.teams[team],
                    user=user,
                    defaults={"is_lead": role_key == "sales_manager"},
                )
            self.users[key] = user

    # ── reference data ──

    def reference(self) -> None:
        ensure_defaults(self.ws)
        self.stages = {s.name: s for s in PipelineStage.objects.for_workspace(self.ws)}
        self.open_stages = [
            s for s in sorted(self.stages.values(), key=lambda s: s.order) if s.category == PipelineStage.OPEN
        ]
        have = set(Product.objects.for_workspace(self.ws).values_list("name", flat=True))
        for name, code, category in PRODUCTS:
            if name not in have:
                services.create_product(self.owner, self.ws, {"name": name, "code": code, "category": category})
        self.products = list(Product.objects.for_workspace(self.ws).filter(is_active=True).order_by("name"))
        have = set(LostReason.objects.for_workspace(self.ws).values_list("name", flat=True))
        for name in LOST_REASONS:
            if name not in have:
                services.create_lost_reason(self.owner, self.ws, {"name": name})
        self.reasons = list(LostReason.objects.for_workspace(self.ws).filter(is_active=True).order_by("name"))
        taken = set(Holiday.objects.for_workspace(self.ws).values_list("date", flat=True))
        for month, day, name in HOLIDAYS:
            date = dt.date(self.today.year, month, day)
            if date not in taken:
                services.create_holiday(self.owner, self.ws, {"date": date, "name": name})

    # ── customers ──

    def customers(self) -> None:
        for i in range(20):
            rep = SALESPEOPLE[i % 4]
            actor = self.users[rep]
            name = f"{COMPANY_WORDS[i]} {COMPANY_KINDS[i % len(COMPANY_KINDS)]}"
            slug = COMPANY_WORDS[i].lower()
            company = services.create_company(
                actor,
                self.ws,
                {
                    "name": name,
                    "industry": INDUSTRIES[i % len(INDUSTRIES)],
                    "city": CITIES[i % len(CITIES)],
                    "region": "Addis Ababa" if i % len(CITIES) == 0 else "Regions",
                    "phone": f"+251 11 {550 + i:03d} {1000 + i * 7:04d}",
                    "email": f"info@{slug}.{EMAIL_DOMAIN}",
                    "website": f"https://{slug}.example.et",
                },
            )
            for j in range(1 + i % 2):
                person = f"{FIRST[(i + j) % 10]} {LAST[(i * 3 + j) % 10]}"
                services.create_contact(
                    actor,
                    self.ws,
                    {
                        "company_id": company.pk,
                        "name": person,
                        "job_title": ("General Manager", "Procurement Officer")[j],
                        "phone": f"+251 91 {100 + i:03d} {2000 + j:04d}",
                        "email": f"{person.split()[0].lower()}@{slug}.{EMAIL_DOMAIN}",
                        "is_primary": j == 0,
                    },
                )
            self.companies[rep].append(company)
        Company.objects.for_workspace(self.ws).filter(email__endswith=f".{EMAIL_DOMAIN}").update(
            created_at=timezone.now() - dt.timedelta(days=150)
        )

    def leads(self) -> None:
        statuses = [Lead.NEW] * 3 + [Lead.CONTACTED] * 2 + [Lead.QUALIFIED] * 2 + [Lead.DISQUALIFIED]
        for i in range(40):
            rep = SALESPEOPLE[i % 4]
            actor = self.users[rep]
            status = statuses[i % len(statuses)]
            person = f"{FIRST[i % 10]} {LAST[(i * 7) % 10]}"
            lead = pipeline_services.create_lead(
                actor,
                self.ws,
                {
                    "source": SOURCES[i % len(SOURCES)],
                    "company_name_text": f"{LAST[i % 10]} {('Imports', 'Foods', 'Textiles', 'Motors')[i % 4]} {i + 1}",
                    "contact_name": person,
                    "phone": f"+251 92 {300 + i:03d} {4000 + i:04d}",
                    "product_id": self.products[i % len(self.products)].pk,
                    "estimated_value": self.money(20, 300),
                    "status": Lead.CONTACTED if status == Lead.CONTACTED else Lead.NEW,
                },
            )
            if status == Lead.QUALIFIED:
                pipeline_services.qualify_lead(actor, lead)
            elif status == Lead.DISQUALIFIED:
                pipeline_services.disqualify_lead(actor, lead, "No budget this year")
            created = self.days_ago(1, 45)
            Lead.objects.filter(pk=lead.pk).update(created_at=self.instant(created))
            if status in (Lead.CONTACTED, Lead.QUALIFIED):
                self.activity(actor, Activity.LEAD, lead, created, self.today - dt.timedelta(days=1))

    # ── deals ──

    def activity(self, actor: Any, target_type: str, obj: Any, lo: dt.date, hi: dt.date) -> Activity:
        span = max((hi - lo).days, 0)
        day = lo + dt.timedelta(days=self.rng.randint(0, span))
        kind = self.rng.choice(LOGGED)
        a, _ = activity_services.log_activity(
            actor,
            self.ws,
            {
                "target_type": target_type,
                "target_id": obj.pk,
                "type": kind,
                "occurred_at": self.instant(day),
                "duration_minutes": None if kind in (Activity.NOTE, Activity.EMAIL) else self.rng.choice((15, 30, 60)),
                "summary": {
                    Activity.CALL: "Discussed requirements by phone",
                    Activity.VISIT: "Site visit with the operations team",
                    Activity.MEETING: "Meeting with the decision makers",
                    Activity.EMAIL: "Sent product brochure and pricing",
                    Activity.NOTE: "Internal note: budget approval pending",
                }[kind],
                "outcome": self.rng.choice(("Interested", "Needs a demo", "Waiting for budget", "Positive")),
            },
        )
        self.counts["activities"] = self.counts.get("activities", 0) + 1
        return a

    def quotation(self, actor: Any, opp: Opportunity, sent_day: dt.date | None, answer: str | None) -> None:
        q = pipeline_services.create_quotation(
            actor,
            self.ws,
            {"opportunity_id": opp.pk, "title": f"Proposal: {opp.title}", "amount": opp.expected_value},
        )
        if sent_day is None:
            return
        q = pipeline_services.send_quotation(actor, q, {})
        sent = self.instant(sent_day)
        Quotation.objects.filter(pk=q.pk).update(
            created_at=sent - dt.timedelta(days=1), sent_at=sent, valid_until=sent_day + dt.timedelta(days=30)
        )
        Activity.objects.filter(quotation=q).update(occurred_at=sent, created_at=sent)
        if answer:
            pipeline_services.answer_quotation(actor, q, answer)
            Quotation.objects.filter(pk=q.pk).update(responded_at=sent + dt.timedelta(days=2))

    def opportunities(self) -> None:
        # 60 deals: indexes 0-35 open (three open stages), 36-49 won, 50-59 lost; owners round-robin.
        for i in range(60):
            rep = SALESPEOPLE[i % 4]
            actor = self.users[rep]
            company = self.companies[rep][(i // 4) % 5]
            contact = Contact.objects.for_workspace(self.ws).filter(company=company, is_primary=True).first()
            product = self.products[i % len(self.products)]
            stage = self.open_stages[i % len(self.open_stages)]
            large = i in (5, 22, 40)
            value = self.money(400, 500) * 5 if large else self.money(10, 160)
            if i < 36:
                close = self.today + dt.timedelta(days=self.rng.randint(-10, 75))
            else:
                close = self.days_ago(0, 88)
            opp = pipeline_services.create_opportunity(
                actor,
                self.ws,
                {
                    "company_id": company.pk,
                    "contact_id": contact.pk if contact else None,
                    "product_id": product.pk,
                    "title": f"{product.name} for {company.name.split()[0]}",
                    "expected_value": value,
                    "stage_id": stage.pk,
                    "expected_close_date": close,
                    "next_action": "Send revised proposal" if i % 3 else "",
                },
            )
            created = (close if i >= 36 else self.today) - dt.timedelta(days=self.rng.randint(10, 40))
            created = min(created, self.today - dt.timedelta(days=1))
            created_at = self.instant(created)
            Opportunity.objects.filter(pk=opp.pk).update(created_at=created_at)
            OpportunityStageHistory.objects.filter(opportunity=opp).update(changed_at=created_at)
            last = close if i >= 36 else self.today - dt.timedelta(days=1)
            stale = i < 36 and i % 9 == 8  # no activity for weeks
            for _ in range(1 if stale else self.rng.randint(1, 3)):
                hi = created + dt.timedelta(days=3) if stale else last
                self.activity(actor, Activity.OPPORTUNITY, opp, created, max(hi, created))
            opp.refresh_from_db()
            if i < 36:
                quoting = stage.order > self.open_stages[0].order
                if quoting:
                    self.quotation(actor, opp, None if i % 5 == 0 else self.days_ago(1, 10), None)
                if i % 9 != 4:  # a few open deals have no next step
                    self.followup(actor, opp, i)
            elif i < 50:
                self.quotation(actor, opp, close - dt.timedelta(days=5), Quotation.ACCEPTED)
                pipeline_services.win_opportunity(actor, opp, {})
                won_at = self.instant(close)
                Opportunity.objects.filter(pk=opp.pk).update(won_at=won_at, updated_at=won_at)
                OpportunityStageHistory.objects.filter(opportunity=opp, kind=OpportunityStageHistory.WON).update(
                    changed_at=won_at
                )
            else:
                if i % 2:
                    self.quotation(actor, opp, close - dt.timedelta(days=4), Quotation.REJECTED)
                reason = self.reasons[i % len(self.reasons)]
                pipeline_services.lose_opportunity(
                    actor, opp, {"lost_reason_id": reason.pk, "lost_note": "Customer decided not to proceed"}
                )
                lost_at = self.instant(close)
                Opportunity.objects.filter(pk=opp.pk).update(lost_at=lost_at, updated_at=lost_at)
                OpportunityStageHistory.objects.filter(opportunity=opp, kind=OpportunityStageHistory.LOST).update(
                    changed_at=lost_at
                )
        # The last activity dates follow the back-dated activities.
        activity_services.refresh_last_activity(
            opportunities=list(Opportunity.objects.for_workspace(self.ws).values_list("pk", flat=True)),
            leads=list(Lead.objects.for_workspace(self.ws).values_list("pk", flat=True)),
            companies=list(Company.objects.for_workspace(self.ws).values_list("pk", flat=True)),
        )

    def followup(self, actor: Any, opp: Opportunity, i: int) -> None:
        f = activity_services.create_followup(
            actor,
            self.ws,
            {
                "target_type": Activity.OPPORTUNITY,
                "target_id": opp.pk,
                "title": "Call back about the proposal" if i % 2 else "Confirm the decision date",
                "due_date": self.today,
            },
        )
        bucket = i % 6
        if bucket in (0, 1):  # overdue
            due = self.today - dt.timedelta(days=1 + i % 7)
        elif bucket == 2:  # today
            due = self.today
        else:
            due = self.today + dt.timedelta(days=1 + i % 12)
        FollowUp.objects.filter(pk=f.pk).update(due_date=due, created_at=self.instant(self.days_ago(5, 15)))
        if bucket == 5:  # an earlier, completed step on the same deal
            done = activity_services.create_followup(
                actor,
                self.ws,
                {
                    "target_type": Activity.OPPORTUNITY,
                    "target_id": opp.pk,
                    "title": "Intro call",
                    "due_date": self.today,
                },
            )
            activity_services.complete_followup(actor, done, {})
            day = self.days_ago(3, 10)
            FollowUp.objects.filter(pk=done.pk).update(
                due_date=day, completed_at=self.instant(day), created_at=self.instant(day - dt.timedelta(days=3))
            )

    # ── targets ──

    def targets(self) -> None:
        settings = ensure_defaults(self.ws)
        year = targets.fiscal_year_of(self.today, settings)
        start = targets.fiscal_year(settings, year).start
        ceo = self.users["ceo"]
        team_totals = {name: Decimal(0) for name, _ in TEAMS}
        subjects: list[tuple[str, Any, Decimal]] = []
        for k, rep in enumerate(SALESPEOPLE):
            amount = Decimal(9_000_000 + 1_500_000 * k)
            subjects.append((Target.USER, self.users[rep].pk, amount))
            team_totals["North" if rep in ("abel", "meron") else "South"] += amount
        for name, total in team_totals.items():
            subjects.append((Target.TEAM, self.teams[name].pk, total))
        subjects.append((Target.COMPANY, None, sum(team_totals.values(), Decimal(0)) + Decimal(5_000_000)))
        for subject_type, subject_id, amount in subjects:
            data = {"subjectType": subject_type, "subjectId": subject_id}
            targets.set_target(
                ceo, self.ws, {**data, "periodType": Target.YEAR, "periodStart": start, "amount": amount}
            )
            targets.allocate(ceo, self.ws, {**data, "year": year, "method": "working_days"})

    # ── daily reports ──

    def reports(self) -> None:
        cal = WorkCalendar(self.ws)
        days: list[dt.date] = []
        day = self.today - dt.timedelta(days=1)
        while len(days) < 10:
            if daily_reports.is_working_day(self.ws, day, cal):
                days.append(day)
            day -= dt.timedelta(days=1)
        authors = (*SALESPEOPLE, "north_manager", "south_manager")
        for n, day in enumerate(reversed(days)):
            for k, key in enumerate(authors):
                if (n + k) % 11 == 3:  # missing
                    continue
                user = self.users[key]
                report = daily_reports.today_report(user, self.ws, now=_at(self.ws, day, 9))
                daily_reports.update_report(
                    user,
                    report,
                    {
                        "comments": ["Good progress on the pipeline today."],
                        "tomorrowPlan": [{"text": "Follow up on open proposals"}],
                    },
                )
                late = (n + k) % 7 == 5
                daily_reports.submit(user, report, now=_at(self.ws, day, 19 if late else 17, 30))
                if day < self.today - dt.timedelta(days=2) or n % 2:
                    reviewer = self.users[MANAGER_OF.get(key, "ceo")]
                    daily_reports.review(
                        reviewer, report, "Thanks, keep it up.", now=_at(self.ws, day + dt.timedelta(days=1), 9, 30)
                    )

    def run(self) -> dict[str, int]:
        self.people()
        self.reference()
        self.customers()
        self.leads()
        self.opportunities()
        self.targets()
        self.reports()
        return self.summary()

    def summary(self) -> dict[str, int]:
        ws = self.ws
        opps = Opportunity.objects.for_workspace(ws)
        return {
            "users": len(self.users),
            "companies": Company.objects.for_workspace(ws).count(),
            "contacts": Contact.objects.for_workspace(ws).count(),
            "leads": Lead.objects.for_workspace(ws).count(),
            "opportunities": opps.count(),
            "won": opps.filter(stage__category=PipelineStage.WON).count(),
            "lost": opps.filter(stage__category=PipelineStage.LOST).count(),
            "quotations": Quotation.objects.for_workspace(ws).count(),
            "activities": Activity.objects.for_workspace(ws).count(),
            "followUps": FollowUp.objects.for_workspace(ws).count(),
            "overdueFollowUps": FollowUp.objects.for_workspace(ws)
            .filter(status=FollowUp.PENDING, due_date__lt=self.today)
            .count(),
            "targets": Target.objects.for_workspace(ws).count(),
            "dailyReports": DailyReport.objects.for_workspace(ws).count(),
            "holidays": Holiday.objects.for_workspace(ws).count(),
        }


def seed(ws: Any, owner: Any, *, password: str | None = None) -> dict[str, int]:
    """Fills `ws` (sales enabled) with the demo data; `owner` writes the reference data. Returns the counts."""
    with transaction.atomic():
        return _Seeder(ws, owner, password).run()
