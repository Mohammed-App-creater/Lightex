"""G1, G7–G11, G13: overview, repository picker, tracked set, scope, sync and disconnect (§5.2, §5.4, §7.9)."""

import datetime as dt

import pytest
from django.utils import timezone

from core.audit.models import AuditLog
from core.common.testing import UserFactory, add_member, client_for, make_project, make_workspace
from modules.tracking.integrations.models import Integration, Repository, SyncRun, WebhookDelivery
from modules.tracking.integrations.providers.fake import FAKE
from modules.tracking.tasks.models import ExternalLink
from modules.tracking.tasks.services import create_task

from .conftest import make_integration, track

pytestmark = pytest.mark.django_db


def put(client, integration, items):
    return client.put(
        f"/api/v1/tracking/integrations/{integration.id}/repositories", {"repositories": items}, format="json"
    )


def test_overview_and_non_manager_filtering(ws, owner, project, github, sam):
    web = track(github)
    infra = track(github, "infra-terraform", "712004188", all_projects=False)
    other = make_project(ws, owner, key="INF")
    infra.projects.add(other)
    body = client_for(owner).get("/api/v1/tracking/workspaces/platform/integrations").json()
    assert [p["provider"] for p in body["providers"]] == ["github", "gitlab"]
    gh = body["integrations"][0]
    assert [r["fullPath"] for r in gh["repositories"]] == ["platform-team/infra-terraform", "platform-team/web"]
    assert gh["manageUrl"].endswith("/installations/51234567")
    assert gh["repositories"][0]["projectIds"] == [str(other.id)]
    # Sam (not on INF, no integration.manage): INF-only repository hidden, no manageUrl, no credentials anywhere.
    mine = client_for(sam).get("/api/v1/tracking/workspaces/platform/integrations").json()["integrations"][0]
    assert [r["id"] for r in mine["repositories"]] == [str(web.id)] and mine["manageUrl"] is None
    detail = client_for(sam).get(f"/api/v1/tracking/integrations/{github.id}")
    assert detail.status_code == 200
    for text in (str(body), detail.content.decode()):
        assert "credentials" not in text and "webhook_secret" not in text and "lx1." not in text
    # Error state: every repository paused.
    Integration.objects.filter(pk=github.pk).update(status="error", error_code="installation_removed")
    gh = client_for(owner).get(f"/api/v1/tracking/integrations/{github.id}").json()
    assert gh["error"]["code"] == "installation_removed" and {r["syncState"] for r in gh["repositories"]} == {"paused"}
    res = client_for(owner).get(f"/api/v1/tracking/integrations/{github.id}/available-repositories")
    assert res.status_code == 409 and res.json()["details"]["code"] == "installation_removed"


def test_stale_integration_gets_a_catchup_on_g1(ws, owner, github):
    track(github)
    Integration.objects.filter(pk=github.pk).update(last_synced_at=timezone.now() - dt.timedelta(hours=2))
    FAKE.deliveries = [{"guid": "lost-1", "installation_id": 51234567, "status": "Invalid"}]
    client_for(owner).get("/api/v1/tracking/workspaces/platform/integrations")
    run = SyncRun.objects.get(kind="catchup")
    assert run.status == "done"
    assert ("github", "redeliver", "lost-1") in FAKE.calls


def test_available_repositories_and_picker_flags(ws, owner, github):
    other = make_integration(ws, "github", account_external_id="51239999", account_login="alexkim")
    track(other, "api", "712004002")
    track(github)
    found = client_for(owner).get(f"/api/v1/tracking/integrations/{github.id}/available-repositories?q=WEB").json()
    assert [r["fullPath"] for r in found] == ["platform-team/web"]
    rows = client_for(owner).get(f"/api/v1/tracking/integrations/{github.id}/available-repositories").json()
    assert [r["fullPath"] for r in rows][:3] == ["alexkim/dotfiles", "alexkim/reflow-bench", "platform-team/api"]
    flags = {r["name"]: (r["tracked"], r["trackedElsewhere"]) for r in rows}
    assert flags["web"] == (True, False) and flags["api"] == (False, True)
    assert sum(1 for c in FAKE.calls if c[1] == "list_repositories") == 1  # cached 60 s
    FAKE.fail.add("list_repositories")
    from django.core.cache import cache

    cache.clear()
    res = client_for(owner).get(f"/api/v1/tracking/integrations/{github.id}/available-repositories")
    assert res.status_code == 502 and res.json()["code"] == "provider_failed"


def test_set_repositories_validation_backfill_and_reattach(ws, owner, project, github):
    client = client_for(owner)
    assert put(client, github, []).json()["details"]["fields"] == {"repositories": "Choose at least one repository."}
    too_many = [{"externalId": str(i)} for i in range(201)]
    assert put(client, github, too_many).status_code == 422
    assert "repositories.0.externalId" in put(client, github, [{"externalId": "nope"}]).json()["details"]["fields"]
    other_ws = make_workspace(UserFactory(), slug="other")
    foreign = make_project(other_ws, other_ws.members.first().user, key="OTH")
    bad = put(client, github, [{"externalId": "712004001", "projectIds": [str(foreign.id)]}])
    assert "repositories.0.projectIds" in bad.json()["details"]["fields"]
    elsewhere = make_integration(ws, "github", account_external_id="51239999", account_login="alexkim")
    track(elsewhere, "api", "712004002")
    assert "repositories.0.externalId" in put(client, github, [{"externalId": "712004002"}]).json()["details"]["fields"]
    # An orphaned link of web (from an earlier disconnect) is re-attached when web is tracked again.
    task = create_task(owner, project, {"title": "Fix reflow"})
    orphan = ExternalLink.objects.create(
        task=task, workspace=ws, provider="github", type="commit", external_id="a" * 40, url="https://x",
        base_url="https://github.com", repo_external_id="712004001", repo_full_path="platform-team/web",
    )  # fmt: skip
    res = put(
        client, github, [{"externalId": "712004001"}, {"externalId": "712004003", "projectIds": [str(project.id)]}]
    )
    assert res.status_code == 200, res.content
    repos = {r["name"]: r for r in res.json()["repositories"]}
    assert repos["board-engine"]["allProjects"] is False and repos["board-engine"]["projectIds"] == [str(project.id)]
    orphan.refresh_from_db()
    assert orphan.repository.name == "web"
    # The inline runner backfilled both repositories (fake fixtures: web has the PRJ PRs).
    assert SyncRun.objects.filter(kind="backfill", status="done").count() == 2
    web = Repository.objects.get(name="web")
    assert web.backfilled_at is not None and web.open_pr_count == 12
    audit = AuditLog.objects.get(action="tracking.integration.repositories_updated")
    assert audit.data == {"added": ["platform-team/web", "platform-team/board-engine"], "removed": []}
    # Removing one keeps its links (repository NULL).
    ExternalLink.objects.create(
        task=task, workspace=ws, provider="github", type="branch", external_id="712004001:prj-1-x", url="https://x",
        repository=web, base_url="https://github.com", repo_external_id="712004001", repo_full_path="platform-team/web",
    )  # fmt: skip
    put(client, github, [{"externalId": "712004003"}])
    assert ExternalLink.objects.filter(repository__isnull=True, repo_full_path="platform-team/web").count() == 2


def test_gitlab_hooks_created_and_deleted_and_failure_rolls_back(ws, owner):
    gl = make_integration(ws, "gitlab")
    client = client_for(owner)
    FAKE.fail.add("create_hook")
    res = put(client, gl, [{"externalId": "442004001"}])
    assert res.status_code == 502 and res.json()["details"]["repository"] == "platform-team/web"
    assert not Repository.objects.exists()
    FAKE.fail.clear()
    assert put(client, gl, [{"externalId": "442004001"}]).status_code == 200
    hook = next(c for c in FAKE.calls if c[1] == "create_hook")
    assert hook[3]["token"] == "gl-secret" and hook[3]["url"].endswith(f"/webhooks/gitlab/{gl.id}")
    assert hook[3]["push_events"] and hook[3]["merge_requests_events"] and hook[3]["pipeline_events"]
    repo = Repository.objects.get()
    assert repo.hook_id
    put(client, gl, [{"externalId": "442004002"}])
    assert ("gitlab", "delete_hook", "442004001", repo.hook_id) in FAKE.calls


def test_scope_repository(ws, owner, project, github):
    repo = track(github)
    url = f"/api/v1/tracking/repositories/{repo.id}"
    res = client_for(owner).patch(url, {"projectIds": [str(project.id)]}, format="json")
    assert res.status_code == 200 and res.json()["allProjects"] is False
    assert AuditLog.objects.get(action="tracking.integration.repository_scoped").data == {
        "repository": "platform-team/web", "projects": ["PRJ"],
    }  # fmt: skip
    assert client_for(owner).patch(url, {"projectIds": []}, format="json").json()["allProjects"] is True
    assert client_for(owner).patch(url, {"projectIds": ["x"]}, format="json").status_code == 422


def test_sync_now_throttle(ws, owner, github):
    track(github)
    client = client_for(owner)
    res = client.post(f"/api/v1/tracking/integrations/{github.id}/sync")
    assert res.status_code == 202 and res.json()["nextSyncAt"] is not None
    again = client.post(f"/api/v1/tracking/integrations/{github.id}/sync")
    assert again.status_code == 429 and again.json()["code"] == "sync_throttled"
    assert int(again["Retry-After"]) > 0 and again.json()["details"]["nextSyncAt"]
    Integration.objects.filter(pk=github.pk).update(status="error", error_code="token_revoked")
    assert client.post(f"/api/v1/tracking/integrations/{github.id}/sync").status_code == 409


def test_sync_one_active_run(github, monkeypatch):
    from modules.tracking.integrations import runner

    monkeypatch.setattr(runner, "dispatch_on_commit", lambda: None)
    repo = track(github)
    first = runner.enqueue(github, repo, "sync")
    assert runner.enqueue(github, repo, "sync").pk == first.pk


def test_disconnect(ws, owner, project, github):
    repo = track(github)
    task = create_task(owner, project, {"title": "x"})
    link = ExternalLink.objects.create(
        task=task, workspace=ws, provider="github", type="pull_request", external_id="712004001#1", url="https://x",
        repository=repo, base_url="https://github.com", repo_external_id="712004001",
        repo_full_path="platform-team/web",
    )  # fmt: skip
    admin = add_member(ws, UserFactory(), "member")
    assert client_for(admin).delete(f"/api/v1/tracking/integrations/{github.id}").status_code == 403
    assert client_for(owner).delete(f"/api/v1/tracking/integrations/{github.id}").status_code == 204
    assert not Integration.objects.exists() and not Repository.objects.exists()
    link.refresh_from_db()
    assert link.repository is None and link.repo_full_path == "platform-team/web"
    assert ("github", "revoke", "51234567") in FAKE.calls
    assert AuditLog.objects.get(action="tracking.integration.disconnected").data["revoked"] is True
    detail = client_for(owner).get(f"/api/v1/tracking/tasks/{task.id}/development").json()
    assert detail["pullRequests"][0]["repository"] is None and detail["pullRequests"][0]["repoFullPath"]


def test_disconnect_marks_work_and_records_failed_revocation(ws, owner, github):
    from modules.tracking.integrations import runner

    track(github)
    WebhookDelivery.objects.create(provider="github", delivery_id="d1", integration=github, event="push")
    run = SyncRun.objects.create(integration=github, kind="sync")
    FAKE.fail.add("revoke")
    original = runner.dispatch_on_commit
    runner.dispatch_on_commit = lambda: None  # look at the intermediate state
    try:
        client_for(owner).delete(f"/api/v1/tracking/integrations/{github.id}")
    finally:
        runner.dispatch_on_commit = original
    assert WebhookDelivery.objects.get().status == "ignored"
    run.refresh_from_db()
    assert (run.status, run.error) == ("failed", "disconnected")
    github.refresh_from_db()
    assert github.status == "disconnecting"
    runner.drain()
    assert not Integration.objects.exists()
    assert AuditLog.objects.get(action="tracking.integration.disconnected").data["revoked"] is False


def test_gitlab_disconnect_revocation_rules(ws, owner):
    from modules.tracking.integrations import runner

    bot = make_integration(ws, "gitlab")
    bot.set_credentials({"token": "t", "bot": True})
    bot.save()
    repo = track(bot, hook_id="77")
    pat = make_integration(ws, "gitlab", account_external_id="9005")
    oauth = make_integration(ws, "gitlab", account_external_id="9006", auth_kind="gitlab_oauth")
    for integration in (bot, pat, oauth):
        client_for(owner).delete(f"/api/v1/tracking/integrations/{integration.id}")
    runner.drain()
    ops = [c[1:] for c in FAKE.calls]
    assert ("delete_hook", repo.external_id, "77") in ops
    assert ops.count(("token_self_revoke",)) == 1 and ops.count(("oauth_revoke",)) == 1
