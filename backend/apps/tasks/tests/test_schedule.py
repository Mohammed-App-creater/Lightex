"""Board 32: Task.start_date, the range / scheduled filters, the startDate sort and the reschedule rules
(docs/v2/32-timeline-calendar.md §2.1, §4.1–§4.3, §7.1)."""

import json
from pathlib import Path

import pytest
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext

from apps.access.models import Permission, Role, RolePermission
from apps.audit.models import AuditLog
from apps.common.exceptions import ApiError
from apps.common.testing import UserFactory, add_member, add_project_member, client_for, make_project
from apps.planning.models import Epic, Sprint
from apps.projects.models import ProjectMember
from apps.tasks.models import Task
from apps.tasks.services import create_task, delete_task, update_task

pytestmark = pytest.mark.django_db

VECTORS = json.loads((Path(__file__).parent / "data" / "span_vectors.json").read_text(encoding="utf-8"))["cases"]


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def st(project):
    return {s.glyph: s for s in project.statuses.all()}


def dated(owner, project, title, start=None, due=None, **extra):
    return create_task(owner, project, {"title": title, "startDate": start, "dueDate": due, **extra})


def tasks_url(project, query=""):
    return f"/api/v1/projects/{project.id}/tasks{query}"


def keys(res):
    assert res.status_code == 200, res.content
    return [t["key"] for t in res.json()["data"]]


def fields(res, status=422):
    assert res.status_code == status, res.content
    return res.json()["details"]["fields"]


# ───────────────────────── model ─────────────────────────


def refused(fn):
    with pytest.raises(IntegrityError), transaction.atomic():
        fn()


def test_task_dates_ordered_constraint(owner, project):
    task = create_task(owner, project, {"title": "T"})
    qs = Task.objects.filter(pk=task.pk)
    refused(lambda: qs.update(start_date="2026-10-10", due_date="2026-10-09"))
    qs.update(start_date="2026-10-10", due_date=None)  # start-only
    qs.update(start_date=None, due_date="2026-10-10")  # due-only
    qs.update(start_date="2026-10-10", due_date="2026-10-10")  # same day


# ───────────────────────── L1 range filter ─────────────────────────


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_shared_span_vectors(owner, project, case):
    dated(owner, project, "Probe", case["startDate"], case["dueDate"])
    query = "&".join(f"filter[{k}]={case[k]}" for k in ("from", "to") if case[k])
    assert keys(client_for(owner).get(tasks_url(project, f"?{query}"))) == (["PRJ-1"] if case["expected"] else [])


def test_range_combines_with_filters_and_excludes_deleted(owner, ws, project, st):
    sam = add_project_member(project, UserFactory(name="Sam"))
    epic = Epic.objects.create(project=project, name="Auth")
    a = dated(owner, project, "Session modal", "2026-10-06", "2026-10-10", assigneeId=str(sam.id))
    b = dated(owner, project, "Token race", None, "2026-10-09", epicId=str(epic.id))
    dated(owner, project, "Outside", None, "2026-12-09", assigneeId=str(sam.id))
    canceled = dated(owner, project, "Dropped", "2026-10-01", "2026-10-02", statusId=str(st["canceled"].id))
    gone = dated(owner, project, "Gone", "2026-10-01", "2026-10-02")
    delete_task(owner, gone)
    client = client_for(owner)
    window = "?filter[from]=2026-10-01&filter[to]=2026-10-31"
    assert keys(client.get(tasks_url(project, window))) == [a.key, b.key, canceled.key]  # canceled included
    assert keys(client.get(tasks_url(project, f"{window}&filter[assignee]={sam.id}"))) == [a.key]
    assert keys(client.get(tasks_url(project, f"{window}&filter[epic]={epic.id}"))) == [b.key]
    assert keys(client.get(tasks_url(project, f"{window}&q=token"))) == [b.key]


def test_scheduled_filter(owner, project):
    undated = dated(owner, project, "Undated")
    start_only = dated(owner, project, "Start only", "2026-10-01")
    due_only = dated(owner, project, "Due only", None, "2026-10-01")
    client = client_for(owner)
    assert keys(client.get(tasks_url(project, "?filter[scheduled]=true"))) == [start_only.key, due_only.key]
    assert keys(client.get(tasks_url(project, "?filter[scheduled]=false"))) == [undated.key]
    # A range with scheduled=false is always empty, not an error.
    query = "?filter[scheduled]=false&filter[from]=2026-01-01&filter[to]=2026-12-31"
    assert keys(client.get(tasks_url(project, query))) == []


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("filter[from]=2026-13-01", {"filter[from]": "Pick a date"}),
        ("filter[from]=2026-10-1", {"filter[from]": "Pick a date"}),
        ("filter[to]=tomorrow", {"filter[to]": "Pick a date"}),
        ("filter[from]=x&filter[to]=y", {"filter[from]": "Pick a date", "filter[to]": "Pick a date"}),
        ("filter[from]=2026-10-02&filter[to]=2026-10-01", {"filter[to]": "End must be on or after the start"}),
        ("filter[from]=2026-01-01&filter[to]=2027-02-05", {"filter[to]": "Pick a range of 400 days or less"}),
        ("filter[scheduled]=yes", {"filter[scheduled]": "Use true or false"}),
    ],
)
def test_range_validation(owner, project, query, expected):
    res = client_for(owner).get(tasks_url(project, f"?{query}"))
    assert res.json()["code"] == "validation_failed"
    assert fields(res) == expected


def test_range_of_exactly_400_days_is_allowed(owner, project):
    res = client_for(owner).get(tasks_url(project, "?filter[from]=2026-01-01&filter[to]=2027-02-04"))
    assert res.status_code == 200


def test_range_project_resolution(owner, ws, project):
    outsider = UserFactory()
    assert client_for(outsider).get(tasks_url(project, "?filter[from]=2026-10-01")).status_code == 404
    ws_member = add_member(ws, UserFactory())
    res = client_for(ws_member).get(tasks_url(project, "?filter[from]=2026-10-01"))
    assert res.status_code == 403
    assert res.json()["code"] == "project_membership_required"


def test_start_date_sort_nulls_and_paging(owner, project):
    late = dated(owner, project, "Late", "2026-10-20")
    undated = dated(owner, project, "Undated")
    early = dated(owner, project, "Early", "2026-10-01", "2026-10-03")
    tie_a = dated(owner, project, "Tie A", "2026-10-10")
    tie_b = dated(owner, project, "Tie B", "2026-10-10")
    due_only = dated(owner, project, "Due only", None, "2026-09-01")
    client = client_for(owner)
    ties = sorted([tie_a, tie_b], key=lambda t: str(t.id))
    nulls = sorted([undated, due_only], key=lambda t: str(t.id))
    ascending = [early.key, *[t.key for t in ties], late.key, *[t.key for t in nulls]]
    assert keys(client.get(tasks_url(project, "?sort=startDate"))) == ascending
    descending = client.get(tasks_url(project, "?sort=-startDate")).json()["data"]
    assert [t["startDate"] for t in descending[:2]] == [None, None]  # nulls first descending
    assert [t["key"] for t in descending[2:]] == [late.key, *[t.key for t in ties], early.key]
    # Paging two at a time follows the same order with no gaps or repeats.
    seen, cursor = [], None
    for _ in range(5):
        query = "?sort=startDate&limit=2" + (f"&cursor={cursor}" if cursor else "")
        page = client.get(tasks_url(project, query)).json()
        seen += [t["key"] for t in page["data"]]
        cursor = page["nextCursor"]
        if not cursor:
            break
    assert seen == ascending


def test_range_query_count_is_flat(owner, project):
    def run():
        client = client_for(owner)
        query = "?filter[from]=2026-09-01&filter[to]=2026-11-30&sort=startDate"
        client.get(tasks_url(project, query))
        with CaptureQueriesContext(connection) as ctx:
            res = client.get(tasks_url(project, query))
        return len(ctx.captured_queries), len(res.json()["data"])

    for i in range(5):
        dated(owner, project, f"T{i}", "2026-10-01", "2026-10-05")
    small, n_small = run()
    for i in range(45):
        dated(owner, project, f"More {i}", None, "2026-10-09")
    big, n_big = run()
    assert (n_small, n_big) == (5, 50)
    assert big == small


# ───────────────────────── T1 PATCH ─────────────────────────


def patch(client, task, body, version=None):
    return client.patch(
        f"/api/v1/tasks/{task.id}", {**body, "version": version if version else task.version}, format="json"
    )


def test_set_clear_move_and_resize(owner, project):
    task = dated(owner, project, "Session modal", None, "2026-10-10")
    client = client_for(owner)
    res = patch(client, task, {"startDate": "2026-10-06"})
    assert res.status_code == 200, res.content
    body = res.json()
    assert (body["startDate"], body["dueDate"], body["version"]) == ("2026-10-06", "2026-10-10", 2)
    # Move: both dates in one PATCH, version bumped once.
    body = patch(client, task, {"startDate": "2026-10-08", "dueDate": "2026-10-12"}, 2).json()
    assert (body["startDate"], body["dueDate"], body["version"]) == ("2026-10-08", "2026-10-12", 3)
    # Resize the start edge, then the due edge.
    body = patch(client, task, {"startDate": "2026-10-03"}, 3).json()
    assert (body["startDate"], body["dueDate"]) == ("2026-10-03", "2026-10-12")
    body = patch(client, task, {"dueDate": "2026-10-03"}, 4).json()
    assert (body["startDate"], body["dueDate"]) == ("2026-10-03", "2026-10-03")
    # Clear the start (due-only again), then clear the due with a start set (start-only).
    body = patch(client, task, {"startDate": None}, 5).json()
    assert (body["startDate"], body["dueDate"]) == (None, "2026-10-03")
    body = patch(client, task, {"startDate": "2026-10-01", "dueDate": None}, 6).json()
    assert (body["startDate"], body["dueDate"], body["version"]) == ("2026-10-01", None, 7)
    # A no-op PATCH still bumps the version.
    assert patch(client, task, {"startDate": "2026-10-01"}, 7).json()["version"] == 8


def test_patch_messages(owner, project):
    task = dated(owner, project, "T", "2026-10-06", "2026-10-10")
    client = client_for(owner)
    assert fields(patch(client, task, {"startDate": "2026-10-11"})) == {
        "startDate": "Start date must be on or before the due date"
    }
    assert fields(patch(client, task, {"dueDate": "2026-10-05"})) == {
        "dueDate": "Due date must be on or after the start date"
    }
    assert fields(patch(client, task, {"startDate": "2026-10-12", "dueDate": "2026-10-11"})) == {
        "startDate": "Start date must be on or before the due date"
    }
    assert fields(patch(client, task, {"startDate": "06/10/2026"})) == {"startDate": "Pick a date"}
    assert fields(patch(client, task, {"startDate": 20261006})) == {"startDate": "Pick a date"}
    assert fields(patch(client, task, {"startDate": "2026-02-30", "dueDate": "soon"})) == {
        "startDate": "Pick a date",
        "dueDate": "Pick a date",
    }
    missing_version = client.patch(f"/api/v1/tasks/{task.id}", {"startDate": "2026-10-01"}, format="json")
    assert fields(missing_version) == {"version": "Send the version you edited (optimistic concurrency)."}
    stored = Task.objects.get(pk=task.pk)
    assert (str(stored.start_date), str(stored.due_date), stored.version) == ("2026-10-06", "2026-10-10", 1)


def test_order_check_uses_the_stored_value_for_the_unsent_key(owner, project):
    task = dated(owner, project, "T", None, "2026-10-10")
    client = client_for(owner)
    assert fields(patch(client, task, {"startDate": "2026-10-11"})) == {
        "startDate": "Start date must be on or before the due date"
    }
    start_only = dated(owner, project, "S", "2026-10-10")
    assert fields(patch(client, start_only, {"dueDate": "2026-10-09"})) == {
        "dueDate": "Due date must be on or after the start date"
    }


def test_version_is_checked_first(owner, project):
    task = dated(owner, project, "T", "2026-10-06", "2026-10-10")
    res = patch(client_for(owner), task, {"startDate": "2026-10-30"}, 9)
    assert res.status_code == 409
    assert res.json()["code"] == "version_conflict"
    assert res.json()["details"]["current"]["startDate"] == "2026-10-06"


def test_edit_rights(owner, ws, project):
    sam = add_project_member(project, UserFactory())
    own = dated(owner, project, "Mine", None, "2026-10-10", assigneeId=str(sam.id))
    other = dated(owner, project, "Not mine", None, "2026-10-10")
    client = client_for(sam)
    assert patch(client, own, {"startDate": "2026-10-08"}).status_code == 200
    res = patch(client, other, {"startDate": "2026-10-08"})
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "task.edit_any"
    assert res.json()["message"] == "You can only edit tasks you reported or are assigned."
    viewer = add_project_member(project, UserFactory(), key="viewer")
    assert patch(client_for(viewer), other, {"dueDate": "2026-10-11"}).status_code == 403


def test_task_move_alone_cannot_reschedule(owner, ws, project):
    mover_role = Role.objects.create(workspace=ws, name="Mover", scope="project")
    for code in ("project.view", "task.move"):
        RolePermission.objects.create(role=mover_role, permission=Permission.objects.get(code=code))
    mover = add_project_member(project, UserFactory())
    ProjectMember.objects.filter(project=project, user=mover).update(role=mover_role)
    task = dated(owner, project, "T", None, "2026-10-10")
    res = patch(client_for(mover), task, {"dueDate": "2026-10-12"})
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "task.edit_any"


def test_deleted_task_and_archived_project(owner, project):
    task = dated(owner, project, "T", None, "2026-10-10")
    delete_task(owner, task)
    gone = Task.all_objects.get(pk=task.pk)
    with pytest.raises(ApiError) as exc:
        update_task(owner, gone, {"startDate": "2026-10-01", "version": gone.version})
    assert (exc.value.status_code, exc.value.code) == (409, "task_deleted")
    live = dated(owner, project, "Live", None, "2026-10-10")
    client = client_for(owner)
    assert client.post(f"/api/v1/projects/{project.id}/archive").status_code == 200
    assert patch(client, live, {"startDate": "2026-10-01"}).status_code == 403


def test_reschedule_is_audited_and_in_the_activity_feed(owner, project):
    task = dated(owner, project, "T", "2026-10-06", "2026-10-10")
    client = client_for(owner)
    patch(client, task, {"startDate": "2026-10-08", "dueDate": "2026-10-12"})
    row = AuditLog.objects.filter(action="task.updated", entity_id=task.pk).latest("created_at")
    assert row.changes == [
        {"field": "Start date", "kind": "value", "before": "2026-10-06", "after": "2026-10-08"},
        {"field": "Due date", "kind": "value", "before": "2026-10-10", "after": "2026-10-12"},
    ]
    patch(client, task, {"startDate": None}, 2)
    row = AuditLog.objects.filter(action="task.updated", entity_id=task.pk).latest("created_at")
    assert row.changes == [{"field": "Start date", "kind": "value", "before": "2026-10-08", "after": None}]
    feed = client.get(f"/api/v1/tasks/{task.id}/activity").json()
    items = feed["data"] if isinstance(feed, dict) else feed
    assert sum(1 for a in items if a["verb"] == "updated") == 2


def test_start_date_survives_trash_and_restore(owner, project):
    task = dated(owner, project, "T", "2026-10-06", "2026-10-10")
    client = client_for(owner)
    client.delete(f"/api/v1/tasks/{task.id}")
    assert client.post(f"/api/v1/tasks/{task.id}/restore").json()["startDate"] == "2026-10-06"


# ───────────────────────── T2 create, T3 bulk ─────────────────────────


def test_create_accepts_and_validates_start_date(owner, project):
    client = client_for(owner)
    url = tasks_url(project)
    body = client.post(url, {"title": "T", "startDate": "2026-10-06", "dueDate": "2026-10-10"}, format="json").json()
    assert (body["startDate"], body["dueDate"]) == ("2026-10-06", "2026-10-10")
    assert client.post(url, {"title": "S", "startDate": "2026-10-06"}, format="json").json()["startDate"] == (
        "2026-10-06"
    )
    assert client.post(url, {"title": "N"}, format="json").json()["startDate"] is None
    res = client.post(url, {"title": "T", "startDate": "2026-10-11", "dueDate": "2026-10-10"}, format="json")
    assert fields(res) == {"startDate": "Start date must be on or before the due date"}
    assert fields(client.post(url, {"title": "T", "startDate": "next week"}, format="json")) == {
        "startDate": "Pick a date"
    }
    assert Task.objects.count() == 3


def test_bulk_refuses_start_date_and_checks_due_against_starts(owner, project):
    a = dated(owner, project, "A", "2026-10-06", "2026-10-10")
    b = dated(owner, project, "B", "2026-10-02", "2026-10-03")
    c = dated(owner, project, "C", None, "2026-10-01")
    client = client_for(owner)
    url = f"/api/v1/projects/{project.id}/tasks/bulk"
    ids = [str(t.id) for t in (a, b, c)]
    res = client.post(url, {"ids": ids, "patch": {"startDate": "2026-10-01"}}, format="json")
    assert fields(res) == {"patch.startDate": "This field can’t be bulk-edited"}
    res = client.post(url, {"ids": ids, "patch": {"dueDate": "2026-10-04"}}, format="json")
    assert fields(res) == {"patch.dueDate": f"{a.key} starts after this date"}
    res = client.post(url, {"ids": [str(b.id), str(a.id)], "patch": {"dueDate": "2026-10-01"}}, format="json")
    assert fields(res) == {"patch.dueDate": f"{a.key} starts after this date"}  # first by number
    assert fields(client.post(url, {"ids": ids, "patch": {"dueDate": "Oct 9"}}, format="json")) == {
        "patch.dueDate": "Pick a date"
    }
    assert sorted(str(d) for d in Task.objects.values_list("due_date", flat=True)) == [
        "2026-10-01",
        "2026-10-03",
        "2026-10-10",
    ]  # nothing written
    res = client.post(url, {"ids": ids, "patch": {"dueDate": None}}, format="json")
    assert res.status_code == 200, res.content
    assert [(t["startDate"], t["dueDate"]) for t in sorted(res.json(), key=lambda t: t["number"])] == [
        ("2026-10-06", None),
        ("2026-10-02", None),
        (None, None),
    ]
    ok = client.post(url, {"ids": ids[:2], "patch": {"dueDate": "2026-10-20"}}, format="json")
    assert [t["dueDate"] for t in ok.json()] == ["2026-10-20", "2026-10-20"]


# ───────────────────────── payloads ─────────────────────────


def test_start_date_in_every_task_payload(owner, ws, project):
    sprint = Sprint.objects.create(
        project=project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-14", state="active"
    )
    task = dated(owner, project, "Searchable timeline task", "2026-10-06", "2026-10-10", assigneeId=str(owner.id))
    assert task.sprint_id == sprint.pk
    client = client_for(owner)

    def found(items):
        return next(t for t in items if t["id"] == str(task.id))["startDate"]

    assert found(client.get(f"/api/v1/projects/{project.id}/board").json()["tasks"]) == "2026-10-06"
    backlog = client.get(f"/api/v1/projects/{project.id}/backlog").json()
    assert found([t for s in backlog["sprints"] for t in s["tasks"]] + backlog["backlog"]) == "2026-10-06"
    assert found(client.get("/api/v1/me/tasks").json()["data"]) == "2026-10-06"
    assert found(client.get(f"/api/v1/workspaces/{ws.slug}/tasks").json()["data"]) == "2026-10-06"
    assert found(client.get(f"/api/v1/sprints/{sprint.id}/board").json()["tasks"]) == "2026-10-06"
    results = client.get("/api/v1/search?q=timeline&type=task").json()["data"]
    assert found([r["task"] for r in results]) == "2026-10-06"
    assert client.get(f"/api/v1/tasks/{task.id}").json()["startDate"] == "2026-10-06"
    assert client.get(f"/api/v1/workspaces/{ws.slug}/tasks/{task.key}").json()["startDate"] == "2026-10-06"
    bulk = client.post(
        f"/api/v1/projects/{project.id}/tasks/bulk", {"ids": [str(task.id)], "patch": {"priority": 3}}, format="json"
    )
    assert found(bulk.json()) == "2026-10-06"
    stale = patch(client, task, {"title": "x"}, 99)
    assert stale.json()["details"]["current"]["startDate"] == "2026-10-06"
