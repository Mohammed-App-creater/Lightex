"""Sales permission matrix (docs/sales/spec.md §12): every sales route and method, for every built-in and default
sales role, allowed and denied. The table is checked against the URL configuration, so a new sales endpoint without
a row fails here (the tracking matrix leaves `sales/` routes to this file).

"Allowed" = past authentication, the module guard and access control (any status except 401, 403 and 404).
"Denied" = 401 (anonymous), 404 (outsiders) or 403 (members lacking the permission). Record routes point at the
Salesperson `rep`'s records, so own / team / all scopes all reach them; scope misses are in test_data_scope.py.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pytest
from django.urls import URLPattern, URLResolver, get_resolver, reverse

from core.common.testing import shared_world

from .conftest import ACTORS, SalesWorld, add_deals, build_sales_world

SALES_ROLES = ("sales_admin", "ceo", "manager", "rep")
EVERY_SALES_USER = ("owner", "admin", *SALES_ROLES)
ADMINS = ("owner", "admin", "sales_admin")
WRITERS = ("owner", "admin", "sales_admin", "manager", "rep")  # create and edit companies and contacts
NOBODY_ELSE = ("member", "outsider", "anon")
ASSIGNERS = ("owner", "admin", "sales_admin", "manager")  # assign leads and deals; delete leads and quotations


@dataclass(frozen=True)
class Row:
    name: str
    method: str
    kwargs: Callable[[SalesWorld], dict[str, Any]] = field(default=lambda w: {"slug": w.ws.slug})
    allow: tuple[str, ...] = ()
    body: Callable[[SalesWorld], Any] | None = None
    query: str = ""

    @property
    def deny(self) -> tuple[str, ...]:
        return tuple(a for a in ACTORS if a not in self.allow)


def _stage(w):
    from modules.sales import selectors

    return {"stage_id": selectors.stages(w.ws).filter(category="open").last().pk}


def _open_ids(w):
    from modules.sales import selectors

    return {"stageIds": [str(s.pk) for s in selectors.stages(w.ws).filter(category="open").reverse()]}


def _extra(name):
    return lambda w: {f"{name}_id": w.extra[name].pk}


def LEAD(w):
    return {"lead_id": w.leads["rep"].pk}


def OPP(w):
    return {"opportunity_id": w.opportunities["rep"].pk}


def CLOSED(w):
    return {"opportunity_id": w.extra["won"].pk}


def QUOTE(w):
    return {"quotation_id": w.quotations["rep"].pk}


def SENT(w):
    return {"quotation_id": w.extra["sent"].pk}


def _second_stage(w):
    from modules.sales import selectors

    return {"stageId": str(selectors.stages(w.ws).filter(category="open")[1].pk), "version": 1}


def COMPANY(w):
    return {"company_id": w.companies["rep"].pk}


def CONTACT(w):
    return {"contact_id": w.contacts["rep"].pk}


TARGET_MANAGERS = ("owner", "admin", "sales_admin", "ceo", "manager")


def TARGET(w):
    return {"sales_target_id": w.extra["target"].pk}


def REP_USER(w):
    return {"slug": w.ws.slug, "user_id": w.users["rep"].pk}


def _rep_target(w):
    rep = str(w.users["rep"].pk)
    return {"subjectType": "user", "subjectId": rep, "periodType": "month", "periodStart": "2026-05-01", "amount": "5"}


def ACTIVITY(w):
    return {"activity_id": w.extra["activity"].pk}


def FOLLOWUP(w):
    return {"follow_up_id": w.extra["followup"].pk}


ROWS: list[Row] = [
    # ── reference data: read by anyone in Sales, written with sales.settings.manage ──
    Row("sales-settings", "GET", allow=EVERY_SALES_USER),
    Row("sales-settings", "PUT", allow=ADMINS, body=lambda w: {"staleDays": 21}),
    Row("sales-stages", "GET", allow=EVERY_SALES_USER),
    Row("sales-stages", "POST", allow=ADMINS, body=lambda w: {"name": "Demo", "defaultProbability": 50}),
    Row("sales-stages-reorder", "POST", allow=ADMINS, body=_open_ids),
    Row("sales-stage-detail", "PATCH", _stage, allow=ADMINS, body=lambda w: {"name": "Proposal"}),
    Row("sales-stage-detail", "DELETE", _stage, allow=ADMINS),
    Row("sales-products", "GET", allow=EVERY_SALES_USER),
    Row("sales-products", "POST", allow=ADMINS, body=lambda w: {"name": "Router"}),
    Row("sales-product-detail", "PATCH", _extra("product"), allow=ADMINS, body=lambda w: {"isActive": False}),
    Row("sales-product-detail", "DELETE", _extra("product"), allow=ADMINS),
    Row("sales-lost-reasons", "GET", allow=EVERY_SALES_USER),
    Row("sales-lost-reasons", "POST", allow=ADMINS, body=lambda w: {"name": "Timing"}),
    Row("sales-lost-reason-detail", "PATCH", _extra("lost_reason"), allow=ADMINS, body=lambda w: {"name": "Cost"}),
    Row("sales-lost-reason-detail", "DELETE", _extra("lost_reason"), allow=ADMINS),
    Row("sales-calendar", "GET", allow=EVERY_SALES_USER),
    Row("sales-calendar", "PUT", allow=ADMINS, body=lambda w: {"weekdayWeights": [1, 1, 1, 1, 1, 0.5, 0]}),
    Row("sales-holidays", "GET", allow=EVERY_SALES_USER),
    Row("sales-holidays", "POST", allow=ADMINS, body=lambda w: {"date": "2026-12-25", "name": "Christmas"}),
    Row("sales-holiday-detail", "PATCH", _extra("holiday"), allow=ADMINS, body=lambda w: {"name": "Genna"}),
    Row("sales-holiday-detail", "DELETE", _extra("holiday"), allow=ADMINS),
    # ── companies ──
    Row("sales-companies", "GET", allow=EVERY_SALES_USER),
    Row("sales-companies", "POST", allow=WRITERS, body=lambda w: {"name": "New Co"}),
    Row("sales-companies-check-duplicate", "GET", allow=EVERY_SALES_USER, query="?name=Rep+Trading"),
    Row("sales-company-detail", "GET", COMPANY, allow=EVERY_SALES_USER),
    Row("sales-company-detail", "PATCH", COMPANY, allow=WRITERS, body=lambda w: {"notes": "Called"}),
    Row("sales-company-detail", "DELETE", COMPANY, allow=ADMINS),
    Row("sales-company-summary", "GET", COMPANY, allow=EVERY_SALES_USER),
    # ── contacts ──
    Row("sales-contacts", "GET", allow=EVERY_SALES_USER),
    Row(
        "sales-contacts",
        "POST",
        allow=WRITERS,
        body=lambda w: {"companyId": str(w.companies["rep"].pk), "name": "Hana"},
    ),
    Row("sales-contact-detail", "GET", CONTACT, allow=EVERY_SALES_USER),
    Row("sales-contact-detail", "PATCH", CONTACT, allow=WRITERS, body=lambda w: {"jobTitle": "Buyer"}),
    Row("sales-contact-detail", "DELETE", CONTACT, allow=ADMINS),
    # ── leads (S2) ──
    Row("sales-leads", "GET", allow=EVERY_SALES_USER),
    Row("sales-leads", "POST", allow=WRITERS, body=lambda w: {"companyName": "Fresh Co"}),
    Row(
        "sales-leads-bulk-assign",
        "POST",
        allow=ASSIGNERS,
        body=lambda w: {"leadIds": [str(w.leads["rep"].pk)], "ownerId": str(w.users["rep2"].pk)},
    ),
    Row("sales-lead-detail", "GET", LEAD, allow=EVERY_SALES_USER),
    Row("sales-lead-detail", "PATCH", LEAD, allow=WRITERS, body=lambda w: {"notes": "Warm"}),
    Row("sales-lead-detail", "DELETE", LEAD, allow=ASSIGNERS),
    Row("sales-lead-qualify", "POST", LEAD, allow=WRITERS),
    Row("sales-lead-disqualify", "POST", LEAD, allow=WRITERS, body=lambda w: {"reason": "No budget"}),
    Row("sales-lead-convert", "POST", LEAD, allow=WRITERS, body=lambda w: {}),
    # ── opportunities and the pipeline (S2) ──
    Row("sales-pipeline", "GET", allow=EVERY_SALES_USER),
    Row("sales-opportunities", "GET", allow=EVERY_SALES_USER),
    Row(
        "sales-opportunities",
        "POST",
        allow=WRITERS,
        body=lambda w: {"title": "New deal", "companyId": str(w.companies["rep"].pk)},
    ),
    Row(
        "sales-opportunities-bulk-assign",
        "POST",
        allow=ASSIGNERS,
        body=lambda w: {"opportunityIds": [str(w.opportunities["rep"].pk)], "ownerId": str(w.users["rep2"].pk)},
    ),
    Row("sales-opportunity-detail", "GET", OPP, allow=EVERY_SALES_USER),
    Row("sales-opportunity-detail", "PATCH", OPP, allow=WRITERS, body=lambda w: {"nextAction": "Call back"}),
    Row("sales-opportunity-detail", "DELETE", OPP, allow=ADMINS),
    Row("sales-opportunity-move", "POST", OPP, allow=WRITERS, body=_second_stage),
    Row("sales-opportunity-won", "POST", OPP, allow=WRITERS, body=lambda w: {}),
    Row(
        "sales-opportunity-lost",
        "POST",
        OPP,
        allow=WRITERS,
        body=lambda w: {"lostReasonId": str(w.extra["lost_reason"].pk)},
    ),
    Row("sales-opportunity-reopen", "POST", CLOSED, allow=ADMINS, body=lambda w: {}),
    Row("sales-opportunity-timeline", "GET", OPP, allow=EVERY_SALES_USER),
    # ── quotations (S2) ──
    Row("sales-quotations", "GET", allow=EVERY_SALES_USER),
    Row(
        "sales-quotations",
        "POST",
        allow=WRITERS,
        body=lambda w: {"opportunityId": str(w.opportunities["rep"].pk), "title": "Offer", "amount": "100.00"},
    ),
    Row("sales-quotation-detail", "GET", QUOTE, allow=EVERY_SALES_USER),
    Row("sales-quotation-detail", "PATCH", QUOTE, allow=WRITERS, body=lambda w: {"notes": "v2"}),
    Row("sales-quotation-detail", "DELETE", QUOTE, allow=ASSIGNERS),
    Row("sales-quotation-send", "POST", QUOTE, allow=WRITERS, body=lambda w: {}),
    Row("sales-quotation-accept", "POST", SENT, allow=WRITERS),
    Row("sales-quotation-reject", "POST", SENT, allow=WRITERS),
    # ── activities, follow-ups and the company timeline (S3) ──
    Row("sales-company-timeline", "GET", COMPANY, allow=EVERY_SALES_USER),
    Row("sales-activities", "GET", allow=EVERY_SALES_USER),
    Row(
        "sales-activities",
        "POST",
        allow=WRITERS,
        body=lambda w: {"type": "call", "targetType": "sales.opportunity", "targetId": str(w.opportunities["rep"].pk)},
    ),
    Row("sales-activity-detail", "GET", ACTIVITY, allow=EVERY_SALES_USER),
    Row("sales-activity-detail", "PATCH", ACTIVITY, allow=WRITERS, body=lambda w: {"summary": "Edited"}),
    Row("sales-activity-detail", "DELETE", ACTIVITY, allow=WRITERS),
    Row("sales-follow-ups", "GET", allow=EVERY_SALES_USER, query="?bucket=today"),
    Row(
        "sales-follow-ups",
        "POST",
        allow=WRITERS,
        body=lambda w: {
            "targetType": "sales.company",
            "targetId": str(w.companies["rep"].pk),
            "title": "Call back",
            "dueDate": "2099-01-01",
        },
    ),
    Row("sales-follow-up-detail", "GET", FOLLOWUP, allow=EVERY_SALES_USER),
    Row("sales-follow-up-detail", "PATCH", FOLLOWUP, allow=WRITERS, body=lambda w: {"title": "Edited"}),
    Row("sales-follow-up-detail", "DELETE", FOLLOWUP, allow=WRITERS),
    Row("sales-follow-up-complete", "POST", FOLLOWUP, allow=WRITERS, body=lambda w: {}),
    Row("sales-follow-up-reschedule", "POST", FOLLOWUP, allow=WRITERS, body=lambda w: {"dueDate": "2099-02-01"}),
    Row(
        "sales-follow-up-reassign",
        "POST",
        FOLLOWUP,
        allow=ASSIGNERS,
        body=lambda w: {"ownerId": str(w.users["rep2"].pk)},
    ),
    # ── targets and performance (S4) ──
    Row("sales-targets", "GET", allow=EVERY_SALES_USER),
    Row("sales-targets", "POST", allow=TARGET_MANAGERS, body=_rep_target),
    Row("sales-target-detail", "GET", TARGET, allow=EVERY_SALES_USER),
    Row("sales-target-detail", "DELETE", TARGET, allow=TARGET_MANAGERS),
    Row("sales-targets-allocation", "GET", allow=EVERY_SALES_USER),
    Row(
        "sales-targets-allocate",
        "POST",
        allow=TARGET_MANAGERS,
        body=lambda w: {"subjectType": "user", "subjectId": str(w.users["rep"].pk), "year": 2026, "method": "equal"},
    ),
    Row("sales-targets-effective", "GET", allow=EVERY_SALES_USER),
    Row("sales-performance-user", "GET", REP_USER, allow=EVERY_SALES_USER),
    Row("sales-performance-ranking", "GET", allow=EVERY_SALES_USER),
]


def _sales_routes() -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()

    def walk(patterns, prefix=""):
        for p in patterns:
            if isinstance(p, URLResolver):
                walk(p.url_patterns, prefix + str(p.pattern))
            elif isinstance(p, URLPattern) and (prefix + str(p.pattern)).startswith("api/v1/sales/"):
                view = getattr(p.callback, "view_class", None) or getattr(p.callback, "cls", None)
                for m in ("get", "post", "put", "patch", "delete"):
                    if hasattr(view, m):
                        found.add((p.name, m.upper()))

    walk(get_resolver().url_patterns)
    return found


def test_every_sales_route_has_a_matrix_row():
    covered = {(r.name, r.method) for r in ROWS}
    assert _sales_routes() - covered == set(), "Add sales permission-matrix rows"
    assert covered - _sales_routes() == set(), "Rows for routes that don't exist"


def _cases():
    for r in ROWS:
        for actor in ACTORS:
            yield pytest.param(r, actor, actor in r.allow, id=f"{r.name}-{r.method}-{actor}")


def _world() -> SalesWorld:
    from django.utils import timezone

    from modules.sales.models import Holiday, LostReason, PipelineStage, Product, Quotation

    w = add_deals(build_sales_world())
    rep = w.users["rep"]
    won_stage = PipelineStage.objects.for_workspace(w.ws).get(category="won")
    w.extra["won"] = w.opportunities["rep"].__class__.objects.create(
        workspace=w.ws,
        owner=rep,
        company=w.companies["rep"],
        title="Closed deal",
        stage=won_stage,
        won_at=timezone.now(),
        won_value="10.00",
        credited_user=rep,
    )
    w.extra["sent"] = Quotation.objects.create(
        workspace=w.ws,
        owner=rep,
        opportunity=w.opportunities["rep"],
        number="Q-2000-0099",
        title="Sent quote",
        status="sent",
        sent_at=timezone.now(),
    )
    w.extra["product"] = Product.objects.create(workspace=w.ws, name="Switch")
    w.extra["lost_reason"] = LostReason.objects.create(workspace=w.ws, name="Price")
    w.extra["holiday"] = Holiday.objects.create(workspace=w.ws, date="2026-09-11", name="Enkutatash")
    from modules.sales.models import Activity, FollowUp

    opp = w.opportunities["rep"]
    on_opp = {"target_type": "sales.opportunity", "target_id": opp.pk, "opportunity": opp, "company": opp.company}
    w.extra["activity"] = Activity.objects.create(
        workspace=w.ws, owner=rep, type="call", occurred_at=timezone.now(), **on_opp
    )
    w.extra["followup"] = FollowUp.objects.create(
        workspace=w.ws, owner=rep, created_by=rep, title="Call back", due_date="2099-01-01", **on_opp
    )
    from modules.sales.models import Target

    w.extra["target"] = Target.objects.create(
        workspace=w.ws, subject_type="user", subject_id=rep.pk, period_type="year", period_start="2026-01-01", amount=1
    )
    return w


@pytest.fixture(scope="module")
def matrix_world(django_db_setup, django_db_blocker) -> SalesWorld:
    """Built once for the module; every case runs in a savepoint and is rolled back to it."""
    with shared_world(django_db_blocker) as build:
        yield build(_world)


@pytest.mark.django_db
@pytest.mark.parametrize(("row", "actor", "allowed"), list(_cases()))
def test_permission_matrix(matrix_world: SalesWorld, row: Row, actor: str, allowed: bool):
    w = matrix_world
    client = w.client(actor)
    url = reverse(row.name, kwargs=row.kwargs(w)) + row.query
    call = getattr(client, row.method.lower())
    res = call(url, row.body(w), format="json") if row.body else call(url)
    if allowed:
        assert res.status_code not in (401, 403, 404), f"{actor} should pass: {res.status_code} {res.content[:300]!r}"
        assert res.status_code < 500
    elif actor == "anon":
        assert res.status_code == 401
    elif actor == "outsider":
        assert res.status_code == 404, "non-members of a workspace must get 404"
    else:
        assert res.status_code == 403, f"{actor} should be refused: {res.status_code} {res.content[:300]!r}"
        assert res.json()["code"] == "forbidden"
        assert res.json()["details"]["permission"].startswith("sales.")
