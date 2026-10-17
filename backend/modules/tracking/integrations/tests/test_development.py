"""D1–D4, A1–A2 and the additive payloads: Task.dev, Project.devEnabled, activity fields (§5.6–§5.8, §8.4)."""

import datetime as dt

import pytest
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from core.audit.models import AuditLog
from core.common.testing import add_member, add_project_member, client_for, make_project
from core.realtime.protocol import matches
from modules.tracking.integrations import processor, runner
from modules.tracking.integrations.models import AutomationRule, Integration
from modules.tracking.integrations.providers.base import get_provider
from modules.tracking.integrations.providers.fake import FAKE
from modules.tracking.tasks.models import ExternalLink
from modules.tracking.tasks.services import create_task

from .conftest import make_integration, track
from .test_processing import pr

pytestmark = pytest.mark.django_db
BASE = "https://github.com/platform-team/web"


@pytest.fixture
def task(owner, project):
    return create_task(owner, project, {"title": "Fix flaky board reflow on column resize"})


def dev(client, task):
    return client.get(f"/api/v1/tracking/tasks/{task.key}/development")


def test_d1_shape_ordering_and_suggestion(ws, owner, project, github, web, task):
    ctx = processor.Context(github, get_provider("github"))
    t = timezone.now()
    for number, state, minutes in ((1, "closed", 1), (2, "merged", 2), (3, "open", 30), (4, "draft", 3)):
        processor.upsert_pr(
            ctx, web, pr(number, f"{task.key} change {number}", state=state, updated=t - dt.timedelta(minutes=minutes))
        )
    body = dev(client_for(owner), task).json()
    assert body["taskKey"] == task.key and body["enabled"] is True
    assert body["suggestedBranch"] == "prj-1-fix-flaky-board-reflow"
    assert [p["number"] for p in body["pullRequests"]] == [4, 3, 2, 1]
    assert body["pullRequests"][0]["ref"] == "#4" and body["repositories"][0]["canCreateBranch"] is True
    assert body["commitTotal"] == 0 and body["syncedAt"]
    assert FAKE.calls == []  # D1 never calls the provider


def test_d2_link_forms_and_errors(ws, owner, project, github, web, task):
    client = client_for(owner)
    url = f"/api/v1/tracking/tasks/{task.id}/development/links"
    cases = [
        (f"{BASE}/pull/214/files", "pull_request"),
        (f"{BASE}/commit/a3f9c21", "commit"),
        (f"{BASE}/tree/prj-42-fix-reflow/", "branch"),
    ]
    for link_url, kind in cases:
        res = client.post(url, {"url": link_url}, format="json")
        assert res.status_code == 201, res.content
        assert res.json()["kind"] == kind and res.json()["linkSource"] == "manual"
    assert client.post(url, {"url": f"{BASE}/pull/214"}, format="json").status_code == 200  # already visible
    errors = {
        "https://github.com/someone/else/pull/1": "Connect this repository first.",
        f"{BASE}/pull/999": "GitHub can’t find this pull request.",
        "https://example.com/nothing": "Paste a pull request, merge request, commit or branch link.",
    }
    for link_url, message in errors.items():
        assert client.post(url, {"url": link_url}, format="json").json()["details"]["fields"]["url"] == message
    other = make_project(ws, owner, key="INF")
    web.all_projects = False
    web.save()
    web.projects.add(other)
    res = client.post(url, {"url": f"{BASE}/pull/209"}, format="json")
    assert res.json()["details"]["fields"]["url"] == "This repository isn’t used by PRJ."
    FAKE.fail.add("resolve_url")
    web.projects.add(project)
    assert client.post(url, {"url": f"{BASE}/pull/209"}, format="json").status_code == 502
    assert AuditLog.objects.filter(action="tracking.task.dev_linked").count() == 2  # PR + branch, not the commit


def test_gitlab_mr_url(ws, owner, project, task):
    gl = make_integration(ws, "gitlab")
    track(gl, "web", "442004001")
    res = client_for(owner).post(
        f"/api/v1/tracking/tasks/{task.id}/development/links",
        {"url": "https://gitlab.com/platform-team/web/-/merge_requests/214"},
        format="json",
    )
    assert res.status_code == 201 and res.json()["ref"] == "!214"


def test_d3_unlink_manual_vs_auto(ws, owner, project, github, web, task):
    client = client_for(owner)
    processor.upsert_pr(processor.Context(github, get_provider("github")), web, pr(5, f"{task.key} x"))
    auto = ExternalLink.objects.get()
    manual = client.post(
        f"/api/v1/tracking/tasks/{task.id}/development/links", {"url": f"{BASE}/pull/214"}, format="json"
    )
    assert client.delete(f"/api/v1/tracking/tasks/{task.id}/development/links/{auto.id}").status_code == 204
    auto.refresh_from_db()
    assert auto.suppressed is True
    assert client.delete(f"/api/v1/tracking/tasks/{task.id}/development/links/{manual.json()['id']}").status_code == 204
    assert not ExternalLink.objects.filter(pk=manual.json()["id"]).exists()
    other = create_task(owner, project, {"title": "other"})
    assert client.delete(f"/api/v1/tracking/tasks/{other.id}/development/links/{auto.id}").status_code == 404
    assert AuditLog.objects.filter(action="tracking.task.dev_unlinked").count() == 2


def test_d4_create_branch(ws, owner, project, github, web, task):
    client = client_for(owner)
    url = f"/api/v1/tracking/tasks/{task.id}/development/branches"
    rule = AutomationRule.objects.create(
        project=project, trigger="branch_created", status=project.statuses.filter(category="in_progress").first()
    )
    for name in ("a..b", "-x", "a" * 81):
        assert (
            "name"
            in client.post(url, {"repositoryId": str(web.id), "name": name}, format="json").json()["details"]["fields"]
        )
    res = client.post(url, {"repositoryId": str(web.id), "name": "feature/no-key-here"}, format="json")
    assert res.status_code == 201 and res.json()["aheadBy"] == 0 and res.json()["linkSource"] == "created"
    assert ("github", "create_branch", web.external_id, "feature/no-key-here", "main") in FAKE.calls
    task.refresh_from_db()
    assert task.status_id == rule.status_id  # branch_created automation, as the integration
    assert AuditLog.objects.get(action="tracking.task.status_changed", task=task).actor_kind == "integration"
    assert AuditLog.objects.get(action="tracking.task.dev_branch_created").actor_id == owner.id
    dup = client.post(url, {"repositoryId": str(web.id), "name": "prj-42-fix-reflow"}, format="json")
    assert dup.status_code == 409 and dup.json()["message"] == "That branch already exists in platform-team/web."
    assert (
        "name"
        in client.post(url, {"repositoryId": str(web.id), "name": "protected/x"}, format="json").json()["details"][
            "fields"
        ]
    )
    with override_settings(GITHUB_BRANCH_CREATION=False):
        res = client.post(url, {"repositoryId": str(web.id), "name": "prj-1-y"}, format="json")
        assert "repositoryId" in res.json()["details"]["fields"]
    web.archived = True
    web.save()
    assert client.post(url, {"repositoryId": str(web.id), "name": "prj-1-z"}, format="json").status_code == 422


def test_development_permissions_viewer_and_archived(ws, owner, project, github, web, task):
    viewer = add_project_member(project, key="viewer")
    assert dev(client_for(viewer), task).status_code == 200
    res = client_for(viewer).post(
        f"/api/v1/tracking/tasks/{task.id}/development/links", {"url": f"{BASE}/pull/214"}, format="json"
    )
    assert res.status_code == 403 and res.json()["details"]["permission"] == "tracking.development.link"
    client_for(owner).post(f"/api/v1/tracking/projects/{project.id}/archive")
    res = client_for(owner).post(
        f"/api/v1/tracking/tasks/{task.id}/development/links", {"url": f"{BASE}/pull/214"}, format="json"
    )
    assert res.status_code == 403


def test_task_dev_headline_and_dev_enabled(ws, owner, project, github, web, task):
    client = client_for(owner)
    assert client.get(f"/api/v1/tracking/tasks/{task.id}").json()["dev"] is None
    assert client.get(f"/api/v1/tracking/projects/{project.id}").json()["devEnabled"] is True
    ctx = processor.Context(github, get_provider("github"))
    now = timezone.now()
    processor.upsert_pr(ctx, web, pr(1, f"{task.key} a", state="merged", updated=now - dt.timedelta(days=1)))
    head = client.get(f"/api/v1/tracking/tasks/{task.id}").json()["dev"]
    assert head["pr"]["number"] == 1 and head["pr"]["state"] == "merged"
    processor.upsert_pr(ctx, web, pr(2, f"{task.key} b", updated=now))
    assert client.get(f"/api/v1/tracking/tasks/{task.id}").json()["dev"]["pr"]["number"] == 2  # open beats merged
    ExternalLink.objects.filter(number=2).update(state="closed")
    ExternalLink.objects.filter(number=1).update(merged_at=now - dt.timedelta(days=15))
    body = client.get(f"/api/v1/tracking/tasks/{task.id}").json()["dev"]
    assert body["pr"] is None and body["prCount"] == 2  # merged > 14 days ago and closed never headline
    Integration.objects.filter(pk=github.pk).update(status="error")
    assert client.get(f"/api/v1/tracking/projects/{project.id}").json()["devEnabled"] is False


def test_board_query_count_is_constant(ws, owner, project, github, web):
    client = client_for(owner)
    ctx = processor.Context(github, get_provider("github"))

    def count():
        client.get(f"/api/v1/tracking/projects/{project.id}/board")
        with CaptureQueriesContext(connection) as c:
            client.get(f"/api/v1/tracking/projects/{project.id}/board")
        return len(c.captured_queries)

    create_task(owner, project, {"title": "zero"})
    empty = count()
    first = create_task(owner, project, {"title": "one"})
    processor.upsert_pr(ctx, web, pr(1, first.key))
    one = count()
    for i in range(50):
        t = create_task(owner, project, {"title": f"t{i}"})
        processor.upsert_pr(ctx, web, pr(100 + i, t.key))
    assert empty == one == count()


def test_automation_rules(ws, owner, project):
    client = client_for(owner)
    url = f"/api/v1/tracking/projects/{project.id}/dev-automation"
    assert client.get(url).json() == [
        {"trigger": "branch_created", "enabled": False, "statusId": None},
        {"trigger": "pr_opened", "enabled": False, "statusId": None},
        {"trigger": "pr_merged", "enabled": False, "statusId": None},
    ]
    review = project.statuses.filter(category="in_progress").first()
    done = project.statuses.filter(category="done").first()
    body = [
        {"trigger": "branch_created", "enabled": False, "statusId": None},
        {"trigger": "pr_opened", "enabled": True, "statusId": str(review.id)},
        {"trigger": "pr_merged", "enabled": True, "statusId": str(review.id)},
    ]
    assert client.put(url, body, format="json").json()["details"]["fields"] == {
        "rules.2.statusId": "Pick a Done status."
    }
    body[1]["statusId"] = None
    assert client.put(url, body, format="json").json()["details"]["fields"]["rules.1.statusId"] == "Choose a status."
    body[1]["statusId"], body[2]["statusId"] = str(review.id), str(done.id)
    res = client.put(url, body, format="json")
    assert res.status_code == 200 and res.json()[2] == {
        "trigger": "pr_merged",
        "enabled": True,
        "statusId": str(done.id),
    }
    assert AuditLog.objects.get(action="tracking.project.dev_automation_updated").changes
    sam = add_project_member(project)
    assert client_for(sam).put(url, body, format="json").status_code == 403


def test_integration_changed_reaches_members_without_project_access(ws, owner, github, monkeypatch):
    events = []
    monkeypatch.setattr("modules.tracking.integrations.services.publish", lambda t, **kw: events.append((t, kw)))
    member = add_member(ws, None, "member")
    track(github)
    client_for(owner).post(f"/api/v1/tracking/integrations/{github.id}/sync")
    client_for(owner).delete(f"/api/v1/tracking/integrations/{github.id}")
    runner.drain()
    sent = [kw for t, kw in events if t == "tracking.integration.changed"]
    assert sent[-1]["data"] == {"integrationId": str(github.id), "op": "disconnected"}
    event = {"type": "tracking.integration.changed", "ws": str(ws.id), "projectId": None}
    assert matches(event, str(ws.id), frozenset(), str(member.id))
    assert not matches({**event, "type": "tracking.task.changed"}, str(ws.id), frozenset(), str(member.id))
