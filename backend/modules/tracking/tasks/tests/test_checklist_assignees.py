"""Multiple assignees and task checklists (docs/tracking/checklist-assignees.md)."""

import pytest

from core.audit.models import AuditLog
from core.common import fractional
from core.common.testing import client_for
from core.events.models import DomainEvent
from modules.tracking.tasks.models import ChecklistItem, Task
from modules.tracking.tasks.services import create_task
from modules.tracking.testing import add_project_member, make_project

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def sam(project):
    return add_project_member(project, key="project_member")


@pytest.fixture
def riley(project):
    return add_project_member(project, key="project_member")


def task_url(task_id) -> str:
    return f"/api/v1/tracking/tasks/{task_id}"


def checklist_url(task_id, item_id=None) -> str:
    return f"{task_url(task_id)}/checklist" + (f"/{item_id}" if item_id else "")


def assigned_events(task) -> list[str]:
    return list(
        DomainEvent.objects.filter(type="tracking.task.assigned", payload__taskId=str(task.pk))
        .order_by("created_at")
        .values_list("payload__assigneeId", flat=True)
    )


# ───────────────────────── assignees ─────────────────────────


def test_create_with_several_assignees_keeps_order_and_notifies_each(owner, project, sam, riley):
    res = client_for(owner).post(
        f"/api/v1/tracking/projects/{project.id}/tasks",
        {"title": "Pair on it", "assigneeIds": [str(riley.id), str(sam.id), str(riley.id)]},
        format="json",
    )
    assert res.status_code == 201, res.content
    assert res.json()["assigneeIds"] == [str(riley.id), str(sam.id)]
    task = Task.objects.get(pk=res.json()["id"])
    assert sorted(assigned_events(task)) == sorted([str(riley.id), str(sam.id)])


def test_patch_replaces_set_audits_each_person_and_notifies_only_new(owner, project, sam, riley):
    task = create_task(owner, project, {"title": "T", "assigneeIds": [str(sam.id)]})
    c = client_for(owner)
    res = c.patch(task_url(task.pk), {"assigneeIds": [str(sam.id), str(riley.id)], "version": 1}, format="json")
    assert res.status_code == 200, res.content
    assert res.json()["assigneeIds"] == [str(sam.id), str(riley.id)]
    assert assigned_events(task) == [str(sam.id), str(riley.id)]  # create, then only the new person

    res = c.patch(task_url(task.pk), {"assigneeIds": [str(riley.id)], "version": 2}, format="json")
    assert res.json()["assigneeIds"] == [str(riley.id)]
    row = AuditLog.objects.filter(action="tracking.task.assigned").order_by("-created_at").first()
    assert row.changes == [{"field": "Assignee", "kind": "person", "before": str(sam.id), "after": None}]
    assert row.data["assignee"] == riley.name

    res = c.patch(task_url(task.pk), {"assigneeIds": [], "version": 3}, format="json")
    assert res.json()["assigneeIds"] == []
    assert AuditLog.objects.filter(action="tracking.task.assigned").order_by("-created_at").first().data == {
        "assignee": "nobody",
        "assigneeCount": 0,
    }


def test_reorder_alone_is_not_a_reassignment(owner, project, sam, riley):
    task = create_task(owner, project, {"title": "T", "assigneeIds": [str(sam.id), str(riley.id)]})
    before = AuditLog.objects.filter(action="tracking.task.assigned").count()
    res = client_for(owner).patch(
        task_url(task.pk), {"assigneeIds": [str(riley.id), str(sam.id)], "version": 1}, format="json"
    )
    assert res.status_code == 200
    assert AuditLog.objects.filter(action="tracking.task.assigned").count() == before


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ("nope", "Send a list of ids"),
        (["not-a-uuid"], "Send a list of ids"),
        ("outsider", "Assign people on this project"),
        ("eleven", "Assign up to 10 people"),
    ],
)
def test_assignee_validation(owner, project, value, message):
    from core.common.testing import UserFactory

    if value == "outsider":
        value = [str(UserFactory().id)]
    elif value == "eleven":
        value = [str(add_project_member(project, key="project_member").id) for _ in range(11)]
    task = create_task(owner, project, {"title": "T"})
    res = client_for(owner).patch(task_url(task.pk), {"assigneeIds": value, "version": 1}, format="json")
    assert res.status_code == 422
    assert res.json()["details"]["fields"]["assigneeIds"] == message


def test_old_single_assignee_field_is_rejected(owner, project, sam):
    task = create_task(owner, project, {"title": "T"})
    res = client_for(owner).patch(task_url(task.pk), {"assigneeId": str(sam.id), "version": 1}, format="json")
    assert res.status_code == 422
    assert "assigneeId" in res.json()["details"]["fields"]


def test_any_assignee_can_edit_own_task(owner, project, sam, riley):
    task = create_task(owner, project, {"title": "T", "assigneeIds": [str(sam.id), str(riley.id)]})
    for i, who in enumerate((sam, riley)):
        res = client_for(who).patch(task_url(task.pk), {"title": f"Edited {i}", "version": 1 + i}, format="json")
        assert res.status_code == 200, res.content
    stranger = add_project_member(project, key="project_member")
    assert (
        client_for(stranger).patch(task_url(task.pk), {"title": "No", "version": 3}, format="json").status_code == 403
    )


def test_filters_match_any_assignee(owner, project, sam, riley):
    both = create_task(owner, project, {"title": "Both", "assigneeIds": [str(sam.id), str(riley.id)]})
    only_riley = create_task(owner, project, {"title": "Riley", "assigneeIds": [str(riley.id)]})
    nobody = create_task(owner, project, {"title": "Nobody"})
    base = f"/api/v1/tracking/projects/{project.id}/tasks"
    c = client_for(owner)

    def keys(query):
        return sorted(t["key"] for t in c.get(f"{base}?{query}").json()["data"])

    assert keys(f"filter[assignee]={sam.id}") == [both.key]
    assert keys(f"filter[assignee]={riley.id}") == sorted([both.key, only_riley.key])
    assert keys("filter[assignee]=none") == [nobody.key]
    assert keys(f"filter[assignee]={sam.id}&filter[assignee]=none") == sorted([both.key, nobody.key])
    mine = client_for(riley).get("/api/v1/tracking/me/tasks").json()["data"]
    assert sorted(t["key"] for t in mine) == sorted([both.key, only_riley.key])


def test_bulk_assignees_replace(owner, project, sam, riley):
    a = create_task(owner, project, {"title": "A", "assigneeIds": [str(sam.id)]})
    b = create_task(owner, project, {"title": "B"})
    res = client_for(owner).post(
        f"/api/v1/tracking/projects/{project.id}/tasks/bulk",
        {"ids": [str(a.id), str(b.id)], "patch": {"assigneeIds": [str(riley.id)]}},
        format="json",
    )
    assert res.status_code == 200, res.content
    assert [t["assigneeIds"] for t in res.json()] == [[str(riley.id)], [str(riley.id)]]


# ───────────────────────── checklist ─────────────────────────


def test_checklist_add_toggle_rename_reorder_delete(owner, project):
    task = create_task(owner, project, {"title": "T"})
    c = client_for(owner)
    first = c.post(checklist_url(task.pk), {"text": "  Write the migration  "}, format="json")
    assert first.status_code == 201, first.content
    one = first.json()
    assert one["text"] == "Write the migration"
    assert one["done"] is False and one["doneAt"] is None and one["createdById"] == str(owner.id)
    two = c.post(checklist_url(task.pk), {"text": "Ship it"}, format="json").json()
    assert two["position"] > one["position"]

    done = c.patch(checklist_url(task.pk, one["id"]), {"done": True}, format="json").json()
    assert done["done"] is True and done["doneById"] == str(owner.id) and done["doneAt"]
    detail = c.get(task_url(task.pk)).json()
    assert [i["text"] for i in detail["checklist"]] == ["Write the migration", "Ship it"]
    assert (detail["checklistCount"], detail["checklistDoneCount"]) == (2, 1)
    assert detail["version"] == 1  # checklist writes don't bump the task

    top = fractional.key_between(None, one["position"])
    c.patch(checklist_url(task.pk, two["id"]), {"position": top, "text": "Ship it today"}, format="json")
    detail = c.get(task_url(task.pk)).json()
    assert [i["text"] for i in detail["checklist"]] == ["Ship it today", "Write the migration"]

    undone = c.patch(checklist_url(task.pk, one["id"]), {"done": False}, format="json").json()
    assert undone["doneAt"] is None and undone["doneById"] is None
    assert c.delete(checklist_url(task.pk, two["id"])).status_code == 204
    listed = c.get(f"/api/v1/tracking/projects/{project.id}/tasks").json()["data"][0]
    assert (listed["checklistCount"], listed["checklistDoneCount"]) == (1, 0)
    ops = list(
        AuditLog.objects.filter(action="tracking.task.checklist_updated")
        .order_by("created_at")
        .values_list("data__op", flat=True)
    )
    assert ops == ["added", "added", "checked", "renamed", "unchecked", "removed"]


def test_checklist_validation_and_errors(owner, project):
    task = create_task(owner, project, {"title": "T"})
    c = client_for(owner)
    assert c.post(checklist_url(task.pk), {"text": "  "}, format="json").json()["details"]["fields"] == {
        "text": "Write what needs doing"
    }
    assert c.post(checklist_url(task.pk), {"text": "x" * 501}, format="json").status_code == 422
    assert c.post(checklist_url(task.pk), {"text": "a", "position": "!!"}, format="json").status_code == 422
    item = c.post(checklist_url(task.pk), {"text": "a"}, format="json").json()
    assert c.patch(checklist_url(task.pk, item["id"]), {"done": "yes"}, format="json").status_code == 422
    assert c.patch(checklist_url(task.pk, item["id"]), {"color": "red"}, format="json").status_code == 422
    other = create_task(owner, project, {"title": "Other"})
    assert c.patch(checklist_url(other.pk, item["id"]), {"done": True}, format="json").status_code == 404


def test_checklist_limit(owner, project):
    task = create_task(owner, project, {"title": "T"})
    ChecklistItem.objects.bulk_create([ChecklistItem(task=task, text=f"{i}", position=f"a{i:03d}") for i in range(100)])
    res = client_for(owner).post(checklist_url(task.pk), {"text": "one more"}, format="json")
    assert res.status_code == 409
    assert res.json()["code"] == "checklist_limit"


def test_checklist_follows_task_edit_rights(owner, project, sam):
    mine = create_task(owner, project, {"title": "Sam's", "assigneeIds": [str(sam.id)]})
    theirs = create_task(owner, project, {"title": "Not Sam's"})
    c = client_for(sam)
    assert c.post(checklist_url(mine.pk), {"text": "ok"}, format="json").status_code == 201
    res = c.post(checklist_url(theirs.pk), {"text": "no"}, format="json")
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "tracking.task.edit_any"


def test_checklist_on_deleted_task_conflicts(owner, project):
    task = create_task(owner, project, {"title": "T"})
    item = client_for(owner).post(checklist_url(task.pk), {"text": "a"}, format="json").json()
    Task.objects.filter(pk=task.pk).update(deleted_at=task.created_at)
    res = client_for(owner).patch(checklist_url(task.pk, item["id"]), {"done": True}, format="json")
    assert res.status_code == 409
    assert res.json()["code"] == "task_deleted"
