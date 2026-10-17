"""§6–§7 processing: PR/branch/commit links, checks, ordering, caps, suppression, automations, leases, runs."""

import datetime as dt
import threading

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from core.audit.models import AuditLog
from core.common.testing import client_for
from core.notifications.models import Notification
from modules.tracking.integrations import fake_payloads, processor, runner
from modules.tracking.integrations.models import AutomationRule, Integration, Repository, SyncRun, WebhookDelivery
from modules.tracking.integrations.providers.base import (
    Author,
    BranchInfo,
    CheckInfo,
    DevEvent,
    PullRequestInfo,
    RateLimited,
    get_provider,
)
from modules.tracking.integrations.providers.fake import FAKE
from modules.tracking.tasks.models import ExternalLink, TaskStatusHistory
from modules.tracking.tasks.services import create_task, update_task
from modules.tracking.testing import add_project_member

from .conftest import make_integration, track

pytestmark = pytest.mark.django_db


def send(integration, repo, event, key):
    if integration.provider == "github":
        name, payload = fake_payloads.github_payload(repo, integration, event, key)
    else:
        name, payload = fake_payloads.gitlab_payload(repo, event, key)
    return fake_payloads.post(APIClient(), integration, name, payload)


def ctx_for(integration, history=False):
    return processor.Context(integration, get_provider(integration.provider), history=history)


def pr(number=7, title="PRJ-1 Fix", head="prj-1-fix", state="open", updated=None, sha="a" * 40):
    updated = updated or timezone.now()
    return PullRequestInfo(
        number, title, state, head, "main", sha, f"https://github.com/platform-team/web/pull/{number}",
        Author("akim", "Alex Kim", "alex@team.dev"), updated, updated,
        merged_at=updated if state == "merged" else None,
    )  # fmt: skip


@pytest.fixture
def tasks(owner, project):
    return [create_task(owner, project, {"title": f"Task {i}", "assigneeIds": [str(owner.id)]}) for i in range(1, 4)]


def test_pr_lifecycle_links_audit_and_realtime(ws, owner, project, github, web, tasks, monkeypatch):
    events = []
    monkeypatch.setattr("core.realtime.services.publish", lambda t, **kw: events.append((t, kw["data"])))
    monkeypatch.setattr(
        "modules.tracking.integrations.processor.publish", lambda t, **kw: events.append((t, kw["data"])), raising=False
    )
    assert send(github, web, "pr_opened", "PRJ-1").status_code == 202
    link = ExternalLink.objects.get()
    assert (link.task_id, link.state, link.link_source, link.number, link.author_user_id) == (
        tasks[0].pk, "open", "auto", fake_payloads.demo_number("PRJ-1"), None,  # no public email on the PR author
    )  # fmt: skip
    audit = AuditLog.objects.get(action="tracking.task.dev_linked")
    assert (audit.actor_id, audit.actor_kind, audit.actor_ref, audit.actor_name, audit.source) == (
        None, "integration", str(github.id), "GitHub", "webhook",
    )  # fmt: skip
    web.refresh_from_db()
    assert web.open_pr_count == 1
    send(github, web, "checks_failed", "PRJ-1")
    link.refresh_from_db()
    assert link.checks_state == "failing" and link.checks[0]["name"] == "ci / tests"
    task = client_for(owner).get(f"/api/v1/tracking/tasks/{tasks[0].id}").json()
    assert task["dev"]["pr"]["checks"] == "failing" and task["dev"]["prCount"] == 1
    send(github, web, "push", "PRJ-1")
    assert ExternalLink.objects.filter(type="branch", task=tasks[0]).exists()
    assert ExternalLink.objects.get(type="commit", task=tasks[0]).author_user_id == owner.pk  # matched by email
    send(github, web, "pr_merged", "PRJ-1")
    link.refresh_from_db()
    assert link.state == "merged"
    web.refresh_from_db()
    assert web.open_pr_count == 0
    assert AuditLog.objects.filter(action="tracking.task.dev_pr_state").count() == 1
    activity = client_for(owner).get(f"/api/v1/tracking/tasks/{tasks[0].id}/activity").json()
    verbs = [a["verb"] for a in activity]
    assert "dev_pr_merged" in verbs and "dev_linked" in verbs
    entry = next(a for a in activity if a["verb"] == "dev_linked")
    assert entry["actorKind"] == "integration" and entry["actorName"] == "GitHub" and entry["actorId"] is None
    dev_events = [d for t, d in events if t == "tracking.task.changed" and d.get("fields") == ["development"]]
    assert dev_events and all(d["version"] is None for d in dev_events)
    assert WebhookDelivery.objects.filter(status="processed").count() == 4


def test_out_of_order_and_new_sha_clears_checks(github, web, tasks):
    ctx = ctx_for(github)
    now = timezone.now()
    processor.upsert_pr(ctx, web, pr(updated=now))
    processor.update_checks(ctx, web, "a" * 40, [CheckInfo("lint", "running"), CheckInfo("unit", "passing")], False)
    processor.update_checks(ctx, web, "a" * 40, [CheckInfo("lint", "passing")], False)
    link = ExternalLink.objects.get()
    assert [c["name"] for c in link.checks] == ["lint", "unit"] and link.checks_state == "passing"
    processor.upsert_pr(ctx, web, pr(title="PRJ-1 Old title", updated=now - dt.timedelta(minutes=5)))
    link.refresh_from_db()
    assert link.title == "PRJ-1 Fix"  # the late, older delivery is ignored
    processor.update_checks(ctx, web, "b" * 40, [CheckInfo("lint", "failing")], False)
    link.refresh_from_db()
    assert link.checks_state == "passing"  # checks only apply to the current head sha
    processor.upsert_pr(ctx, web, pr(updated=now + dt.timedelta(minutes=1), sha="b" * 40))
    link.refresh_from_db()
    assert link.checks == [] and link.checks_state == "" and link.sha == "b" * 40


def test_title_edits_add_and_remove_auto_links_only(owner, github, web, tasks):
    ctx = ctx_for(github)
    t = timezone.now()
    processor.upsert_pr(ctx, web, pr(title="PRJ-1 and PRJ-2", head="x", updated=t))
    assert set(ExternalLink.objects.values_list("task_id", flat=True)) == {tasks[0].pk, tasks[1].pk}
    ExternalLink.objects.filter(task=tasks[0]).update(link_source="manual")
    processor.upsert_pr(ctx, web, pr(title="PRJ-3 only", head="x", updated=t + dt.timedelta(seconds=1)))
    assert set(ExternalLink.objects.values_list("task_id", flat=True)) == {tasks[0].pk, tasks[2].pk}
    # A suppressed link survives re-delivery and isn't revived; D2 re-link lifts it.
    ExternalLink.objects.filter(task=tasks[2]).update(suppressed=True)
    processor.upsert_pr(ctx, web, pr(title="PRJ-3 only", head="x", updated=t + dt.timedelta(seconds=2)))
    assert ExternalLink.objects.get(task=tasks[2]).suppressed is True
    url = "https://github.com/platform-team/web/pull/214"
    res = client_for(owner).post(f"/api/v1/tracking/tasks/{tasks[2].id}/development/links", {"url": url}, format="json")
    assert res.status_code == 201


def test_archived_and_deleted_projects_and_caps(ws, owner, project, github, web, tasks):
    from modules.tracking.tasks.services import delete_task

    many = [create_task(owner, project, {"title": f"n{i}"}) for i in range(3)]
    delete_task(owner, tasks[1])
    type(project).objects.filter(pk=project.pk).update(status="archived")
    _rule(project, "pr_opened", "in_progress")
    ctx = ctx_for(github)
    processor.upsert_pr(ctx, web, pr(title="PRJ-1 PRJ-2"))
    assert list(ExternalLink.objects.values_list("task_id", flat=True)) == [tasks[0].pk]  # archived: linked
    tasks[0].refresh_from_db()
    assert tasks[0].status.category == "todo"  # …but no automation
    ctx = ctx_for(github)
    monkey = processor.LINK_CAP
    processor.LINK_CAP = 2
    try:
        processor.upsert_pr(ctx, web, pr(number=8, title=" ".join(t.key for t in many)))
    finally:
        processor.LINK_CAP = monkey
    assert ctx.capped and ExternalLink.objects.filter(number=8).count() == 2


def _rule(project, trigger, category):
    status = project.statuses.filter(category=category).order_by("position").first()
    return AutomationRule.objects.create(project=project, trigger=trigger, status=status)


def test_pr_merged_automation_moves_to_done_as_the_integration(ws, owner, project, github, web, tasks):
    sam = add_project_member(project)
    update_task(owner, tasks[0], {"assigneeIds": [str(sam.id)], "version": tasks[0].version})
    done = _rule(project, "pr_merged", "done").status
    ctx = ctx_for(github)
    t = timezone.now()
    processor.upsert_pr(ctx, web, pr(number=1, updated=t))
    processor.upsert_pr(ctx, web, pr(number=2, updated=t))
    processor.upsert_pr(ctx, web, pr(number=1, state="merged", updated=t + dt.timedelta(seconds=1)))
    tasks[0].refresh_from_db()
    assert tasks[0].status_id != done.pk  # PR #2 is still open
    version = tasks[0].version
    processor.upsert_pr(ctx, web, pr(number=2, state="merged", updated=t + dt.timedelta(seconds=2)))
    tasks[0].refresh_from_db()
    assert tasks[0].status_id == done.pk and tasks[0].version == version + 1 and tasks[0].completed_at
    history = TaskStatusHistory.objects.filter(task=tasks[0]).order_by("-at").first()
    assert history.changed_by_id is None
    row = AuditLog.objects.get(action="tracking.task.status_changed", subject_id=tasks[0].pk)
    assert (row.actor_kind, row.actor_ref, row.actor_name, row.source) == (
        "integration",
        str(github.id),
        "GitHub",
        "webhook",
    )
    assert row.data["rule"] == "pr_merged" and row.data["ref"] == "#2"
    note = Notification.objects.get(recipient=sam, kind="status")
    assert note.payload["via"] == "github" and note.actor_id is None
    # Already done: nothing happens; suppressed links never trigger.
    processor.upsert_pr(ctx, web, pr(number=3, state="open", updated=t))
    processor.upsert_pr(ctx, web, pr(number=3, state="merged", updated=t + dt.timedelta(seconds=3)))
    assert AuditLog.objects.filter(action="tracking.task.status_changed", subject_id=tasks[0].pk).count() == 1


def test_pr_opened_only_from_todo_and_rule_off(project, github, web, tasks, owner):
    rule = _rule(project, "pr_opened", "in_progress")
    rule.enabled = False
    rule.save()
    processor.upsert_pr(ctx_for(github), web, pr(number=1))
    tasks[0].refresh_from_db()
    assert tasks[0].status.category == "todo"
    rule.enabled = True
    rule.save()
    processor.upsert_pr(ctx_for(github), web, pr(number=4, title="PRJ-1 again"))
    tasks[0].refresh_from_db()
    assert tasks[0].status_id == rule.status_id
    ExternalLink.objects.update(suppressed=True)
    processor.upsert_pr(ctx_for(github), web, pr(number=5, title="PRJ-2 x"))
    tasks[1].refresh_from_db()
    assert tasks[1].status_id == rule.status_id  # PRJ-2 was todo
    processor.upsert_pr(ctx_for(github), web, pr(number=6, title="PRJ-2 y"))
    assert (
        AuditLog.objects.filter(action="tracking.task.status_changed", subject_id=tasks[1].pk).count() == 1
    )  # not from in_progress


def test_approvals_ahead_by_low_budget_and_gitlab_compare(ws, github, web, tasks):
    ctx = ctx_for(github)
    processor.upsert_pr(ctx, web, pr(number=214, title="PRJ-1 x"))
    FAKE.approvals[214] = 2
    processor.apply(ctx, [DevEvent("review_update", web.external_id, number=214)])
    assert ExternalLink.objects.get(number=214).approvals == 2
    processor.upsert_branch(ctx, web, BranchInfo("prj-42-fix-reflow", "c" * 40, "u"))
    FAKE.low_budget = True
    processor.upsert_branch(ctx, web, BranchInfo("prj-1-x", "d" * 40, "u"))
    assert [c[1:] for c in FAKE.calls if c[1] == "ahead_by"] == []  # no PRJ-42 task here; PRJ-1 skipped (low budget)
    FAKE.low_budget = False
    gl = make_integration(ws, "gitlab")
    repo = track(gl)
    from modules.tracking.integrations.providers import gitlab

    _, payload = fake_payloads.gitlab_payload(repo, "push", "PRJ-2")
    payload["total_commits_count"] = 25
    payload["before"] = "e" * 40
    events = gitlab.normalize("Push Hook", payload)
    processor.apply(ctx_for(gl), events)
    assert [c for c in FAKE.calls if c[1] == "compare"] == [
        ("gitlab", "compare", repo.external_id, "e" * 40, payload["after"])
    ]


def test_gitlab_pipeline_allow_failure_counts_as_passing(ws, project, tasks):
    from modules.tracking.integrations.providers import gitlab

    gl = make_integration(ws, "gitlab")
    repo = track(gl)
    send(gl, repo, "pr_opened", "PRJ-1")
    sha = fake_payloads.demo_sha("PRJ-1")
    events = gitlab.normalize(
        "Pipeline Hook",
        {"object_attributes": {"sha": sha}, "project": {"id": int(repo.external_id)},
         "builds": [{"name": "lint", "status": "failed", "allow_failure": True}, {"name": "unit", "status": "success"},
                    {"name": "deploy", "status": "manual"}]},
    )  # fmt: skip
    processor.apply(ctx_for(gl), events)
    link = ExternalLink.objects.get(type="pull_request")
    assert link.checks_state == "passing" and len(link.checks) == 2


def test_failed_processing_retries_then_fails_and_lease_reclaim(github, web, monkeypatch):
    monkeypatch.setattr(runner, "dispatch_on_commit", lambda: None)
    send(github, web, "pr_opened", "PRJ-1")
    delivery = WebhookDelivery.objects.get()
    boom = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))  # noqa: E731
    monkeypatch.setattr(processor, "apply", boom)
    for _ in range(5):
        ids, token = runner.claim_deliveries()
        runner.process_delivery(ids[0], token)
    delivery.refresh_from_db()
    assert (delivery.status, delivery.attempts, delivery.error) == ("failed", 5, "boom")
    # A stale `processing` lease (crashed worker) is reclaimed after 120 s.
    WebhookDelivery.objects.filter(pk=delivery.pk).update(
        status="processing", attempts=1, locked_at=timezone.now() - dt.timedelta(seconds=121)
    )
    ids, _ = runner.claim_deliveries()
    assert ids == [delivery.pk]
    assert runner.claim_deliveries()[0] == []  # leased now


def test_thread_runner_starts_one_drain_thread(monkeypatch, settings):
    settings.INTEGRATIONS_RUNNER = "thread"
    calls = threading.Event()
    monkeypatch.setattr(runner, "drain", lambda: calls.set() or 0)
    monkeypatch.setattr(runner, "_thread", None)
    before = threading.active_count()
    for _ in range(50):
        runner.dispatch()
    assert calls.wait(2)
    names = [t.name for t in threading.enumerate() if t.name == "lightex-integrations-drain"]
    assert len(names) == 1 and threading.active_count() <= before + 1


def test_backfill_is_quiet_and_sync_runs_automations(ws, owner, project, github, tasks):
    _rule(project, "pr_merged", "done")
    repo = track(github)
    runner.enqueue(github, repo, "backfill")
    run = SyncRun.objects.get()
    assert run.status == "done" and run.stats["requests"] > 0
    assert not AuditLog.objects.filter(action__in=("tracking.task.dev_linked", "tracking.task.status_changed")).exists()
    summary = AuditLog.objects.get(action="tracking.integration.backfilled")
    assert summary.actor_kind == "integration" and summary.data["repository"] == "platform-team/web"
    # An incremental sync that finds a merge missed while webhooks were down moves the task.
    from modules.tracking.integrations.providers import fake as fake_module

    original = fake_module.PRS
    monkeypatched = {"web": [(77, "PRJ-1 Late merge", "merged", "prj-1-late", "akim", 1, [], 0)]}
    fake_module.PRS = monkeypatched
    try:
        processor.upsert_pr(
            ctx_for(github),
            repo,
            pr(number=77, title="PRJ-1 Late merge", updated=timezone.now() - dt.timedelta(minutes=10)),
        )
        repo.refresh_from_db()
        runner.enqueue(github, repo, "sync")
    finally:
        fake_module.PRS = original
    tasks[0].refresh_from_db()
    assert tasks[0].status.category == "done"


def test_budget_partial_rate_limit_and_auth_error(ws, github, monkeypatch):
    repo = track(github)
    monkeypatch.setattr(runner, "REQUEST_BUDGET", 2)
    runner.enqueue(github, repo, "backfill")
    run = SyncRun.objects.get()
    assert run.status == "done" and run.stats["partial"] is True
    assert AuditLog.objects.get(action="tracking.integration.backfilled").data["partial"] is True
    reset = timezone.now() + dt.timedelta(minutes=10)

    def limited(*a, **k):
        raise RateLimited(reset)

    monkeypatch.setattr("modules.tracking.integrations.providers.fake.FakeProvider.pull_requests", limited)
    monkeypatch.setattr(runner, "dispatch_on_commit", lambda: None)
    deferred = runner.enqueue(github, repo, "sync")
    runner.drain()
    deferred.refresh_from_db()
    assert deferred.status == "deferred" and deferred.run_after == reset
    from modules.tracking.integrations.providers.base import AuthError

    def revoked(*a, **k):
        raise AuthError("installation_removed")

    monkeypatch.setattr("modules.tracking.integrations.providers.fake.FakeProvider.pull_requests", revoked)
    SyncRun.objects.filter(pk=deferred.pk).update(run_after=timezone.now())
    runner.drain()
    github.refresh_from_db()
    assert github.status == "error" and github.error_code == "installation_removed"
    assert AuditLog.objects.filter(action="tracking.integration.error").count() == 1
    from modules.tracking.integrations.services import set_integration_error

    set_integration_error(github, "")
    github.refresh_from_db()
    assert github.status == "active" and AuditLog.objects.filter(action="tracking.integration.recovered").exists()


def test_installation_and_repository_events(ws, github, web):
    send_raw = fake_payloads.post
    base = {
        "installation": {"id": 51234567},
        "repository": {"id": 712004001, "full_name": "platform-team/web2", "archived": True},
    }
    send_raw(APIClient(), github, "repository", {"action": "renamed", **base})
    web.refresh_from_db()
    assert web.full_path == "platform-team/web2" and web.archived is True
    send_raw(APIClient(), github, "installation", {"action": "suspend", "installation": {"id": 51234567}})
    github.refresh_from_db()
    assert github.error_code == "installation_suspended"
    send_raw(APIClient(), github, "installation", {"action": "unsuspend", "installation": {"id": 51234567}})
    github.refresh_from_db()
    assert github.status == "active"
    removed = {"action": "removed", "installation": {"id": 51234567}, "repositories_removed": [{"id": 712004001}]}
    send_raw(APIClient(), github, "installation_repositories", removed)
    assert not Repository.objects.exists()
    assert Integration.objects.get().status == "active"
