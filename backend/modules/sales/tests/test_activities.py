"""S3 activities and follow-ups (docs/sales/api.md §14–§16): data scope on the follow-up list, buckets around
midnight in workspace time, the complete flow, flags, timelines, notifications and the morning digest job."""

import datetime as dt

import pytest
from freezegun import freeze_time

from core.jobs.services import run_job
from core.modules.services import set_module_enabled
from core.notifications.models import Notification, NotificationPreference
from modules.sales.models import Activity, FollowUp, Opportunity

from .conftest import OWNED

pytestmark = pytest.mark.django_db

BASE = "/api/v1/sales/workspaces/platform"


def followup(world, actor, due, title=None, target="opportunity"):
    """A pending follow-up owned by `actor` on their opportunity (or company), straight in the database."""
    opp = world.opportunities[actor]
    if target == "opportunity":
        on = {"target_type": "sales.opportunity", "target_id": opp.pk, "opportunity": opp}
    else:
        on = {"target_type": "sales.company", "target_id": opp.company_id, "target_company": opp.company}
    user = world.users[actor]
    return FollowUp.objects.create(
        workspace=world.ws, owner=user, created_by=user, title=title or f"{actor} {due}", due_date=due,
        company=opp.company, **on,
    )  # fmt: skip


def titles(res):
    assert res.status_code == 200, res.json()
    return {r["title"] for r in res.json()["data"]}


@pytest.mark.parametrize(
    ("actor", "expected"),
    [
        ("rep", {"rep"}),
        ("manager", {"manager", "rep", "rep2"}),
        ("multi", {"rep2", "rep3"}),
        ("ceo", set(OWNED)),
    ],
)
def test_follow_up_list_follows_the_data_scope(deals, actor, expected):
    for owner in OWNED:
        followup(deals, owner, dt.date(2099, 1, 1), title=owner)
    assert titles(deals.client(actor).get(f"{BASE}/follow-ups")) == expected


@freeze_time("2026-10-14 20:30:00")  # 23:30 in Addis Ababa: still the 14th
def test_buckets_and_counts_in_workspace_time(deals):
    for day, title in ((13, "overdue"), (14, "today"), (15, "upcoming"), (21, "edge"), (22, "later")):
        followup(deals, "rep", dt.date(2026, 10, day), title=title)
    done = followup(deals, "rep", dt.date(2026, 10, 10), title="done")
    FollowUp.objects.filter(pk=done.pk).update(status="done")
    rep = deals.client("rep")
    res = rep.get(f"{BASE}/follow-ups?bucket=overdue")
    assert titles(res) == {"overdue"}
    assert res.json()["counts"] == {"overdue": 1, "today": 1, "upcoming": 2}  # upcoming = the next 7 days
    assert titles(rep.get(f"{BASE}/follow-ups?bucket=today")) == {"today"}
    assert titles(rep.get(f"{BASE}/follow-ups?bucket=upcoming")) == {"upcoming", "edge"}
    rows = {r["title"]: r["bucket"] for r in rep.get(f"{BASE}/follow-ups").json()["data"]}
    assert rows == {"overdue": "overdue", "today": "today", "upcoming": "upcoming", "edge": "upcoming",
                    "later": "later", "done": None}  # fmt: skip
    with freeze_time("2026-10-14 21:30:00"):  # 00:30 on the 15th in Addis Ababa
        res = deals.client("rep").get(f"{BASE}/follow-ups?bucket=today")  # a fresh token for the new time
        assert titles(res) == {"upcoming"}
        assert res.json()["counts"] == {"overdue": 2, "today": 1, "upcoming": 2}
    assert rep.get(f"{BASE}/follow-ups?bucket=soon").status_code == 422


@freeze_time("2026-10-14 08:00:00")
def test_log_activity_with_follow_up_and_flags(deals):
    rep = deals.client("rep")
    opp = deals.opportunities["rep"]
    card = rep.get(f"/api/v1/sales/opportunities/{opp.pk}").json()
    assert card["flags"] == {"overdueClose": False, "noNextStep": True, "stale": False}
    body = {
        "type": "visit",
        "targetType": "sales.opportunity",
        "targetId": str(opp.pk),
        "summary": "Met the buyer",
        "followUp": {"title": "Send the offer", "dueDate": "2026-10-16"},
    }
    res = rep.post(f"{BASE}/activities", body, format="json")
    assert res.status_code == 201, res.json()
    out = res.json()
    assert out["activity"]["company"]["name"] == "Rep Trading PLC"
    assert out["followUp"]["bucket"] == "upcoming" and out["followUp"]["targetId"] == str(opp.pk)
    card = rep.get(f"/api/v1/sales/opportunities/{opp.pk}").json()
    assert card["flags"]["noNextStep"] is False
    assert card["lastActivityAt"] == card["lastContactAt"] == "2026-10-14T08:00:00Z"
    board = rep.get(f"{BASE}/pipeline").json()
    assert board["stages"][0]["opportunities"][0]["flags"]["noNextStep"] is False
    # Stale: no activity for staleDays (14).
    with freeze_time("2026-10-29 08:00:00"):
        assert deals.client("rep").get(f"/api/v1/sales/opportunities/{opp.pk}").json()["flags"]["stale"] is True
    assert (
        rep.post(f"{BASE}/activities", {**body, "followUp": None, "type": "quotation"}, format="json").status_code
        == 422
    )
    future = {**body, "followUp": None, "occurredAt": "2026-10-15T08:00:00Z"}
    assert rep.post(f"{BASE}/activities", future, format="json").status_code == 422
    other = {**body, "followUp": None, "targetId": str(deals.opportunities["rep3"].pk)}
    assert rep.post(f"{BASE}/activities", other, format="json").status_code == 422  # not visible to rep


@freeze_time("2026-10-14 08:00:00")
def test_complete_flow_with_activity_and_next(deals):
    f = followup(deals, "rep", dt.date(2026, 10, 14), title="Call")
    rep = deals.client("rep")
    body = {"activity": {"type": "call", "summary": "Agreed a demo"}, "createNext": {"dueDate": "2026-10-20"}}
    res = rep.post(f"/api/v1/sales/follow-ups/{f.pk}/complete", body, format="json")
    assert res.status_code == 200, res.json()
    out = res.json()
    assert out["followUp"]["status"] == "done" and out["followUp"]["completedActivityId"] == out["activity"]["id"]
    assert out["next"]["dueDate"] == "2026-10-20" and out["next"]["title"] == "Call"
    assert out["next"]["ownerId"] == str(deals.users["rep"].pk)
    opp = Opportunity.objects.get(pk=deals.opportunities["rep"].pk)
    assert opp.last_activity_at is not None
    from core.events.models import DomainEvent

    assert DomainEvent.objects.filter(type="sales.followup.completed").count() == 1
    again = rep.post(f"/api/v1/sales/follow-ups/{f.pk}/complete", {}, format="json")
    assert (again.status_code, again.json()["code"]) == (409, "invalid_transition")
    assert (
        rep.post(f"/api/v1/sales/follow-ups/{f.pk}/reschedule", {"dueDate": "2026-10-30"}, format="json").status_code
        == 409
    )
    # Timelines: the opportunity's and the company's show the activity and the follow-ups.
    kinds = [i["kind"] for i in rep.get(f"/api/v1/sales/opportunities/{opp.pk}/timeline").json()["data"]]
    assert {"activity_logged", "followup_completed", "followup_scheduled"} <= set(kinds)
    summary = rep.get(f"/api/v1/sales/companies/{opp.company_id}/summary").json()
    assert summary["openFollowUpCount"] == 1 and summary["lastContactAt"] == "2026-10-14T08:00:00Z"
    assert {i["kind"] for i in summary["timeline"]} >= {"activity_logged", "followup_completed"}
    page = rep.get(f"/api/v1/sales/companies/{opp.company_id}/timeline?limit=1").json()
    assert len(page["data"]) == 1 and page["nextCursor"]


@freeze_time("2026-10-14 08:00:00")
def test_reassign_and_quotation_activity(deals):
    f = followup(deals, "rep", dt.date(2026, 10, 15))
    res = deals.client("manager").post(
        f"/api/v1/sales/follow-ups/{f.pk}/reassign", {"ownerId": str(deals.users["rep3"].pk)}, format="json"
    )
    assert res.status_code == 422  # rep3 is not in the manager's team
    res = deals.client("manager").post(
        f"/api/v1/sales/follow-ups/{f.pk}/reassign", {"ownerId": str(deals.users["rep2"].pk)}, format="json"
    )
    assert res.json()["ownerId"] == str(deals.users["rep2"].pk)
    q = deals.quotations["rep"]
    assert deals.client("rep").post(f"/api/v1/sales/quotations/{q.pk}/send", {}, format="json").status_code == 200
    a = Activity.objects.get(quotation=q)
    assert (a.type, a.opportunity_id) == ("quotation", q.opportunity_id)


def test_notifications_assigned_won_and_preferences(deals):
    opp = deals.opportunities["rep"]
    manager = deals.client("manager")
    manager.patch(f"/api/v1/sales/opportunities/{opp.pk}", {"ownerId": str(deals.users["rep2"].pk)}, format="json")
    n = Notification.objects.get(recipient=deals.users["rep2"], type="sales.opportunity.reassigned")
    assert n.target_id == opp.pk
    # Won: the North lead (manager) and reviewers reaching rep2 (CEO, Sales Admin, owner, admin, South lead multi).
    deals.client("rep2").post(f"/api/v1/sales/opportunities/{opp.pk}/won", {}, format="json")
    got = set(Notification.objects.filter(type="sales.opportunity.won").values_list("recipient_id", flat=True))
    names = {k for k, u in deals.users.items() if u.pk in got}
    assert names == {"manager", "multi", "ceo", "sales_admin", "owner", "admin"}
    # Preferences honoured: rep3 turns the in-app channel off for assignments.
    prefs, _ = NotificationPreference.objects.get_or_create(user=deals.users["rep3"])
    prefs.events = {**prefs.events, "sales.opportunity.reassigned": {"in_app": False, "email": False}}
    prefs.save()
    other = deals.opportunities["rep2"]
    deals.client("sales_admin").patch(
        f"/api/v1/sales/opportunities/{other.pk}", {"ownerId": str(deals.users["rep3"].pk)}, format="json"
    )
    assert not Notification.objects.filter(recipient=deals.users["rep3"]).exists()


def test_digest_is_idempotent_and_skipped_when_sales_is_off(deals):
    followup(deals, "rep", dt.date(2026, 10, 14), title="today")
    followup(deals, "rep", dt.date(2026, 10, 10), title="late")
    followup(deals, "rep2", dt.date(2026, 10, 30), title="later")
    at = dt.datetime(2026, 10, 14, 4, 30, tzinfo=dt.UTC)  # 07:30 in Addis Ababa
    run_job("sales_followup_digest", workspace_id=deals.ws.pk, now=at)
    run_job("sales_followup_digest", workspace_id=deals.ws.pk, now=at)
    rows = Notification.objects.filter(type__startswith="sales.followup.")
    assert [(n.recipient_id, n.type, n.payload["dueToday"], n.payload["overdue"]) for n in rows] == [
        (deals.users["rep"].pk, "sales.followup.due_today", 1, 1)
    ]
    set_module_enabled(deals.users["owner"], deals.ws, "sales", False)
    result = run_job("sales_followup_digest", workspace_id=deals.ws.pk, now=at + dt.timedelta(days=1))
    assert result.count("skipped") == 1
    assert rows.count() == 1


def test_expiring_quotation_notice(deals):
    from modules.sales.models import Quotation

    q = deals.quotations["rep"]
    Quotation.objects.filter(pk=q.pk).update(status="sent", valid_until=dt.date(2026, 10, 16))
    at = dt.datetime(2026, 10, 14, 0, 0, tzinfo=dt.UTC)
    run_job("sales_expire_quotations", workspace_id=deals.ws.pk, now=at)
    run_job("sales_expire_quotations", workspace_id=deals.ws.pk, now=at)
    assert Notification.objects.filter(type="sales.quotation.expiring", recipient=deals.users["rep"]).count() == 1
