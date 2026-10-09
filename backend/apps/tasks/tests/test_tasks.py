import pytest

from apps.audit.models import AuditLog
from apps.common.testing import UserFactory, add_project_member, client_for, make_project, make_workspace
from apps.planning.models import Epic, Objective, Sprint
from apps.tasks.models import Task, TaskStatusHistory
from apps.tasks.services import create_task

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def st(project):
    return {s.glyph: s for s in project.statuses.all()}


def new(client, project, **body):
    res = client.post(f"/api/v1/projects/{project.id}/tasks", {"title": "Task", **body}, format="json")
    assert res.status_code == 201, res.content
    return res.json()


def test_create_task_payload_and_side_effects(owner, project, st):
    client = client_for(owner)
    body = new(
        client, project, title="Fix flaky board reflow", priority=3, type="bug", estimate=5, dueDate="2026-10-20"
    )
    assert body["key"] == "PRJ-1"
    assert body["number"] == 1
    assert body["statusId"] == str(st["todo"].id)
    assert body["reporterId"] == str(owner.id)
    assert body["version"] == 1
    assert body["sprintId"] is None
    assert body["position"]
    assert set(body) == {
        "id", "projectId", "key", "number", "title", "type", "priority", "statusId", "assigneeId", "reporterId",
        "estimate", "dueDate", "epicId", "milestoneId", "sprintId", "parentId", "objectiveIds", "labelIds",
        "position", "version", "createdAt", "updatedAt", "completedAt", "deletedAt", "subtaskCount",
        "subtaskDoneCount", "commentCount", "attachmentCount",
        "customFields", "isBlocked", "openBlockers", "timeEstimateMinutes", "loggedMinutes", "startDate",
    }  # fmt: skip
    second = new(client, project, title="Second")
    assert second["key"] == "PRJ-2"
    assert second["position"] > body["position"]
    assert TaskStatusHistory.objects.filter(task_id=body["id"], from_status=None, to_status=st["todo"]).exists()
    assert AuditLog.objects.filter(action="task.created", entity_key="PRJ-1").exists()


def test_create_validation_and_cross_project_refs(owner, ws, project, st):
    client = client_for(owner)
    assert client.post(f"/api/v1/projects/{project.id}/tasks", {"title": "  "}, format="json").status_code == 422
    other = make_project(ws, owner, key="OTH")
    other_status = other.statuses.first()
    other_epic = Epic.objects.create(project=other, name="Elsewhere")
    other_label = other.labels.first()
    for field, value in [
        ("statusId", str(other_status.id)),
        ("epicId", str(other_epic.id)),
        ("labelIds", [str(other_label.id)]),
        ("priority", 7),
        ("type", "story"),
        ("dueDate", "not-a-date"),
        ("estimate", "x"),
        ("assigneeId", str(UserFactory().id)),
    ]:
        res = client.post(f"/api/v1/projects/{project.id}/tasks", {"title": "T", field: value}, format="json")
        assert res.status_code == 422, field
    other_task = create_task(owner, other, {"title": "Other"})
    res = client.post(
        f"/api/v1/projects/{project.id}/tasks", {"title": "T", "parentId": str(other_task.id)}, format="json"
    )
    assert res.status_code == 422


def test_new_tasks_join_the_active_sprint(owner, project):
    sprint = Sprint.objects.create(
        project=project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-14", state="active"
    )
    client = client_for(owner)
    assert new(client, project)["sprintId"] == str(sprint.id)
    assert new(client, project, sprintId=None)["sprintId"] is None
    done = Sprint.objects.create(
        project=project, name="S0", number=0, start_date="2026-09-01", end_date="2026-09-14", state="completed"
    )
    res = client.post(f"/api/v1/projects/{project.id}/tasks", {"title": "T", "sprintId": str(done.id)}, format="json")
    assert res.status_code == 422


def test_subtasks_one_level_and_inherit_sprint(owner, project):
    sprint = Sprint.objects.create(project=project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-14")
    client = client_for(owner)
    parent = new(client, project, sprintId=str(sprint.id))
    child = client.post(f"/api/v1/tasks/{parent['id']}/subtasks", {"title": "Child"}, format="json")
    assert child.status_code == 201
    assert child.json()["parentId"] == parent["id"]
    assert child.json()["sprintId"] == str(sprint.id)
    grandchild = client.post(f"/api/v1/tasks/{child.json()['id']}/subtasks", {"title": "Nope"}, format="json")
    assert grandchild.status_code == 422
    listed = client.get(f"/api/v1/tasks/{parent['id']}/subtasks").json()
    assert [t["id"] for t in listed] == [child.json()["id"]]
    detail = client.get(f"/api/v1/tasks/{parent['id']}").json()
    assert detail["subtaskCount"] == 1
    assert detail["subtasks"][0]["id"] == child.json()["id"]
    assert detail["project"]["key"] == "PRJ"
    assert "project.delete" in detail["project"]["my_permissions"]
    # Subtasks follow their parent's sprint.
    res = client.patch(f"/api/v1/tasks/{child.json()['id']}", {"sprintId": None, "version": 1}, format="json")
    assert res.status_code == 422


def test_task_by_key_and_id(owner, ws, project):
    client = client_for(owner)
    t = new(client, project, title="Lookup")
    assert client.get("/api/v1/workspaces/platform/tasks/prj-1").json()["id"] == t["id"]
    assert client.get("/api/v1/tasks/PRJ-1").json()["id"] == t["id"]
    assert client.get(f"/api/v1/tasks/{t['id']}").json()["key"] == "PRJ-1"
    assert client.get("/api/v1/workspaces/platform/tasks/PRJ-99").status_code == 404
    recents = client.get("/api/v1/me/recents").json()
    assert recents[0] == {**recents[0], "kind": "task", "id": t["id"]}


def test_update_and_version_conflict(owner, project, st):
    client = client_for(owner)
    t = new(client, project, title="Original")
    res = client.patch(f"/api/v1/tasks/{t['id']}", {"title": "Renamed", "priority": 2, "version": 1}, format="json")
    assert res.status_code == 200
    assert res.json()["version"] == 2
    stale = client.patch(f"/api/v1/tasks/{t['id']}", {"title": "Stale", "version": 1}, format="json")
    assert stale.status_code == 409
    assert stale.json()["code"] == "version_conflict"
    assert stale.json()["details"]["current"]["title"] == "Renamed"
    assert stale.json()["details"]["current"]["version"] == 2
    assert client.patch(f"/api/v1/tasks/{t['id']}", {"title": "No version"}, format="json").status_code == 422
    assert client.patch(f"/api/v1/tasks/{t['id']}", {"key": "PRJ-9", "version": 2}, format="json").status_code == 422
    entry = AuditLog.objects.filter(action="task.updated").latest("created_at")
    assert {c["field"] for c in entry.changes} == {"Title", "Priority"}


def test_status_change_sets_and_clears_completed_at(owner, project, st):
    client = client_for(owner)
    t = new(client, project)
    started = client.patch(
        f"/api/v1/tasks/{t['id']}", {"statusId": str(st["progress"].id), "version": 1}, format="json"
    ).json()
    assert started["completedAt"] is None
    done = client.patch(
        f"/api/v1/tasks/{t['id']}", {"statusId": str(st["done"].id), "version": 2}, format="json"
    ).json()
    assert done["completedAt"] is not None
    reopened = client.patch(
        f"/api/v1/tasks/{t['id']}", {"statusId": str(st["todo"].id), "version": 3}, format="json"
    ).json()
    assert reopened["completedAt"] is None
    canceled = client.patch(
        f"/api/v1/tasks/{t['id']}", {"statusId": str(st["canceled"].id), "version": 4}, format="json"
    ).json()
    assert canceled["completedAt"] is None
    task = Task.objects.get(pk=t["id"])
    assert task.started_at is not None
    history = list(TaskStatusHistory.objects.filter(task=task).order_by("at").values_list("to_category", flat=True))
    assert history == ["todo", "in_progress", "done", "todo", "done"]
    assert AuditLog.objects.filter(action="task.status_changed", task=task).count() == 4


def test_edit_own_vs_edit_any(owner, project, st):
    member = add_project_member(project, key="project_member")
    other = add_project_member(project, key="project_member")
    viewer = add_project_member(project, key="viewer")
    theirs = create_task(other, project, {"title": "Theirs"})
    mine = create_task(member, project, {"title": "Mine"})
    c = client_for(member)
    assert c.patch(f"/api/v1/tasks/{mine.id}", {"title": "Ok", "version": 1}, format="json").status_code == 200
    denied = c.patch(f"/api/v1/tasks/{theirs.id}", {"title": "No", "version": 1}, format="json")
    assert denied.status_code == 403
    assert denied.json()["details"]["permission"] == "task.edit_any"
    # task.move lets a member change only the status of someone else's task.
    moved = c.patch(f"/api/v1/tasks/{theirs.id}", {"statusId": str(st["progress"].id), "version": 1}, format="json")
    assert moved.status_code == 200
    assert (
        client_for(viewer)
        .patch(f"/api/v1/tasks/{theirs.id}", {"statusId": str(st["done"].id), "version": 2}, format="json")
        .status_code
        == 403
    )
    # The manager edits anything.
    manager = add_project_member(project, key="manager")
    assert (
        client_for(manager)
        .patch(f"/api/v1/tasks/{theirs.id}", {"title": "Edited", "version": 2}, format="json")
        .status_code
        == 200
    )


def test_assign_requires_task_assign(owner, ws, project):
    from apps.access.models import Role

    limited = Role.objects.create(workspace=ws, name="Limited", scope="project")
    limited.permissions.set(
        __import__("apps.access.models", fromlist=["Permission"]).Permission.objects.filter(
            code__in=["project.view", "task.create", "task.edit_own"]
        )
    )
    user = add_project_member(project, key="viewer")
    from apps.projects.models import ProjectMember

    ProjectMember.objects.filter(project=project, user=user).update(role=limited)
    teammate = add_project_member(project, key="project_member")
    c = client_for(user)
    res = c.post(f"/api/v1/projects/{project.id}/tasks", {"title": "T", "assigneeId": str(teammate.id)}, format="json")
    assert res.status_code == 403
    mine = new(c, project, assigneeId=str(user.id))
    assert (
        c.patch(
            f"/api/v1/tasks/{mine['id']}", {"assigneeId": str(teammate.id), "version": 1}, format="json"
        ).status_code
        == 403
    )
    ok = client_for(owner).patch(
        f"/api/v1/tasks/{mine['id']}", {"assigneeId": str(teammate.id), "version": 1}, format="json"
    )
    assert ok.status_code == 200
    assert AuditLog.objects.filter(action="task.assigned").exists()


def test_labels_and_objectives_links(owner, project):
    client = client_for(owner)
    t = new(client, project)
    labels = [str(lb.id) for lb in project.labels.all()[:2]]
    res = client.put(f"/api/v1/tasks/{t['id']}/labels", {"labelIds": labels}, format="json")
    assert sorted(res.json()["labelIds"]) == sorted(labels)
    objective = Objective.objects.create(project=project, title="Ship beta")
    res = client.put(f"/api/v1/tasks/{t['id']}/objectives", {"objectiveIds": [str(objective.id)]}, format="json")
    assert res.json()["objectiveIds"] == [str(objective.id)]
    assert AuditLog.objects.filter(action="task.objective_linked").exists()
    assert client.put(f"/api/v1/tasks/{t['id']}/labels", {"labelIds": "x"}, format="json").status_code == 422


def test_delete_and_restore_with_subtasks(owner, project):
    client = client_for(owner)
    parent = new(client, project)
    child = client.post(f"/api/v1/tasks/{parent['id']}/subtasks", {"title": "C"}, format="json").json()
    assert client.delete(f"/api/v1/tasks/{parent['id']}").status_code == 204
    assert client.get(f"/api/v1/tasks/{parent['id']}").status_code == 404
    assert Task.all_objects.get(pk=child["id"]).deleted_at is not None
    # Can't restore a subtask while its parent is deleted.
    assert client.post(f"/api/v1/tasks/{child['id']}/restore").status_code == 409
    restored = client.post(f"/api/v1/tasks/{parent['id']}/restore")
    assert restored.status_code == 200
    assert restored.json()["deletedAt"] is None
    assert Task.objects.filter(pk=child["id"]).exists()
    deleted_edit = client.delete(f"/api/v1/tasks/{parent['id']}")
    assert deleted_edit.status_code == 204
    assert client.post(f"/api/v1/tasks/{parent['id']}/restore").status_code == 200
    assert client.post(f"/api/v1/tasks/{parent['id']}/restore").status_code == 200  # idempotent


def test_list_filters_sort_and_cursor(owner, project, st):
    client = client_for(owner)
    member = add_project_member(project, key="project_member")
    epic = Epic.objects.create(project=project, name="Billing")
    for i in range(6):
        new(
            client,
            project,
            title=f"Task {i}",
            priority=i % 5,
            assigneeId=str(member.id) if i % 2 else None,
            epicId=str(epic.id) if i < 2 else None,
            dueDate=f"2026-10-{10 + i}" if i % 3 else None,
        )
    base = f"/api/v1/projects/{project.id}/tasks"
    page = client.get(f"{base}?limit=4").json()
    assert [t["number"] for t in page["data"]] == [1, 2, 3, 4]
    rest = client.get(f"{base}?limit=4&cursor={page['nextCursor']}").json()
    assert [t["number"] for t in rest["data"]] == [5, 6]
    assert rest["nextCursor"] is None
    assert len(client.get(f"{base}?filter[assignee]={member.id}").json()["data"]) == 3
    assert len(client.get(f"{base}?filter[assignee]=none").json()["data"]) == 3
    assert len(client.get(f"{base}?filter[epic]={epic.id}").json()["data"]) == 2
    assert len(client.get(f"{base}?filter[priority]=1&filter[priority]=2").json()["data"]) == 2
    assert [t["title"] for t in client.get(f"{base}?q=task 3").json()["data"]] == ["Task 3"]
    assert client.get(f"{base}?q=PRJ-2").json()["data"][0]["key"] == "PRJ-2"
    by_priority = [t["priority"] for t in client.get(f"{base}?sort=-priority").json()["data"]]
    assert by_priority == sorted(by_priority, reverse=True)
    due = client.get(f"{base}?sort=dueDate&limit=3").json()
    due2 = client.get(f"{base}?sort=dueDate&limit=3&cursor={due['nextCursor']}").json()
    dates = [t["dueDate"] for t in due["data"] + due2["data"]]
    assert dates[:4] == sorted(d for d in dates if d)  # nulls last
    assert dates[4:] == [None, None]
    assert client.get(f"{base}?sort=nope").status_code == 422
    assert client.get(f"{base}?filter[status]=not-a-uuid").status_code == 422
    assert client.get(f"{base}?filter[priority]=high").status_code == 422
    assert len(client.get(f"{base}?filter[status]={st['todo'].id}").json()["data"]) == 6


def test_bulk_update_delete_restore(owner, project, st):
    client = client_for(owner)
    ids = [new(client, project, title=f"T{i}")["id"] for i in range(3)]
    member = add_project_member(project, key="project_member")
    label = str(project.labels.first().id)
    res = client.post(
        f"/api/v1/projects/{project.id}/tasks/bulk",
        {
            "ids": ids,
            "patch": {
                "statusId": str(st["progress"].id),
                "assigneeId": str(member.id),
                "labelIds": [label],
                "priority": 4,
            },
        },
        format="json",
    )
    assert res.status_code == 200
    assert {t["statusId"] for t in res.json()} == {str(st["progress"].id)}
    assert all(t["labelIds"] == [label] and t["priority"] == 4 and t["version"] == 2 for t in res.json())
    assert (
        client.post(
            f"/api/v1/projects/{project.id}/tasks/bulk", {"ids": ids, "delete": True}, format="json"
        ).status_code
        == 200
    )
    assert Task.objects.filter(pk__in=ids).count() == 0
    back = client.post(f"/api/v1/projects/{project.id}/tasks/bulk", {"ids": ids, "restore": True}, format="json")
    assert all(t["deletedAt"] is None for t in back.json())
    assert client.post(f"/api/v1/projects/{project.id}/tasks/bulk", {"ids": []}, format="json").status_code == 422
    assert (
        client.post(
            f"/api/v1/projects/{project.id}/tasks/bulk", {"ids": ids, "patch": {"title": "x"}}, format="json"
        ).status_code
        == 422
    )
    assert (
        client.post(f"/api/v1/projects/{project.id}/tasks/bulk", {"ids": ids, "patch": {}}, format="json").status_code
        == 422
    )


def test_bulk_respects_per_task_permissions(owner, project):
    member = add_project_member(project, key="project_member")
    theirs = create_task(owner, project, {"title": "Owner's"})
    mine = create_task(member, project, {"title": "Mine"})
    res = client_for(member).post(
        f"/api/v1/projects/{project.id}/tasks/bulk",
        {"ids": [str(theirs.id), str(mine.id)], "patch": {"priority": 4}},
        format="json",
    )
    assert res.status_code == 403
    assert Task.objects.get(pk=mine.pk).priority == 0  # all-or-nothing
    assert (
        client_for(member)
        .post(f"/api/v1/projects/{project.id}/tasks/bulk", {"ids": [str(mine.id)], "delete": True}, format="json")
        .status_code
        == 403
    )


def test_my_tasks_and_workspace_tasks(owner, ws, project):
    member = add_project_member(project, key="project_member")
    hidden = make_project(ws, owner, key="HID")
    create_task(owner, project, {"title": "A", "assigneeId": str(member.id), "dueDate": "2026-10-09"})
    create_task(owner, project, {"title": "B", "assigneeId": str(member.id)})
    create_task(owner, hidden, {"title": "Hidden"})
    c = client_for(member)
    mine = c.get("/api/v1/workspaces/platform/tasks?filter[assignee]=me").json()
    assert [t["title"] for t in mine["data"]] == ["A", "B"]
    assert [t["title"] for t in c.get("/api/v1/me/tasks").json()["data"]] == ["A", "B"]
    # Someone else's tasks, but only in projects I can see.
    theirs = client_for(owner).get(f"/api/v1/workspaces/platform/tasks?filter[assignee]={member.id}").json()
    assert len(theirs["data"]) == 2
    assert c.get("/api/v1/workspaces/platform/tasks?filter[assignee]=nobody").status_code == 422


def test_activity_feeds(owner, ws, project, st):
    client = client_for(owner)
    t = new(client, project, title="Feed")
    client.patch(f"/api/v1/tasks/{t['id']}", {"statusId": str(st["progress"].id), "version": 1}, format="json")
    entries = client.get(f"/api/v1/tasks/{t['id']}/activity").json()
    assert [e["verb"] for e in entries] == ["status_changed", "created"]
    assert entries[0]["data"] == {"from": "Todo", "to": "In progress"}
    assert entries[0]["taskKey"] == "PRJ-1"
    feed = client.get(f"/api/v1/projects/{project.id}/activity?limit=1").json()
    assert len(feed["data"]) == 1
    assert feed["nextCursor"]
    ws_feed = client.get("/api/v1/workspaces/platform/activity").json()
    assert {e["verb"] for e in ws_feed["data"]} == {"created", "status_changed"}
    outsider = add_project_member(make_project(ws, owner, key="OTH"), key="viewer")
    assert client_for(outsider).get("/api/v1/workspaces/platform/activity").json()["data"] == []


def test_cross_workspace_task_isolation(owner, project):
    t = create_task(owner, project, {"title": "Secret"})
    intruder = UserFactory()
    make_workspace(intruder, slug="intruder")
    c = client_for(intruder)
    assert c.get(f"/api/v1/tasks/{t.id}").status_code == 404
    assert c.get("/api/v1/tasks/PRJ-1").status_code == 404
    assert c.patch(f"/api/v1/tasks/{t.id}", {"title": "x", "version": 1}, format="json").status_code == 404
    assert c.delete(f"/api/v1/tasks/{t.id}").status_code == 404
    assert c.get(f"/api/v1/projects/{project.id}/tasks").status_code == 404
    assert c.get("/api/v1/workspaces/platform/tasks/PRJ-1").status_code == 404
    assert (
        c.post(
            f"/api/v1/projects/{project.id}/tasks/bulk", {"ids": [str(t.id)], "delete": True}, format="json"
        ).status_code
        == 404
    )


def test_workspace_member_without_project_gets_403(owner, ws, project):
    from apps.common.testing import add_member

    t = create_task(owner, project, {"title": "Members only"})
    admin = add_member(ws, key="admin")
    res = client_for(admin).get(f"/api/v1/tasks/{t.id}")
    assert res.status_code == 403
    assert res.json()["code"] == "project_membership_required"
