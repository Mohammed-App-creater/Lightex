"""Reference data and settings (docs/sales/api.md §5): defaults seeding, settings, stage invariants, products, lost
reasons, the working calendar and holidays, with their audit rows."""

import pytest

from core.audit.models import AuditLog
from modules.sales import defaults, selectors, services
from modules.sales.models import Holiday, LostReason, PipelineStage, Product, SalesCalendar, SalesSettings

pytestmark = pytest.mark.django_db

BASE = "/api/v1/sales/workspaces/platform"


def actions(prefix="sales."):
    return list(
        AuditLog.objects.filter(action__startswith=prefix).order_by("created_at").values_list("action", flat=True)
    )


# ───────────────────────── defaults ─────────────────────────


def test_defaults_are_seeded_once(world):
    ws = world.ws
    assert not SalesSettings.objects.for_workspace(ws).exists()
    s1 = defaults.ensure_defaults(ws)
    s2 = defaults.ensure_defaults(ws)
    assert s1.pk == s2.pk
    rows = list(
        PipelineStage.objects.for_workspace(ws)
        .order_by("order")
        .values_list("name", "category", "default_probability", "is_system", "order")
    )
    assert rows == [
        ("Opportunity", "open", 20, False, 0),
        ("Quotation", "open", 40, False, 1),
        ("Negotiation", "open", 70, False, 2),
        ("Won", "won", 100, True, 3),
        ("Lost", "lost", 0, True, 4),
    ]
    assert SalesCalendar.objects.for_workspace(ws).count() == 1
    assert selectors.first_open_stage(ws).name == "Opportunity"
    # Another workspace gets its own.
    assert PipelineStage.objects.for_workspace(world.other_ws).count() == 0
    selectors.stages(world.other_ws)
    assert PipelineStage.objects.for_workspace(world.other_ws).count() == 5


def test_settings_read_and_update(world):
    admin = world.client("sales_admin")
    body = admin.get(f"{BASE}/settings").json()
    assert body == {
        "weekStart": "monday",
        "fiscalYearStartMonth": 1,
        "statusGreenPct": 100,
        "statusYellowPct": 70,
        "upcomingDays": 7,
        "staleDays": 14,
        "largeDealThreshold": "1000000.00",
        "dailyReportCutoff": "18:00",
        "dailyReportRequired": True,
        "quotationValidityDays": 30,
        "calendarDisplay": "gregorian",
        "updatedAt": body["updatedAt"],
    }
    res = admin.put(
        f"{BASE}/settings",
        {
            "weekStart": "sunday",
            "largeDealThreshold": "250000.50",
            "dailyReportCutoff": "17:30",
            "fiscalYearStartMonth": 7,
        },
        format="json",
    )
    assert res.status_code == 200, res.json()
    assert (res.json()["weekStart"], res.json()["largeDealThreshold"], res.json()["dailyReportCutoff"]) == (
        "sunday",
        "250000.50",
        "17:30",
    )
    assert res.json()["staleDays"] == 14  # untouched
    row = AuditLog.objects.get(action="sales.settings.updated")
    assert {c["field"] for c in row.changes} == {
        "Week start",
        "Large deal threshold",
        "Daily report cutoff",
        "Fiscal year start",
    }
    # A no-op writes no audit row.
    admin.put(f"{BASE}/settings", {"weekStart": "sunday"}, format="json")
    assert AuditLog.objects.filter(action="sales.settings.updated").count() == 1


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({"fiscalYearStartMonth": 13}, "fiscalYearStartMonth"),
        ({"weekStart": "funday"}, "weekStart"),
        ({"statusYellowPct": 120}, "statusYellowPct"),
        ({"largeDealThreshold": "-1"}, "largeDealThreshold"),
        ({"largeDealThreshold": "1.234"}, "largeDealThreshold"),
        ({"dailyReportCutoff": "6pm"}, "dailyReportCutoff"),
        ({"calendarDisplay": "julian"}, "calendarDisplay"),
    ],
)
def test_settings_validation(world, payload, field):
    res = world.client("owner").put(f"{BASE}/settings", payload, format="json")
    assert res.status_code == 422
    assert field in res.json()["details"]["fields"]


# ───────────────────────── stages ─────────────────────────


def stage_names(client):
    return [(s["name"], s["category"], s["order"]) for s in client.get(f"{BASE}/stages").json()]


def test_stage_crud_keeps_open_stages_before_won_and_lost(world):
    admin = world.client("sales_admin")
    res = admin.post(f"{BASE}/stages", {"name": "Proposal", "defaultProbability": 55}, format="json")
    assert res.status_code == 201, res.json()
    assert (res.json()["category"], res.json()["isSystem"], res.json()["order"]) == ("open", False, 3)
    assert stage_names(admin) == [
        ("Opportunity", "open", 0),
        ("Quotation", "open", 1),
        ("Negotiation", "open", 2),
        ("Proposal", "open", 3),
        ("Won", "won", 4),
        ("Lost", "lost", 5),
    ]
    stage_id = res.json()["id"]
    res = admin.patch(
        f"/api/v1/sales/stages/{stage_id}", {"name": "Proposal sent", "defaultProbability": 60}, format="json"
    )
    assert (res.json()["name"], res.json()["defaultProbability"]) == ("Proposal sent", 60)
    assert admin.delete(f"/api/v1/sales/stages/{stage_id}").status_code == 204
    assert [n for n, _, _ in stage_names(admin)] == ["Opportunity", "Quotation", "Negotiation", "Won", "Lost"]
    assert [o for _, _, o in stage_names(admin)] == [0, 1, 2, 3, 4]
    assert actions() == ["sales.stage.created", "sales.stage.updated", "sales.stage.deleted"]


def test_stage_invariants(world):
    admin = world.client("owner")
    stages = {s["name"]: s for s in admin.get(f"{BASE}/stages").json()}
    for name in ("Won", "Lost"):
        res = admin.delete(f"/api/v1/sales/stages/{stages[name]['id']}")
        assert (res.status_code, res.json()["code"]) == (409, "stage_is_system")
        res = admin.patch(f"/api/v1/sales/stages/{stages[name]['id']}", {"defaultProbability": 50}, format="json")
        assert res.status_code == 422
        assert "defaultProbability" in res.json()["details"]["fields"]
    # System stages may be renamed.
    res = admin.patch(f"/api/v1/sales/stages/{stages['Won']['id']}", {"name": "Closed won"}, format="json")
    assert res.status_code == 200
    # Names are unique, case-insensitively.
    res = admin.post(f"{BASE}/stages", {"name": "quotation", "defaultProbability": 10}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "name_taken")
    res = admin.patch(f"/api/v1/sales/stages/{stages['Opportunity']['id']}", {"name": "LOST"}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "name_taken")
    # Open stages may be removed until one is left.
    assert admin.delete(f"/api/v1/sales/stages/{stages['Quotation']['id']}").status_code == 204
    assert admin.delete(f"/api/v1/sales/stages/{stages['Negotiation']['id']}").status_code == 204
    res = admin.delete(f"/api/v1/sales/stages/{stages['Opportunity']['id']}")
    assert (res.status_code, res.json()["code"]) == (409, "last_open_stage")
    assert PipelineStage.objects.for_workspace(world.ws).filter(category="won").count() == 1
    assert PipelineStage.objects.for_workspace(world.ws).filter(category="lost").count() == 1
    # Probabilities stay within 0–100; only open stages can be created.
    res = admin.post(f"{BASE}/stages", {"name": "Bad", "defaultProbability": 101}, format="json")
    assert res.status_code == 422
    res = admin.post(
        f"{BASE}/stages", {"name": "Won again", "defaultProbability": 100, "category": "won"}, format="json"
    )
    assert res.json()["category"] == "open"


def test_stage_in_use_hook_refuses_delete(world, monkeypatch):
    monkeypatch.setattr(services, "stage_in_use", lambda stage: True)
    stage = selectors.stages(world.ws).first()
    res = world.client("owner").delete(f"/api/v1/sales/stages/{stage.pk}")
    assert (res.status_code, res.json()["code"]) == (409, "stage_in_use")


def test_open_stage_limit(world, monkeypatch):
    monkeypatch.setattr(services, "MAX_OPEN_STAGES", 3)
    res = world.client("owner").post(f"{BASE}/stages", {"name": "Fourth", "defaultProbability": 10}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "too_many_stages")


def test_reorder_stages(world):
    admin = world.client("sales_admin")
    stages = admin.get(f"{BASE}/stages").json()
    opened = [s["id"] for s in stages if s["category"] == "open"]
    res = admin.post(f"{BASE}/stages/reorder", {"stageIds": list(reversed(opened))}, format="json")
    assert res.status_code == 200, res.json()
    assert [s["name"] for s in res.json()] == ["Negotiation", "Quotation", "Opportunity", "Won", "Lost"]
    assert [s["order"] for s in res.json()] == [0, 1, 2, 3, 4]
    row = AuditLog.objects.get(action="sales.stage.reordered")
    assert row.changes[0]["after"] == "Negotiation, Quotation, Opportunity"
    # Same order again: no audit row.
    admin.post(f"{BASE}/stages/reorder", {"stageIds": list(reversed(opened))}, format="json")
    assert AuditLog.objects.filter(action="sales.stage.reordered").count() == 1
    won = next(s["id"] for s in stages if s["category"] == "won")
    for bad in (opened[:2], [*opened, won], [opened[0], opened[0], opened[1]], [], "nope"):
        res = admin.post(f"{BASE}/stages/reorder", {"stageIds": bad}, format="json")
        assert res.status_code == 422, bad
        assert "stageIds" in res.json()["details"]["fields"]


# ───────────────────────── products and lost reasons ─────────────────────────


def test_products(world):
    admin = world.client("sales_admin")
    res = admin.post(f"{BASE}/products", {"name": "Router X", "code": "RX-1", "category": "Network"}, format="json")
    assert res.status_code == 201, res.json()
    body = res.json()
    assert (body["name"], body["code"], body["category"], body["isActive"]) == ("Router X", "RX-1", "Network", True)
    assert admin.post(f"{BASE}/products", {"name": "router x"}, format="json").json()["code"] == "name_taken"
    assert (
        admin.post(f"{BASE}/products", {"name": "Other", "code": "rx-1"}, format="json").json()["code"] == "code_taken"
    )
    assert admin.post(f"{BASE}/products", {"name": "Plain"}, format="json").status_code == 201
    assert admin.post(f"{BASE}/products", {"name": "Plain 2", "code": ""}, format="json").status_code == 201
    pid = body["id"]
    res = admin.patch(f"/api/v1/sales/products/{pid}", {"isActive": False}, format="json")
    assert res.json()["isActive"] is False
    rep = world.client("rep")
    assert [p["name"] for p in rep.get(f"{BASE}/products").json()] == ["Plain", "Plain 2", "Router X"]
    assert [p["name"] for p in rep.get(f"{BASE}/products?filter[active]=true").json()] == ["Plain", "Plain 2"]
    assert [p["name"] for p in rep.get(f"{BASE}/products?filter[active]=false").json()] == ["Router X"]
    assert rep.get(f"{BASE}/products?filter[active]=maybe").status_code == 422
    assert admin.delete(f"/api/v1/sales/products/{pid}").status_code == 204
    assert not Product.objects.for_workspace(world.ws).filter(pk=pid).exists()
    assert admin.patch(f"/api/v1/sales/products/{pid}", {}, format="json").status_code == 404
    assert actions("sales.product.") == [
        "sales.product.created",
        "sales.product.created",
        "sales.product.created",
        "sales.product.updated",
        "sales.product.deleted",
    ]


def test_product_and_lost_reason_in_use_hooks(world, monkeypatch):
    p = Product.objects.create(workspace=world.ws, name="Used")
    r = LostReason.objects.create(workspace=world.ws, name="Used")
    monkeypatch.setattr(services, "product_in_use", lambda x: True)
    monkeypatch.setattr(services, "lost_reason_in_use", lambda x: True)
    owner = world.client("owner")
    assert owner.delete(f"/api/v1/sales/products/{p.pk}").json()["code"] == "product_in_use"
    assert owner.delete(f"/api/v1/sales/lost-reasons/{r.pk}").json()["code"] == "lost_reason_in_use"


def test_lost_reasons(world):
    admin = world.client("sales_admin")
    res = admin.post(f"{BASE}/lost-reasons", {"name": "Price too high"}, format="json")
    assert res.status_code == 201
    assert admin.post(f"{BASE}/lost-reasons", {"name": "PRICE TOO HIGH"}, format="json").status_code == 409
    rid = res.json()["id"]
    assert admin.patch(
        f"/api/v1/sales/lost-reasons/{rid}", {"name": "Price", "isActive": False}, format="json"
    ).json() == {
        **res.json(),
        "name": "Price",
        "isActive": False,
        "updatedAt": admin.get(f"{BASE}/lost-reasons").json()[0]["updatedAt"],
    }
    assert world.client("ceo").get(f"{BASE}/lost-reasons?filter[active]=true").json() == []
    assert admin.delete(f"/api/v1/sales/lost-reasons/{rid}").status_code == 204
    assert actions("sales.lostreason.") == [
        "sales.lostreason.created",
        "sales.lostreason.updated",
        "sales.lostreason.deleted",
    ]


# ───────────────────────── calendar and holidays ─────────────────────────


def test_calendar(world):
    admin = world.client("sales_admin")
    assert admin.get(f"{BASE}/calendar").json()["weekdayWeights"] == [1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0]
    res = admin.put(f"{BASE}/calendar", {"weekdayWeights": [1, 1, 1, 1, 1, 0.5, 0]}, format="json")
    assert res.status_code == 200, res.json()
    assert res.json()["weekdayWeights"] == [1.0, 1.0, 1.0, 1.0, 1.0, 0.5, 0.0]
    row = AuditLog.objects.get(action="sales.calendar.updated")
    assert row.changes == [{"field": "Saturday", "kind": "value", "before": "0.00", "after": "0.50"}]
    for bad in ([1, 1, 1], [1, 1, 1, 1, 1, 1, 2], [0, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, -1], "x"):
        res = admin.put(f"{BASE}/calendar", {"weekdayWeights": bad}, format="json")
        assert res.status_code == 422, bad
    assert world.client("rep").get(f"{BASE}/calendar").json()["weekdayWeights"][5] == 0.5


def test_holidays(world):
    admin = world.client("sales_admin")
    res = admin.post(f"{BASE}/holidays", {"date": "2026-09-11", "name": "Enkutatash"}, format="json")
    assert res.status_code == 201, res.json()
    admin.post(f"{BASE}/holidays", {"date": "2027-01-07", "name": "Genna"}, format="json")
    dup = admin.post(f"{BASE}/holidays", {"date": "2026-09-11", "name": "Again"}, format="json")
    assert (dup.status_code, dup.json()["code"], dup.json()["details"]) == (409, "date_taken", {"date": "2026-09-11"})
    rep = world.client("rep")
    assert [h["name"] for h in rep.get(f"{BASE}/holidays").json()] == ["Enkutatash", "Genna"]
    assert [h["name"] for h in rep.get(f"{BASE}/holidays?filter[year]=2027").json()] == ["Genna"]
    assert rep.get(f"{BASE}/holidays?filter[year]=abc").status_code == 422
    hid = res.json()["id"]
    res = admin.patch(f"/api/v1/sales/holidays/{hid}", {"date": "2026-09-12"}, format="json")
    assert res.json()["date"] == "2026-09-12"
    res = admin.patch(f"/api/v1/sales/holidays/{hid}", {"date": "2027-01-07"}, format="json")
    assert res.json()["code"] == "date_taken"
    assert admin.delete(f"/api/v1/sales/holidays/{hid}").status_code == 204
    assert Holiday.objects.for_workspace(world.ws).count() == 1
    assert actions("sales.holiday.") == [
        "sales.holiday.created",
        "sales.holiday.created",
        "sales.holiday.updated",
        "sales.holiday.deleted",
    ]


def test_reference_records_of_another_workspace_are_404(world):
    theirs = Product.objects.create(workspace=world.other_ws, name="Theirs")
    res = world.client("owner").patch(f"/api/v1/sales/products/{theirs.pk}", {"name": "Mine"}, format="json")
    assert res.status_code == 404
    assert world.client("owner").delete("/api/v1/sales/stages/00000000-0000-0000-0000-000000000000").status_code == 404
