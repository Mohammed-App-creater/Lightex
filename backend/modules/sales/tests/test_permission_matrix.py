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

from .conftest import ACTORS, SalesWorld, build_sales_world

SALES_ROLES = ("sales_admin", "ceo", "manager", "rep")
EVERY_SALES_USER = ("owner", "admin", *SALES_ROLES)
ADMINS = ("owner", "admin", "sales_admin")
WRITERS = ("owner", "admin", "sales_admin", "manager", "rep")  # create and edit companies and contacts
NOBODY_ELSE = ("member", "outsider", "anon")


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


def COMPANY(w):
    return {"company_id": w.companies["rep"].pk}


def CONTACT(w):
    return {"contact_id": w.contacts["rep"].pk}


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
    from modules.sales.models import Holiday, LostReason, Product

    w = build_sales_world()
    w.extra["product"] = Product.objects.create(workspace=w.ws, name="Switch")
    w.extra["lost_reason"] = LostReason.objects.create(workspace=w.ws, name="Price")
    w.extra["holiday"] = Holiday.objects.create(workspace=w.ws, date="2026-09-11", name="Enkutatash")
    return w


@pytest.mark.django_db
@pytest.mark.parametrize(("row", "actor", "allowed"), list(_cases()))
def test_permission_matrix(row: Row, actor: str, allowed: bool):
    w = _world()
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
