import datetime as dt

import pytest
from django.utils import timezone

from apps.common.testing import add_project_member, client_for, make_project
from apps.projects.saved_views import clean_rules
from apps.tasks.services import create_task

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


def test_clean_rules_mirrors_client():
    rules = clean_rules(
        [
            {"field": "status", "op": "any", "values": ["a", "b", "a", "bad value!"]},
            {"field": "status", "op": "empty", "values": []},  # status can't be empty
            {"field": "assignee", "op": "is", "values": ["me", "other"]},
            {"field": "due", "op": "empty", "values": ["x"]},
            {"field": "label", "op": "is", "values": []},  # incomplete → dropped
            {"field": "nope", "op": "is", "values": ["x"]},
            "garbage",
        ]
    )
    assert rules == [
        {"field": "status", "op": "any", "values": ["a", "b"]},
        {"field": "assignee", "op": "is", "values": ["me"]},
        {"field": "due", "op": "empty", "values": []},
    ]


def test_saved_view_lifecycle_and_counts(owner, project):
    member = add_project_member(project, key="project_member")
    bug = project.labels.get(name="bug")
    done = project.statuses.get(glyph="done")
    today = timezone.now().date()
    create_task(owner, project, {"title": "Mine bug", "assigneeId": str(owner.id), "labelIds": [str(bug.id)]})
    create_task(owner, project, {"title": "Mine done", "assigneeId": str(owner.id), "statusId": str(done.id)})
    create_task(
        owner,
        project,
        {"title": "Theirs", "assigneeId": str(member.id), "dueDate": (today + dt.timedelta(days=3)).isoformat()},
    )
    create_task(owner, project, {"title": "Nobody", "priority": 3})
    client = client_for(owner)
    payload = {
        "projectId": str(project.id),
        "name": "My open bugs",
        "icon": "user",
        "visibility": "me",
        "layout": "list",
        "filters": [
            {"field": "assignee", "op": "is", "values": ["me"]},
            {"field": "label", "op": "is", "values": [str(bug.id)]},
            {"field": "status", "op": "not", "values": [str(done.id)]},
        ],
        "pinned": True,
    }
    res = client.post("/api/v1/workspaces/platform/views", payload, format="json")
    assert res.status_code == 201
    view = res.json()
    assert view["count"] == 1
    assert view["pinned"] is True
    assert set(view) == {
        "id", "workspaceId", "projectId", "ownerId", "name", "icon", "visibility", "layout", "filters", "pinned",
        "position", "count", "createdAt",
    }  # fmt: skip
    assert client.post("/api/v1/workspaces/platform/views", payload, format="json").status_code == 422  # same name
    due = client.post(
        "/api/v1/workspaces/platform/views",
        {
            **payload,
            "name": "Due this week",
            "filters": [{"field": "due", "op": "before", "values": ["week"]}],
            "visibility": "project",
        },
        format="json",
    ).json()
    assert due["count"] == 1
    unassigned = client.post(
        "/api/v1/workspaces/platform/views",
        {
            **payload,
            "name": "Unassigned",
            "filters": [{"field": "assignee", "op": "empty", "values": []}],
            "pinned": False,
        },
        format="json",
    ).json()
    assert unassigned["count"] == 1
    # The member sees only the shared view, and can pin it but not edit it.
    mine = client_for(member).get("/api/v1/workspaces/platform/views").json()
    assert [v["name"] for v in mine] == ["Due this week"]
    assert (
        client_for(member).patch(f"/api/v1/views/{due['id']}", {"pinned": True}, format="json").json()["pinned"] is True
    )
    assert client_for(member).patch(f"/api/v1/views/{due['id']}", {"name": "Hijack"}, format="json").status_code == 403
    assert client_for(member).delete(f"/api/v1/views/{due['id']}").status_code == 403
    assert client_for(member).patch(f"/api/v1/views/{view['id']}", {"pinned": True}, format="json").status_code == 404
    # Owner edits, reorders pins, deletes.
    edited = client.patch(
        f"/api/v1/views/{view['id']}",
        {"name": "Bugs", "icon": "bolt", "filters": [{"field": "priority", "op": "empty", "values": []}]},
        format="json",
    )
    assert edited.json()["count"] == 3
    assert client.patch(f"/api/v1/views/{view['id']}", {"filters": []}, format="json").status_code == 422
    client.patch(f"/api/v1/views/{due['id']}", {"pinned": True}, format="json")
    ordered = client.put(
        "/api/v1/workspaces/platform/views/order", {"ids": [due["id"], view["id"]]}, format="json"
    ).json()
    assert [v["name"] for v in ordered if v["pinned"]] == ["Due this week", "Bugs"]
    assert client.put("/api/v1/workspaces/platform/views/order", {"ids": "x"}, format="json").status_code == 422
    assert client.delete(f"/api/v1/views/{unassigned['id']}").status_code == 204
    assert len(client.get("/api/v1/workspaces/platform/views").json()) == 2


def test_view_permissions(owner, ws, project):
    viewer = add_project_member(project, key="viewer")
    filters = [{"field": "priority", "op": "is", "values": ["3"]}]
    c = client_for(viewer)
    shared = {"projectId": str(project.id), "name": "Shared", "visibility": "project", "filters": filters}
    assert c.post("/api/v1/workspaces/platform/views", shared, format="json").status_code == 403
    private = c.post("/api/v1/workspaces/platform/views", {**shared, "visibility": "me"}, format="json")
    assert private.status_code == 201
    assert c.patch(f"/api/v1/views/{private.json()['id']}", {"visibility": "project"}, format="json").status_code == 403
    hidden = make_project(ws, owner, key="HID")
    assert (
        c.post(
            "/api/v1/workspaces/platform/views",
            {**shared, "projectId": str(hidden.id), "visibility": "me"},
            format="json",
        ).status_code
        == 403
    )
    assert (
        c.post("/api/v1/workspaces/platform/views", {**shared, "projectId": "nope"}, format="json").status_code == 422
    )
    assert (
        c.post(
            "/api/v1/workspaces/platform/views", {**shared, "visibility": "me", "name": ""}, format="json"
        ).status_code
        == 422
    )
    assert (
        c.post(
            "/api/v1/workspaces/platform/views",
            {**shared, "visibility": "me", "name": "X", "filters": "x"},
            format="json",
        ).status_code
        == 422
    )
    sprint_filter = [
        {"field": "due", "op": "after", "values": ["sprint"]},
        {"field": "epic", "op": "not", "values": ["00000000-0000-0000-0000-000000000000"]},
    ]
    v = c.post(
        "/api/v1/workspaces/platform/views",
        {**shared, "visibility": "me", "name": "Odd", "filters": sprint_filter},
        format="json",
    )
    assert v.json()["count"] == 0  # no active sprint → "sprint" resolves to nothing
