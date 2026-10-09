"""Board 32: Epic.start_date / due_date, both or neither (docs/v2/32-timeline-calendar.md §2.2, §4.4)."""

import pytest
from django.db import IntegrityError, transaction

from apps.audit.models import AuditLog
from apps.common.testing import add_project_member, client_for, make_project
from apps.planning.models import Epic

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def epic(project):
    return Epic.objects.create(project=project, name="Sprint engine")


def url(epic):
    return f"/api/v1/epics/{epic.id}"


def fields(res):
    assert res.status_code == 422, res.content
    return res.json()["details"]["fields"]


def test_epic_dates_ordered_constraint(epic):
    qs = Epic.objects.filter(pk=epic.pk)
    for start, due in [("2026-09-01", None), (None, "2026-09-01"), ("2026-09-02", "2026-09-01")]:
        with pytest.raises(IntegrityError), transaction.atomic():
            qs.update(start_date=start, due_date=due)
    qs.update(start_date="2026-09-01", due_date="2026-09-01")
    qs.update(start_date=None, due_date=None)


def test_create_and_patch_with_dates(owner, project, epic):
    client = client_for(owner)
    created = client.post(
        f"/api/v1/projects/{project.id}/epics",
        {"name": "Auth overhaul", "startDate": "2026-09-14", "dueDate": "2026-10-23"},
        format="json",
    )
    assert created.status_code == 201, created.content
    assert (created.json()["startDate"], created.json()["dueDate"]) == ("2026-09-14", "2026-10-23")
    plain = client.post(f"/api/v1/projects/{project.id}/epics", {"name": "Plain"}, format="json").json()
    assert (plain["startDate"], plain["dueDate"]) == (None, None)
    body = client.patch(url(epic), {"startDate": "2026-09-01", "dueDate": "2026-11-11"}, format="json").json()
    assert (body["startDate"], body["dueDate"]) == ("2026-09-01", "2026-11-11")
    # One key alone is fine while the result keeps both dates.
    assert client.patch(url(epic), {"dueDate": "2026-10-30"}, format="json").json()["dueDate"] == "2026-10-30"
    # In the list and detail payloads.
    listed = {e["id"]: e for e in client.get(f"/api/v1/projects/{project.id}/epics").json()}
    assert (listed[str(epic.id)]["startDate"], listed[str(epic.id)]["dueDate"]) == ("2026-09-01", "2026-10-30")
    assert client.get(url(epic)).json()["startDate"] == "2026-09-01"
    # Clearing both makes the bar derived again.
    cleared = client.patch(url(epic), {"startDate": None, "dueDate": None}, format="json").json()
    assert (cleared["startDate"], cleared["dueDate"]) == (None, None)


def test_epic_date_validation(owner, project, epic):
    client = client_for(owner)
    assert fields(client.patch(url(epic), {"startDate": "2026-09-01"}, format="json")) == {
        "startDate": "Set both dates or neither"
    }
    assert fields(client.patch(url(epic), {"startDate": None, "dueDate": "2026-09-01"}, format="json")) == {
        "startDate": "Set both dates or neither"
    }
    assert fields(client.patch(url(epic), {"startDate": "2026-10-02", "dueDate": "2026-10-01"}, format="json")) == {
        "dueDate": "Target date must be on or after the start date"
    }
    assert fields(client.patch(url(epic), {"startDate": "Sep 1", "dueDate": "2026-13-01"}, format="json")) == {
        "startDate": "Pick a date",
        "dueDate": "Pick a date",
    }
    res = client.post(f"/api/v1/projects/{project.id}/epics", {"name": "X", "dueDate": "2026-10-01"}, format="json")
    assert fields(res) == {"startDate": "Set both dates or neither"}
    client.patch(url(epic), {"startDate": "2026-09-01", "dueDate": "2026-09-30"}, format="json")
    # Checked on the resulting pair: one side alone can't clear or reverse it.
    assert fields(client.patch(url(epic), {"dueDate": None}, format="json")) == {
        "startDate": "Set both dates or neither"
    }
    assert fields(client.patch(url(epic), {"startDate": "2026-10-01"}, format="json")) == {
        "dueDate": "Target date must be on or after the start date"
    }
    stored = Epic.objects.get(pk=epic.pk)
    assert (str(stored.start_date), str(stored.due_date)) == ("2026-09-01", "2026-09-30")
    assert Epic.objects.filter(name="X").count() == 0


def test_epic_dates_need_epic_manage(owner, project, epic):
    for key in ("project_member", "viewer"):
        user = add_project_member(project, key=key)
        res = client_for(user).patch(url(epic), {"startDate": "2026-09-01", "dueDate": "2026-09-30"}, format="json")
        assert res.status_code == 403
        assert res.json()["details"]["permission"] == "epic.manage"
    manager = add_project_member(project, key="manager")
    res = client_for(manager).patch(url(epic), {"startDate": "2026-09-01", "dueDate": "2026-09-30"}, format="json")
    assert res.status_code == 200


def test_epic_date_changes_are_audited(owner, epic):
    client = client_for(owner)
    client.patch(url(epic), {"startDate": "2026-09-01", "dueDate": "2026-10-30"}, format="json")
    client.patch(url(epic), {"dueDate": "2026-11-11"}, format="json")
    client.patch(url(epic), {"startDate": None, "dueDate": None}, format="json")
    rows = list(AuditLog.objects.filter(action="epic.updated", entity_id=epic.pk).order_by("created_at"))
    assert [r.changes for r in rows] == [
        [
            {"field": "Start date", "kind": "value", "before": None, "after": "2026-09-01"},
            {"field": "Target date", "kind": "value", "before": None, "after": "2026-10-30"},
        ],
        [{"field": "Target date", "kind": "value", "before": "2026-10-30", "after": "2026-11-11"}],
        [
            {"field": "Start date", "kind": "value", "before": "2026-09-01", "after": None},
            {"field": "Target date", "kind": "value", "before": "2026-11-11", "after": None},
        ],
    ]
