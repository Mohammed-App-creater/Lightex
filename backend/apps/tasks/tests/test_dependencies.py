"""Board 39: task dependencies (D1–D3), isBlocked / openBlockers and filter[blocked]."""

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.audit.models import AuditLog
from apps.common.testing import add_project_member, client_for, make_project
from apps.tasks.models import Task, TaskDependency
from apps.tasks.services import DEPENDENCY_LIMIT, create_task, delete_task, restore_task

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def st(project):
    return {s.glyph: s for s in project.statuses.all()}


@pytest.fixture
def tasks(owner, project):
    return [create_task(owner, project, {"title": f"Task {i}"}) for i in range(1, 6)]


def deps_url(task) -> str:
    return f"/api/v1/tasks/{task.id}/dependencies"


def add(client, task, relation, other):
    return client.post(deps_url(task), {"relation": relation, "taskId": str(other.id)}, format="json")


def test_add_both_relations_and_payload(owner, tasks):
    a, b, c = tasks[:3]
    client = client_for(owner)
    res = add(client, a, "blocked_by", b)
    assert res.status_code == 201, res.content
    body = res.json()
    assert body["taskId"] == str(a.id)
    assert body["isBlocked"] is True
    assert body["blocks"] == []
    [item] = body["blockedBy"]
    assert set(item) == {"id", "task", "createdAt", "createdById"}
    assert item["createdById"] == str(owner.id)
    assert item["task"] == {
        "id": str(b.id),
        "key": b.key,
        "title": b.title,
        "statusId": str(b.status_id),
        "status": {"name": b.status.name, "glyph": b.status.glyph, "category": b.status.category},
        "assigneeId": None,
    }
    res = add(client, a, "blocks", c)
    assert [i["task"]["key"] for i in res.json()["blocks"]] == [c.key]
    # Seen from the other side.
    other = client.get(deps_url(c)).json()
    assert [i["task"]["key"] for i in other["blockedBy"]] == [a.key]
    assert other["isBlocked"] is True
    # Embedded in TaskDetail, and no version bump on either task.
    detail = client.get(f"/api/v1/tasks/{a.id}").json()
    assert detail["dependencies"] == client.get(deps_url(a)).json()
    assert detail["version"] == 1
    assert Task.objects.get(pk=c.pk).version == 1


def test_validation(owner, ws, tasks, project):
    a, b = tasks[:2]
    client = client_for(owner)
    sub = create_task(owner, project, {"title": "Sub", "parentId": str(a.id)})
    other_project = make_project(ws, owner, key="OTH")
    foreign = create_task(owner, other_project, {"title": "Elsewhere"})
    cases = [
        ({"relation": "blocking", "taskId": str(b.id)}, {"relation": "Pick blocked by or blocks"}),
        ({"relation": "blocks", "taskId": str(foreign.id)}, {"taskId": "Pick a task from this project"}),
        ({"relation": "blocks", "taskId": "nope"}, {"taskId": "Pick a task from this project"}),
        ({"relation": "blocks", "taskId": str(a.id)}, {"taskId": "A task can’t depend on itself"}),
        (
            {"relation": "blocks", "taskId": str(sub.id)},
            {"taskId": "A task and its sub-task can’t depend on each other"},
        ),
    ]
    for payload, fields in cases:
        res = client.post(deps_url(a), payload, format="json")
        assert res.status_code == 422, payload
        assert res.json()["details"]["fields"] == fields
    res = client.post(deps_url(sub), {"relation": "blocked_by", "taskId": str(a.id)}, format="json")
    assert res.json()["details"]["fields"] == {"taskId": "A task and its sub-task can’t depend on each other"}


def test_duplicate_and_cycles(owner, tasks):
    a, b, c = tasks[:3]
    client = client_for(owner)
    assert add(client, a, "blocks", b).status_code == 201
    res = add(client, b, "blocked_by", a)  # the same row from the other side
    assert res.status_code == 409
    assert res.json()["code"] == "dependency_exists"
    assert res.json()["message"] == "These tasks are already linked."
    # 2-cycle: a blocks b; now "a blocked by b".
    res = add(client, a, "blocked_by", b)
    assert res.status_code == 409
    assert res.json()["code"] == "dependency_cycle"
    assert res.json()["details"]["path"] == [a.key, b.key, a.key]
    assert res.json()["message"] == f"That would create a loop: {a.key} → {b.key} → {a.key}."
    # 3-cycle: a → b → c, then c blocks a.
    assert add(client, b, "blocks", c).status_code == 201
    res = add(client, c, "blocks", a)
    assert res.status_code == 409
    assert res.json()["details"]["path"] == [a.key, b.key, c.key, a.key]
    res = add(client, a, "blocked_by", c)
    assert res.json()["details"]["path"] == [a.key, b.key, c.key, a.key]


def test_limit(owner, project, tasks):
    a = tasks[0]
    others = [create_task(owner, project, {"title": f"B{i}"}) for i in range(DEPENDENCY_LIMIT)]
    TaskDependency.objects.bulk_create([TaskDependency(blocker=o, blocked=a, project=project) for o in others])
    res = add(client_for(owner), a, "blocked_by", tasks[1])
    assert res.status_code == 409
    assert res.json()["code"] == "dependency_limit"
    assert res.json()["message"] == "A task can have up to 50 dependencies each way."
    # The other direction still has room.
    assert add(client_for(owner), a, "blocks", tasks[1]).status_code == 201


def test_deleted_tasks_are_ignored_and_come_back(owner, tasks):
    a, b, c = tasks[:3]
    client = client_for(owner)
    add(client, a, "blocked_by", b)
    add(client, b, "blocked_by", c)
    delete_task(owner, b)
    assert client.get(deps_url(a)).json() == {"taskId": str(a.id), "isBlocked": False, "blockedBy": [], "blocks": []}
    assert client.get(f"/api/v1/tasks/{a.id}").json()["isBlocked"] is False
    # The cycle check ignores rows of deleted tasks (c → b → a would otherwise be found via b).
    assert add(client, a, "blocks", c).status_code == 201
    # Writes on or against a deleted task.
    res = add(client, a, "blocked_by", b)
    assert res.status_code == 409
    assert res.json()["code"] == "task_deleted"
    assert add(client, b, "blocks", tasks[3]).status_code == 409
    assert client.get(deps_url(b)).status_code == 200  # readable while deleted
    restore_task(owner, Task.all_objects.get(pk=b.pk))
    assert client.get(deps_url(a)).json()["isBlocked"] is True


def test_remove_from_either_side_and_permissions(owner, project, tasks):
    member = add_project_member(project, key="project_member")
    viewer = add_project_member(project, key="viewer")
    mine = create_task(member, project, {"title": "Mine"})
    theirs, third = tasks[0], tasks[1]
    owner_client = client_for(owner)
    link = add(owner_client, mine, "blocked_by", theirs).json()["blockedBy"][0]["id"]
    # The member can edit `mine`, so they may remove the link from either task's URL.
    res = client_for(member).delete(f"{deps_url(theirs)}/{link}")
    assert res.status_code == 204
    assert not TaskDependency.objects.exists()
    # Adding needs edit rights on the addressed task.
    res = add(client_for(member), theirs, "blocks", mine)
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "task.edit_any"
    assert res.json()["message"] == "You can only edit tasks you reported or are assigned."
    assert add(client_for(member), mine, "blocked_by", theirs).status_code == 201
    blocks = add(owner_client, theirs, "blocks", third).json()["blocks"]
    other = next(i["id"] for i in blocks if i["task"]["key"] == third.key)
    res = client_for(member).delete(f"{deps_url(theirs)}/{other}")
    assert res.status_code == 403
    assert client_for(viewer).delete(f"{deps_url(theirs)}/{other}").status_code == 403
    # The row must involve the task in the URL.
    res = owner_client.delete(f"{deps_url(mine)}/{other}")
    assert res.status_code == 404
    assert res.json()["message"] == "Dependency not found."
    assert owner_client.delete(f"{deps_url(mine)}/not-a-uuid").status_code == 404


def test_remove_against_deleted_tasks(owner, tasks):
    a, b, c = tasks[:3]
    client = client_for(owner)
    ab = add(client, a, "blocked_by", b).json()["blockedBy"][0]["id"]
    ac = add(client, a, "blocks", c).json()["blocks"][0]["id"]
    delete_task(owner, b)
    assert client.delete(f"{deps_url(a)}/{ab}").status_code == 404  # hidden while b is deleted
    delete_task(owner, a)
    res = client.delete(f"{deps_url(a)}/{ac}")
    assert res.status_code == 409
    assert res.json()["code"] == "task_deleted"


def test_audit_and_activity(owner, tasks):
    a, b = tasks[:2]
    client = client_for(owner)
    link = add(client, a, "blocked_by", b).json()["blockedBy"][0]["id"]
    rows = {r.task_id: r for r in AuditLog.objects.filter(action="task.dependency_added")}
    assert rows[a.id].data == {"relation": "blocked_by", "otherKey": b.key, "otherTitle": b.title}
    assert rows[b.id].data == {"relation": "blocks", "otherKey": a.key, "otherTitle": a.title}
    assert rows[a.id].target == a.title
    client.delete(f"{deps_url(a)}/{link}")
    assert AuditLog.objects.filter(action="task.dependency_removed").count() == 2
    feed = client.get(f"/api/v1/tasks/{a.id}/activity").json()
    assert [e["verb"] for e in feed[:2]] == ["dependency_removed", "dependency_added"]
    assert feed[1]["data"] == {"relation": "blocked_by", "otherKey": b.key, "otherTitle": b.title}
    project_feed = client.get(f"/api/v1/projects/{a.project_id}/activity").json()["data"]
    assert sum(e["verb"] == "dependency_added" for e in project_feed) == 2


def test_add_takes_the_project_lock(owner, tasks):
    a, b = tasks[:2]
    with CaptureQueriesContext(connection) as ctx:
        assert add(client_for(owner), a, "blocks", b).status_code == 201
    locks = [q["sql"] for q in ctx.captured_queries if "FOR UPDATE" in q["sql"] and "projects_project" in q["sql"]]
    assert locks, "the add service must lock the project row before the cycle check"


def test_open_blockers_in_payloads(owner, project, st, tasks):
    a, b, c, d = tasks[:4]
    client = client_for(owner)
    for blocker in (c, b, d):
        add(client, a, "blocked_by", blocker)
    Task.objects.filter(pk=c.pk).update(status=st["done"])
    Task.objects.filter(pk=d.pk).update(status=st["canceled"])
    detail = client.get(f"/api/v1/tasks/{a.id}").json()
    assert detail["isBlocked"] is True
    assert detail["openBlockers"] == [{"id": str(b.id), "key": b.key, "title": b.title}]
    Task.objects.filter(pk=b.pk).update(assignee=owner, status=st["done"])
    Task.objects.filter(pk=a.pk).update(assignee=owner)
    board = client.get(f"/api/v1/projects/{project.id}/board?filter[sprint]=all").json()
    card = next(t for t in board["tasks"] if t["id"] == str(a.id))
    assert card["isBlocked"] is False
    assert card["openBlockers"] == []
    Task.objects.filter(pk=b.pk).update(status=st["progress"])
    listed = client.get(f"/api/v1/projects/{project.id}/tasks").json()["data"]
    assert next(t for t in listed if t["id"] == str(a.id))["isBlocked"] is True
    mine = client.get("/api/v1/me/tasks").json()["data"]
    assert next(t for t in mine if t["id"] == str(a.id))["openBlockers"][0]["key"] == b.key
    # task_data without annotations falls back to queries and agrees.
    from apps.tasks.serializers import task_data

    plain = task_data(Task.objects.get(pk=a.pk))
    assert plain["openBlockers"] == [{"id": str(b.id), "key": b.key, "title": b.title}]
    assert plain["loggedMinutes"] == 0


def test_filter_blocked(owner, project, tasks):
    a, b = tasks[:2]
    client = client_for(owner)
    add(client, a, "blocked_by", b)
    base = f"/api/v1/projects/{project.id}/tasks"
    assert [t["id"] for t in client.get(f"{base}?filter[blocked]=true").json()["data"]] == [str(a.id)]
    assert str(a.id) not in [t["id"] for t in client.get(f"{base}?filter[blocked]=false").json()["data"]]
    both = client.get(f"{base}?filter[blocked]=true&filter[blocked]=false").json()["data"]
    assert len(both) == len(tasks)
    res = client.get(f"{base}?filter[blocked]=yes")
    assert res.status_code == 422
    assert res.json()["details"]["fields"] == {"filter[blocked]": "Use true or false"}


def test_board_query_count_is_flat_with_board39_data(owner, project):
    from apps.projects.custom_fields import create_field
    from apps.tasks.models import TaskFieldValue
    from apps.timetracking.models import TimeEntry

    field = create_field(owner, project, {"name": "Found in", "type": "text"})

    def grow(n):
        made = [create_task(owner, project, {"title": f"T{i}"}) for i in range(n)]
        for i, t in enumerate(made):
            TaskFieldValue.objects.create(task=t, field=field, text="v1")
            TimeEntry.objects.create(
                task=t, project=project, user=owner, minutes=30, date="2026-10-07", source="manual"
            )
            if i:
                TaskDependency.objects.create(blocker=made[i - 1], blocked=t, project=project)

    client = client_for(owner)
    url = f"/api/v1/projects/{project.id}/board?filter[sprint]=all"
    grow(5)
    client.get(url)
    with CaptureQueriesContext(connection) as small:
        assert len(client.get(url).json()["tasks"]) == 5
    grow(45)
    with CaptureQueriesContext(connection) as big:
        tasks = client.get(url).json()["tasks"]
    assert len(tasks) == 50
    assert len(big.captured_queries) == len(small.captured_queries)
    assert {t["loggedMinutes"] for t in tasks} == {30}
    assert sum(t["isBlocked"] for t in tasks) == 48
