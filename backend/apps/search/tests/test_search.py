import pytest

from apps.common.richtext import plain_doc
from apps.common.testing import UserFactory, add_member, add_project_member, client_for, make_project, make_workspace
from apps.tasks.services import create_task, delete_task

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ")


def test_workspace_search_tasks_projects_people(owner, ws, project):
    create_task(owner, project, {"title": "Fix flaky board reflow on column resize"})
    create_task(
        owner, project, {"title": "Stripe webhook retries", "description": plain_doc("Retry with exponential backoff")}
    )
    gone = create_task(owner, project, {"title": "Board legacy cleanup"})
    delete_task(owner, gone)
    client = client_for(owner)
    res = client.get("/api/v1/workspaces/platform/search?q=boa&filter[type]=task").json()
    assert [r["task"]["title"] for r in res] == [
        "Fix flaky board reflow on column resize"
    ]  # prefix match, deleted excluded
    assert res[0]["projectKey"] == "PRJ"
    assert res[0]["status"]["glyph"] == "todo"
    stemmed = client.get("/api/v1/workspaces/platform/search?q=retrying&filter[type]=task").json()
    assert [r["task"]["key"] for r in stemmed] == ["PRJ-2"]
    by_desc = client.get("/api/v1/workspaces/platform/search?q=exponential&filter[type]=task").json()
    assert [r["task"]["key"] for r in by_desc] == ["PRJ-2"]
    by_key = client.get("/api/v1/workspaces/platform/search?q=prj-2").json()
    assert by_key[0]["type"] == "task"
    assert by_key[0]["task"]["key"] == "PRJ-2"
    projects = client.get("/api/v1/workspaces/platform/search?q=platform&filter[type]=project").json()
    assert projects[0]["project"]["key"] == "PRJ"
    assert "my_permissions" in projects[0]["project"]
    people = client.get("/api/v1/workspaces/platform/search?q=alex&filter[type]=user").json()
    assert people[0]["user"]["id"] == str(owner.id)
    assert people[0]["roleName"] == "Owner"
    everything = client.get("/api/v1/workspaces/platform/search?q=").json()
    assert {r["type"] for r in everything} == {"task", "project", "user"}
    assert client.get("/api/v1/workspaces/platform/search?q=x&filter[type]=bogus").status_code == 422


def test_search_never_leaks_other_projects_or_workspaces(owner, ws, project):
    hidden = make_project(ws, owner, key="HID", name="Hidden")
    create_task(owner, hidden, {"title": "Secret roadmap"})
    other_owner = UserFactory()
    other_ws = make_workspace(other_owner, slug="other")
    create_task(other_owner, make_project(other_ws, other_owner, key="OTH"), {"title": "Secret elsewhere"})
    member = add_project_member(project, key="viewer")
    client = client_for(member)
    assert client.get("/api/v1/workspaces/platform/search?q=secret").json() == [] or all(
        r["type"] == "user" for r in client.get("/api/v1/workspaces/platform/search?q=secret").json()
    )
    assert client.get("/api/v1/search?q=secret").json()["data"] == []
    assert client.get("/api/v1/workspaces/other/search?q=secret").status_code == 404
    admin = add_member(ws, key="admin")  # workspace admin, no project membership
    assert client_for(admin).get("/api/v1/search?q=secret").json()["data"] == []


def test_global_search_tasks_and_comments(owner, project):
    task = create_task(owner, project, {"title": "Okta SSO"})
    client = client_for(owner)
    client.post(
        f"/api/v1/tasks/{task.id}/comments", {"body": plain_doc("SAML sandbox is ready for testing")}, format="json"
    )
    res = client.get("/api/v1/search?q=sandbox").json()["data"]
    assert [r["type"] for r in res] == ["comment"]
    assert res[0]["taskKey"] == "PRJ-1"
    assert "SAML sandbox" in res[0]["comment"]["excerpt"]
    tasks = client.get("/api/v1/search?q=okta&type=task").json()["data"]
    assert [r["task"]["key"] for r in tasks] == ["PRJ-1"]
    assert client.get("/api/v1/search?q=okta&type=comment").json()["data"] == []
    assert client.get("/api/v1/search?q=a").status_code == 422
    assert client.get("/api/v1/search?q=okta&type=user").status_code == 422
    assert client.get("/api/v1/search?q=!!").json()["data"] == []
