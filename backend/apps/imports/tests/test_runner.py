"""Board 40 execution (§5): I6 start, the runner (IMPORT_RUNNER="inline"), lease and recovery, cancel and failure,
the error report (I8), the notification, audit and activity, and retention."""

import datetime as dt
from urllib.parse import unquote

import pytest
from django.core import mail
from django.core.management import call_command
from django.db import OperationalError, connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.audit.models import AuditLog
from apps.collaboration.storage import get_storage
from apps.common.testing import client_for
from apps.imports import runner, services
from apps.imports.models import ImportJob, ImportRow
from apps.notifications.models import Notification
from apps.planning.models import Epic, Sprint
from apps.projects.models import CustomField, CustomFieldOption, Label
from apps.tasks.models import Task, TaskDependency, TaskFieldValue, TaskStatusHistory

from .fixtures import JIRA, SAMPLE, analyzed, mapped_sample, sample_text, save_mapping, start

pytestmark = pytest.mark.django_db


def _tasks(job_id):
    ids = ImportRow.objects.filter(job_id=job_id, outcome="task").values_list("task_id", flat=True)
    return {t.key: t for t in Task.objects.filter(pk__in=ids).select_related("status", "assignee", "epic", "sprint")}


# ───────────────────────── the sample ─────────────────────────


def test_the_sample_imports_44_tasks(world):
    active = Sprint.objects.create(
        project=world.project, name="Sprint 15", number=15, start_date="2026-10-19", end_date="2026-11-01",
        state="active",
    )  # fmt: skip
    client = world.client()
    job = mapped_sample(world)
    res = start(client, job)
    assert res.status_code == 202
    body = res.json()
    assert body["status"] == "completed"  # inline runner: the whole import ran inside the request
    assert body["progress"] == {
        "phase": "finishing", "total": 48, "processed": 48, "imported": 44, "epics": 0, "skipped": 4, "warnings": 0,
        "recent": body["progress"]["recent"],
    }  # fmt: skip
    assert len(body["progress"]["recent"]) == 10 and body["progress"]["recent"][-1]["row"] == 49
    result = body["result"]
    assert result == {
        "imported": 44, "epics": 0, "skipped": 4, "warnings": 0, "firstKey": "PRJ-61", "lastKey": "PRJ-104",
        "created": {"labels": 1, "epics": 0, "options": 0}, "hasErrorReport": True, "issueCount": 4,
        "issues": [
            {"row": 8, "severity": "skip", "field": "title", "reason": "Missing title", "value": ""},
            {"row": 20, "severity": "skip", "field": "dueDate", "reason": "Invalid due date", "value": "next week"},
            {"row": 27, "severity": "skip", "field": "estimate", "reason": "Estimate is not a number", "value": "XL"},
            {"row": 42, "severity": "skip", "field": "title", "reason": "Missing title", "value": ""},
        ],
    }  # fmt: skip
    assert body["error"] is None and body["startedAt"] and body["finishedAt"]
    finished = dt.datetime.fromisoformat(body["finishedAt"])
    assert dt.datetime.fromisoformat(body["expiresAt"]) - finished == dt.timedelta(days=30)

    tasks = _tasks(job["id"])
    assert sorted(t.number for t in tasks.values()) == list(range(61, 105))
    world.project.refresh_from_db()
    assert world.project.task_seq == 104
    first = tasks["PRJ-61"]
    assert (first.title, first.status.name, first.assignee, first.priority, first.estimate) == (
        "Fix login redirect loop", "Todo", world.alex, 3, 3,
    )  # fmt: skip
    assert first.due_date == dt.date(2026, 10, 8) and first.reporter == world.alex and first.version == 1
    assert first.description == {
        "type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Repro in Safari 17"}]}]
    }  # fmt: skip
    assert {lb.name for lb in tasks["PRJ-63"].labels.all()} == {"frontend", "perf"}
    assert tasks["PRJ-64"].status.name == "Done" and tasks["PRJ-64"].completed_at is not None
    assert tasks["PRJ-64"].assignee is None  # Chris Ortiz → Leave unassigned
    assert tasks["PRJ-65"].status.name == "In review"
    assert all(t.sprint is None for t in tasks.values())  # backlog, not the active sprint (§9 #27)
    assert not active.scope_changes.exists()
    # File order is kept within each column.
    for status in world.project.statuses.all():
        column = sorted((t for t in tasks.values() if t.status_id == status.pk), key=lambda t: t.position)
        assert [t.number for t in column] == sorted(t.number for t in column)
    assert TaskStatusHistory.objects.filter(task__in=tasks.values(), from_status=None).count() == 44
    assert Label.objects.filter(project=world.project, name="api").count() == 1
    hits = client.get(f"/api/v1/projects/{world.project.id}/tasks", {"q": "cheatsheet"}).json()["data"]
    assert sorted(t["key"] for t in hits) == ["PRJ-68", "PRJ-96"]  # row 10 and its follow-up (row 40)
    # Nothing per task: no assignment notifications, no emails.
    assert not Notification.objects.exclude(type="import").exists()
    assert mail.outbox == []


def test_audit_activity_and_notification(world):
    client = world.client()
    job = mapped_sample(world)
    res = client.post(f"/api/v1/imports/{job['id']}/start", HTTP_X_REQUEST_ID="req_import_test_01")
    assert res.status_code == 202
    rows = AuditLog.objects.filter(source="import")
    assert rows.filter(action="task.imported").count() == 44
    assert rows.filter(action="project.import_started").count() == 1
    assert rows.filter(action="project.import_completed").count() == 1
    assert rows.filter(action="label.created", target="api").count() == 1
    assert set(rows.values_list("request_id", flat=True)) == {"req_import_test_01"}
    assert set(rows.values_list("actor_id", flat=True)) == {world.alex.id}
    imported = rows.filter(action="task.imported", task_key="PRJ-61").get()
    assert imported.changes == [
        {"field": "Title", "kind": "text", "before": None, "after": "Fix login redirect loop"},
        {"field": "Status", "kind": "status", "before": None, "after": "todo"},
    ]
    assert imported.data == {"importId": job["id"], "row": 2, "fileName": "tasks-export.csv"}
    started = rows.get(action="project.import_started")
    assert started.data == {
        "importId": job["id"], "fileName": "tasks-export.csv", "source": "csv", "preset": "generic", "rows": 48
    }  # fmt: skip
    completed = rows.get(action="project.import_completed")
    assert completed.data == {
        "importId": job["id"], "fileName": "tasks-export.csv", "source": "csv", "status": "completed", "imported": 44,
        "epics": 0, "skipped": 4, "warnings": 0, "firstKey": "PRJ-61", "lastKey": "PRJ-104",
    }  # fmt: skip
    # One entry in the project feed, the task's own feed starts with "imported".
    feed = client.get(f"/api/v1/projects/{world.project.id}/activity", {"limit": 100}).json()["data"]
    assert [e["verb"] for e in feed].count("imported") == 1
    entry = next(e for e in feed if e["verb"] == "imported")
    assert entry["data"]["imported"] == 44 and entry["data"]["fileName"] == "tasks-export.csv"
    task = Task.objects.get(project=world.project, key="PRJ-61")
    assert [e["verb"] for e in client.get(f"/api/v1/tasks/{task.id}/activity").json()] == ["imported"]
    ws_feed = client.get("/api/v1/workspaces/platform/activity").json()["data"]
    assert [e["verb"] for e in ws_feed].count("imported") == 1
    audit = client.get("/api/v1/workspaces/platform/audit", {"filter[action]": "created", "limit": 100}).json()
    assert any(r["action"] == "task.imported" and r["source"] == "import" for r in audit["data"])
    # The notification: one system row to the creator.
    notes = list(Notification.objects.filter(type="import"))
    assert len(notes) == 1
    note = notes[0]
    assert note.recipient == world.alex and note.actor_id is None and note.task_id is None
    assert note.payload == {
        "importId": job["id"], "projectKey": "PRJ", "imported": 44, "skipped": 4, "importStatus": "completed"
    }  # fmt: skip
    inbox = client.get("/api/v1/notifications").json()["data"]
    assert inbox[0]["type"] == "import" and inbox[0]["taskId"] is None


def test_error_report(world):
    client = world.client()
    job = mapped_sample(world)
    assert client.get(f"/api/v1/imports/{job['id']}/error-report").status_code == 404  # not terminal yet
    start(client, job)
    res = client.get(f"/api/v1/imports/{job['id']}/error-report")
    assert res.status_code == 200
    body = res.json()
    day = timezone.now().date().isoformat()
    assert body["fileName"] == f"import-errors-prj-{day}.csv"
    url = unquote(body["url"])
    assert "type=text/csv; charset=utf-8" in url and "attachment;" in url and "expires=60" in url
    rec = ImportJob.objects.get(pk=job["id"])
    data = get_storage().read_prefix(rec.report_key, 10**6).decode("utf-8")
    assert data.startswith("﻿") and data.endswith("\r\n")
    lines = data[1:].split("\r\n")
    assert lines[0] == '"Row","Outcome","Reason","Value","Title","Description","Status","Assignee","Priority",' + (
        '"Estimate","Due","Tags"'
    )
    assert lines[1] == '"8","Skipped","Missing title","","","See incident 112","blocked","Riley Chen","High","3",' + (
        '"2026-10-14","backend"'
    )
    assert [line.split(",")[0] for line in lines[1:-1]] == ['"8"', '"20"', '"27"', '"42"']


def test_no_error_report_without_issues(world):
    client = world.client()
    job = analyzed(client, world.project, b"Title\nOne\nTwo\n")
    assert start(client, job).json()["result"]["hasErrorReport"] is False
    res = client.get(f"/api/v1/imports/{job['id']}/error-report")
    assert res.status_code == 404 and res.json()["message"] == "This import has no error report."


def test_formula_cells_are_neutralised_in_the_report(world):
    client = world.client()
    job = analyzed(client, world.project, b"Title,=Due\n=cmd|' /C calc'!A0,next week\nOk,2026-10-08\n")
    assert start(client, job).json()["status"] == "completed"
    rec = ImportJob.objects.get(pk=job["id"])
    data = get_storage().read_prefix(rec.report_key, 10**6).decode("utf-8")
    assert data.split("\r\n")[:2] == [
        '﻿"Row","Outcome","Reason","Value","Title","\'=Due"',
        '"2","Skipped","Invalid due date","next week","\'=cmd|\' /C calc\'!A0","next week"',
    ]
    titles = list(Task.objects.filter(project=world.project).values_list("title", flat=True))
    assert titles == ["Ok"]


# ───────────────────────── the Jira export ─────────────────────────


def test_the_jira_export(world):
    client = world.client()
    job = analyzed(client, world.project, JIRA, source="jira")
    body = start(client, job).json()
    assert body["status"] == "completed"
    assert body["result"]["imported"] == 4 and body["result"]["epics"] == 1 and body["result"]["skipped"] == 1
    assert body["result"]["created"] == {"labels": 2, "epics": 1, "options": 0}
    epic = Epic.objects.get(project=world.project, name="Checkout redesign")
    assert (epic.start_date, epic.due_date) == (dt.date(2026, 10, 1), dt.date(2026, 10, 30))
    tasks = {t.title: t for t in _tasks(job["id"]).values()}
    drawer = tasks["Cart drawer"]
    assert drawer.epic == epic and drawer.estimate == 3 and drawer.time_estimate_minutes == 480
    assert (drawer.start_date, drawer.due_date) == (dt.date(2026, 10, 5), dt.date(2026, 10, 14))
    assert drawer.sprint == world.sprint and drawer.assignee == world.jordan and drawer.priority == 2
    assert {lb.name for lb in drawer.labels.all()} == {"frontend", "ux"}
    animation = tasks["Cart drawer animation"]
    assert animation.parent == drawer and animation.assignee == world.jordan
    assert animation.sprint == world.sprint and animation.epic == epic and animation.time_estimate_minutes == 120
    bug = tasks["Price rounding bug"]
    assert bug.status.name == "Done" and bug.priority == 4 and bug.assignee == world.sam and bug.epic == epic
    assert bug.type == "bug"
    retry = tasks["Payment retry"]
    assert retry.status.name == "In review" and retry.assignee is None and retry.sprint is None
    assert {lb.name for lb in retry.labels.all()} == {"backend", "api"}
    assert TaskDependency.objects.filter(blocker=bug, blocked=retry).count() == 1
    assert ImportRow.objects.get(job_id=job["id"], row=2).epic == epic
    assert body["result"]["issues"] == [
        {"row": 7, "severity": "skip", "field": "title", "reason": "Missing title", "value": ""},
        {"row": 6, "severity": "warning", "field": "sprint",
         "reason": "No sprint named “Sprint 99” · added to the backlog", "value": "Sprint 99"},
    ]  # fmt: skip
    assert set(Label.objects.filter(project=world.project).values_list("name", flat=True)) >= {"ux", "api"}
    assert AuditLog.objects.filter(action="epic.created", source="import").count() == 1


def test_epic_names_and_references_to_existing_tasks(world):
    from apps.tasks.services import create_task

    existing = create_task(world.alex, world.project, {"title": "Existing", "sprintId": str(world.sprint.id)})
    sub = create_task(world.alex, world.project, {"title": "Sub", "parentId": str(existing.id)})
    data = (
        "Title,Epic,Parent,Blocked by,Blocks,ID\n"
        f"Alpha,Growth,{existing.key},,,A\n"
        f"Beta,,{sub.key},A,,B\n"
        f"Gamma,,NOPE-1,{existing.key} B,A,C\n"
        "Delta,,,X-9,,D\n"
    ).encode()
    client = world.client()
    job = analyzed(client, world.project, data)
    assert job["validation"]["creates"]["epics"] == ["Growth"]
    start(client, job)
    tasks = {t.title: t for t in _tasks(job["id"]).values()}
    assert tasks["Alpha"].parent == existing and tasks["Alpha"].sprint == world.sprint
    assert tasks["Alpha"].epic.name == "Growth"
    assert tasks["Beta"].parent is None
    deps = set(TaskDependency.objects.values_list("blocker__title", "blocked__title"))
    assert deps == {("Alpha", "Beta"), ("Existing", "Gamma"), ("Beta", "Gamma")}
    reasons = {
        (r.row, i["reason"]) for r in ImportRow.objects.filter(job_id=job["id"]) for i in r.issues
    }  # fmt: skip
    assert (3, "Parent is a sub-task · imported as a top-level task") in reasons
    assert (4, "Parent “NOPE-1” not found · imported as a top-level task") in reasons
    assert (5, "“X-9” not found · dependency skipped") in reasons
    assert (4, "Would create a loop · dependency skipped") in reasons  # Gamma blocks Alpha: A → B → C → A


def test_dependency_loops_are_skipped_with_a_warning(world):
    data = b"Title,ID,Blocked by\nA,1,2\nB,2,1\n"
    client = world.client()
    job = analyzed(client, world.project, data)
    body = start(client, job).json()
    assert TaskDependency.objects.count() == 1
    assert body["result"]["warnings"] == 1
    assert body["result"]["issues"][0]["reason"] == "Would create a loop · dependency skipped"


def test_epic_rows_without_epic_manage_mapped_as_feature(world):
    client = world.client(world.sam)
    job = analyzed(client, world.project, JIRA)
    job = save_mapping(client, job, types={"epic": "feature"}).json()
    body = start(client, job).json()
    assert body["status"] == "completed" and body["result"]["epics"] == 0 and body["result"]["imported"] == 5
    warning = [i for i in body["result"]["issues"] if i["field"] == "epic"]
    assert warning == []  # WEB-1 is now a task row; its children reference it as their parent
    assert not Epic.objects.filter(project=world.project).exists()


def test_custom_fields_of_every_type(world, custom_member):
    from apps.projects.custom_fields import create_field

    alex = world.alex
    text = create_field(alex, world.project, {"name": "Found in", "type": "text"})
    number = create_field(alex, world.project, {"name": "Cost", "type": "number"})
    date = create_field(alex, world.project, {"name": "Reported", "type": "date"})
    select = create_field(
        alex,
        world.project,
        {"name": "Browser", "type": "select", "options": [{"name": "Chrome", "color": "var(--low)"}]},
    )
    person = create_field(alex, world.project, {"name": "Reviewer", "type": "user"})
    data = (
        b"Title,Found in,Cost,Reported,Browser,Reviewer\n"
        b'One,v1.2,"1,240",2026-10-01,chrome,Riley Chen\n'
        b"Two,,12.5,,Arc,Nobody\n"
        b"Three,,abc,,,\n"
        b"Four,,,soon,,\n"
    )
    client = world.client()
    job = analyzed(client, world.project, data)
    assert [c.get("customFieldId") for c in job["mapping"]["columns"][1:]] == [
        str(f.id) for f in (text, number, date, select, person)
    ]
    assert job["validation"]["creates"]["options"] == [{"customFieldId": str(select.id), "names": ["Arc"]}]
    body = start(client, job).json()
    assert body["result"]["created"]["options"] == 1 and body["result"]["skipped"] == 2
    reasons = [i["reason"] for i in body["result"]["issues"]]
    assert reasons == ["Cost: enter a number from 0 to 1,000,000,000", "Reported: invalid date"]
    tasks = {t.title: t for t in _tasks(job["id"]).values()}
    values = {(v.task.title, v.field.name): v for v in TaskFieldValue.objects.select_related("task", "field")}
    assert values[("One", "Found in")].text == "v1.2"
    assert str(values[("One", "Cost")].number) == "1240.00"
    assert values[("One", "Reported")].date == dt.date(2026, 10, 1)
    assert values[("One", "Browser")].option.name == "Chrome"
    assert values[("One", "Reviewer")].user == world.riley
    assert str(values[("Two", "Cost")].number) == "12.50"
    assert values[("Two", "Browser")].option.name == "Arc"
    assert ("Two", "Reviewer") not in values
    assert set(tasks) == {"One", "Two"}
    assert CustomFieldOption.objects.filter(field=select).count() == 2
    assert AuditLog.objects.filter(action="project.custom_field_updated", source="import").count() == 1
    # Without field.manage an unknown option is a warning and stays empty.
    client = world.client(world.sam)
    job = analyzed(client, world.project, b"Title,Browser\nFive,Edge\n")
    assert job["validation"]["creates"]["options"] == []
    body = start(client, job).json()
    assert body["result"]["issues"][0]["reason"] == "Browser: no option “Edge” · left empty"
    assert not CustomFieldOption.objects.filter(name="Edge").exists()
    assert CustomField.objects.filter(project=world.project).count() == 5


def test_constant_query_count_per_batch(world, settings):
    """§8.1: a batch writes each table with one statement, so 50 and 200 rows cost the same number of queries."""
    settings.IMPORT_BATCH_SIZE = 500
    counts = []
    for rows in (50, 200):
        client = world.client()
        job = analyzed(client, world.project, sample_text(rows).encode())
        job = save_mapping(client, job, statuses={"blocked": str(world.status("Todo").id)}).json()
        rec = ImportJob.objects.get(pk=job["id"])
        services.start.__wrapped__ if hasattr(services.start, "__wrapped__") else None
        token = None
        # Start without running, then run the phases by hand around the rows batch.
        original = services.dispatch
        services.dispatch = lambda job_id: None
        try:
            start(client, job)
        finally:
            services.dispatch = original
        token = runner.take_lease(rec.pk)
        ctx = runner.Context(job_id=str(rec.pk), token=token, parsed=None, plan=None)
        assert runner._load(ctx)
        assert runner._step(ctx)  # preparing
        with CaptureQueriesContext(connection) as queries:
            assert runner._step(ctx)  # the rows batch
        counts.append(len(queries))
        while runner._step(ctx):
            pass
        assert ImportJob.objects.get(pk=rec.pk).status == "completed"
    assert counts[0] == counts[1], counts


# ───────────────────────── idempotency, lease and recovery ─────────────────────────


def _crash_in_batch(monkeypatch, n: int, exc: Exception, times: int = 10**6):
    real = runner._rows
    calls = {"n": 0, "raised": 0}

    def flaky(ctx, job):
        calls["n"] += 1
        if calls["n"] == n and calls["raised"] < times:
            calls["raised"] += 1
            calls["n"] -= 1
            raise exc
        return real(ctx, job)

    monkeypatch.setattr(runner, "_rows", flaky)
    return calls


def test_crash_after_a_committed_batch_then_retry_resumes_without_duplicates(world, settings, monkeypatch):
    settings.IMPORT_BATCH_SIZE = 10
    client = world.client()
    job = mapped_sample(world)
    _crash_in_batch(monkeypatch, 2, RuntimeError("boom"), times=1)
    body = start(client, job).json()
    assert body["status"] == "failed"
    assert body["error"] == {
        "code": "import_failed",
        "message": "Something went wrong after 9 tasks. They were kept. Retry to import the rest.",
    }
    assert body["progress"]["processed"] == 10 and body["result"]["imported"] == 9
    assert Task.objects.filter(project=world.project, number__gt=60).count() == 9
    assert Notification.objects.get(type="import").payload["importStatus"] == "failed"
    # Retry: resumes at the cursor with the same numbers; nothing is inserted twice.
    body = start(client, job).json()
    assert body["status"] == "completed" and body["error"] is None
    assert body["result"]["imported"] == 44
    numbers = sorted(Task.objects.filter(project=world.project).values_list("number", flat=True))
    assert numbers == list(range(61, 105))
    assert ImportRow.objects.filter(job_id=job["id"]).count() == 48
    assert AuditLog.objects.filter(action="project.import_started").count() == 1
    assert AuditLog.objects.filter(action="task.imported").count() == 44


def test_database_errors_retry_the_batch(world, settings, monkeypatch):
    settings.IMPORT_BATCH_SIZE = 10
    _crash_in_batch(monkeypatch, 2, OperationalError("connection reset"), times=2)
    body = start(world.client(), mapped_sample(world)).json()
    assert body["status"] == "completed" and body["result"]["imported"] == 44


def test_database_errors_give_up_after_the_retries(world, settings, monkeypatch):
    settings.IMPORT_BATCH_SIZE = 10
    _crash_in_batch(monkeypatch, 2, OperationalError("connection reset"))
    body = start(world.client(), mapped_sample(world)).json()
    assert body["status"] == "failed" and body["error"]["code"] == "import_failed"


def _queued(world, monkeypatch):
    """A started job whose runner never ran (dispatch swallowed)."""
    real = services.dispatch
    services.dispatch = lambda job_id: None
    try:
        job = mapped_sample(world)
        body = start(world.client(), job).json()
    finally:
        services.dispatch = real
    assert body["status"] == "queued" and body["progress"]["phase"] == "preparing"
    return ImportJob.objects.get(pk=job["id"])


def test_the_lease_admits_one_runner(world, monkeypatch):
    rec = _queued(world, monkeypatch)
    first = runner.take_lease(rec.pk)
    assert first is not None
    assert runner.take_lease(rec.pk) is None  # a second delivery exits
    runner.run(str(rec.pk))  # a duplicate runner does nothing
    rec.refresh_from_db()
    assert rec.status == "running" and rec.imported == 0 and rec.lease_token == first


def test_a_lost_lease_stops_the_runner(world, monkeypatch):
    rec = _queued(world, monkeypatch)
    token = runner.take_lease(rec.pk)
    ctx = runner.Context(job_id=str(rec.pk), token=token, parsed=None, plan=None)
    assert runner._load(ctx)
    ImportJob.objects.filter(pk=rec.pk).update(lease_token=None)
    with pytest.raises(runner.LeaseLost):
        runner._step(ctx)


def test_stale_jobs_are_redispatched_by_the_poll(world, monkeypatch):
    rec = _queued(world, monkeypatch)
    client = world.client()
    assert client.get(f"/api/v1/imports/{rec.pk}").json()["status"] == "queued"  # queued < 30 s: left alone
    ImportJob.objects.filter(pk=rec.pk).update(updated_at=timezone.now() - dt.timedelta(seconds=31))
    assert client.get(f"/api/v1/imports/{rec.pk}").json()["status"] == "completed"


def test_running_jobs_with_a_stale_heartbeat_are_resumed(world, monkeypatch, settings):
    settings.IMPORT_BATCH_SIZE = 10
    rec = _queued(world, monkeypatch)
    token = runner.take_lease(rec.pk)
    ctx = runner.Context(job_id=str(rec.pk), token=token, parsed=None, plan=None)
    runner._load(ctx)
    runner._step(ctx)  # preparing
    runner._step(ctx)  # one batch, then the runner "dies"
    client = world.client()
    assert client.get(f"/api/v1/imports/{rec.pk}").json()["status"] == "running"  # heartbeat is fresh
    ImportJob.objects.filter(pk=rec.pk).update(heartbeat_at=timezone.now() - dt.timedelta(seconds=121))
    call_command("resume_imports")
    rec.refresh_from_db()
    assert rec.status == "completed" and rec.imported == 44
    assert sorted(Task.objects.filter(project=world.project).values_list("number", flat=True)) == list(range(61, 105))


def test_thread_and_celery_dispatch(world, settings, monkeypatch):
    calls = []
    monkeypatch.setattr(runner, "run", lambda job_id, **kw: calls.append(("run", job_id, kw)))
    settings.IMPORT_RUNNER = "auto"
    settings.CELERY_TASK_ALWAYS_EAGER = True
    assert services.runner_mode() == "thread"
    settings.CELERY_TASK_ALWAYS_EAGER = False
    assert services.runner_mode() == "celery"
    from apps.imports import tasks as celery_tasks

    sent = []
    monkeypatch.setattr(celery_tasks.run_import, "delay", lambda job_id: sent.append(job_id))
    services.dispatch("abc")
    assert sent == ["abc"]
    settings.IMPORT_RUNNER = "thread"
    monkeypatch.setattr(runner.connection, "close", lambda: None)
    import threading

    started = []
    monkeypatch.setattr(threading.Thread, "start", lambda self: started.append(self) or self.run())
    services.dispatch("xyz")
    assert started and started[0].daemon
    assert calls == [("run", "xyz", {})]


def test_celery_task_retries_then_fails(world, monkeypatch):
    from apps.imports.tasks import run_import

    rec = _queued(world, monkeypatch)

    def broken(job_id, **kw):
        raise OperationalError("down")

    monkeypatch.setattr(runner, "run", broken)
    with pytest.raises(Exception):  # noqa: B017 - Celery's Retry in eager mode
        run_import.apply(args=[str(rec.pk)], throw=True)
    run_import.push_request(retries=3)
    try:
        run_import.run(str(rec.pk))
    finally:
        run_import.pop_request()
    rec.refresh_from_db()
    assert rec.status == "failed" and rec.error_code == "import_failed"


def test_raise_db_errors_releases_the_lease(world, monkeypatch):
    rec = _queued(world, monkeypatch)
    monkeypatch.setattr(runner, "_prepare", lambda ctx, job: (_ for _ in ()).throw(OperationalError("x")))
    with pytest.raises(OperationalError):
        runner.run(str(rec.pk), raise_db_errors=True)
    rec.refresh_from_db()
    assert rec.status == "running" and rec.heartbeat_at is None  # the next delivery can take the lease


# ───────────────────────── cancel and failure ─────────────────────────


def test_cancel_a_queued_job(world, monkeypatch):
    rec = _queued(world, monkeypatch)
    body = world.client().post(f"/api/v1/imports/{rec.pk}/cancel").json()
    assert body["status"] == "canceled" and body["result"]["imported"] == 0
    assert runner.take_lease(rec.pk) is None  # the runner exits on its lease check
    assert not Notification.objects.filter(type="import").exists()


def test_cancel_while_running_keeps_imported_tasks_and_links(world, settings, monkeypatch):
    settings.IMPORT_BATCH_SIZE = 3
    data = b"Title,ID,Blocked by\nA,1,\nB,2,1\nC,3,2\nD,4,3\nE,5,4\n"
    client = world.client()
    job = analyzed(client, world.project, data)
    real = runner._rows

    def then_cancel(ctx, job_rec):
        real(ctx, job_rec)
        res = client.post(f"/api/v1/imports/{job_rec.pk}/cancel")
        assert res.json()["cancelRequested"] is True and res.json()["status"] == "running"
        ImportJob.objects.filter(pk=job_rec.pk).update(cancel_requested=True)
        job_rec.cancel_requested = True

    monkeypatch.setattr(runner, "_rows", then_cancel)
    body = start(client, job).json()
    assert body["status"] == "canceled" and body["result"]["imported"] == 3
    assert body["progress"]["processed"] == 3
    assert sorted(Task.objects.filter(project=world.project).values_list("title", flat=True)) == ["A", "B", "C"]
    assert set(TaskDependency.objects.values_list("blocker__title", "blocked__title")) == {("A", "B"), ("B", "C")}
    assert Notification.objects.get(type="import").payload["importStatus"] == "canceled"
    assert AuditLog.objects.get(action="project.import_completed").data["status"] == "canceled"
    res = client.post(f"/api/v1/imports/{job['id']}/start")
    assert res.status_code == 409 and res.json()["message"] == "This import has finished."


def test_project_archived_mid_run(world, settings, monkeypatch):
    settings.IMPORT_BATCH_SIZE = 10
    real = runner._rows

    def then_archive(ctx, job_rec):
        real(ctx, job_rec)
        type(world.project).objects.filter(pk=world.project.pk).update(status="archived")

    monkeypatch.setattr(runner, "_rows", then_archive)
    body = start(world.client(), mapped_sample(world)).json()
    assert body["status"] == "failed"
    assert body["error"] == {
        "code": "project_unavailable",
        "message": "The project was archived during the import. 9 tasks were imported.",
    }


def test_creator_demoted_mid_run(world, settings, monkeypatch):
    settings.IMPORT_BATCH_SIZE = 10
    real = runner._rows

    def then_demote(ctx, job_rec):
        real(ctx, job_rec)
        world.project.members.filter(user=world.alex).update(role=world.ws.roles.get(system_key="viewer"))

    monkeypatch.setattr(runner, "_rows", then_demote)
    body = start(world.client(), mapped_sample(world)).json()
    assert body["status"] == "failed"
    assert body["error"] == {
        "code": "permission_lost",
        "message": "You no longer have permission to import into PRJ. 9 tasks were imported before it stopped.",
    }


def test_storage_object_gone_fails_and_cannot_be_retried(world, monkeypatch):
    rec = _queued(world, monkeypatch)
    get_storage().delete(rec.parsed_key)
    services._parsed_cache.clear()
    services.dispatch(rec.pk)
    rec.refresh_from_db()
    assert (rec.status, rec.error_code) == ("failed", "file_missing")
    assert rec.error_message == "The uploaded file is gone. Start a new import."
    res = world.client().post(f"/api/v1/imports/{rec.pk}/start")
    assert res.status_code == 409 and res.json()["message"] == "The uploaded file is gone. Start a new import."
    # Giving up the retry.
    assert world.client().post(f"/api/v1/imports/{rec.pk}/cancel").json()["status"] == "canceled"


def test_one_active_import_per_project(world, monkeypatch):
    rec = _queued(world, monkeypatch)
    client = world.client()
    other = mapped_sample(world)
    res = start(client, other)
    assert res.status_code == 409 and res.json()["code"] == "import_in_progress"
    assert res.json()["details"] == {"jobId": str(rec.pk)}
    # Calling start again on the active job is idempotent.
    monkeypatch.setattr(services, "dispatch", lambda job_id: None)
    again = client.post(f"/api/v1/imports/{rec.pk}/start")
    assert again.status_code == 202 and again.json()["status"] == "queued"


def test_start_refuses_blockers_and_non_creators(world):
    client = world.client()
    job = analyzed(client, world.project, SAMPLE)
    res = start(client, job)
    assert res.status_code == 422
    assert res.json()["details"]["fields"] == {"mapping": "Map 1 more status"}
    assert res.json()["details"]["blockers"][0]["code"] == "status_unmapped"
    job = mapped_sample(world)
    res = start(world.client(world.riley), job)
    assert res.status_code == 403 and res.json()["message"] == "Only the person who started this import can change it."


def test_a_status_deleted_and_a_member_removed_after_planning(world, settings, monkeypatch):
    settings.IMPORT_BATCH_SIZE = 10
    from apps.projects.models import ProjectMember, Status

    qa = Status.objects.create(project=world.project, name="QA", category="in_progress", glyph="review", position=9)
    data = b"Title,Status,Assignee\nOne,QA,Riley Chen\nTwo,QA,Riley Chen\n"
    client = world.client()
    job = analyzed(client, world.project, data)
    assert job["validation"]["values"]["statuses"][0]["target"] == str(qa.id)
    real = runner._prepare

    def then_change(ctx, job_rec):
        real(ctx, job_rec)
        qa.delete()
        ProjectMember.objects.filter(project=world.project, user=world.riley).delete()

    monkeypatch.setattr(runner, "_prepare", then_change)
    body = start(client, job).json()
    assert body["status"] == "completed" and body["result"]["warnings"] == 4
    reasons = {i["reason"] for i in body["result"]["issues"]}
    assert reasons == {"Status “QA” was deleted · used Todo", "Assignee left the project · left unassigned"}
    assert {t.status.name for t in _tasks(job["id"]).values()} == {"Todo"}


def test_descriptions_become_plain_rich_text(world):
    data = b'Title,Description\nOne,"line 1\nline 2\n\npara 2 **not bold** <b>x</b>"\n'
    client = world.client()
    start(client, analyzed(client, world.project, data))
    task = Task.objects.get(project=world.project, title="One")
    assert task.description == {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [
                {"type": "text", "text": "line 1"}, {"type": "hardBreak"}, {"type": "text", "text": "line 2"}]},
            {"type": "paragraph", "content": [{"type": "text", "text": "para 2 **not bold** <b>x</b>"}]},
        ],
    }  # fmt: skip
    assert runner._description("") is None
    huge = "\n".join("x" for _ in range(6000))
    assert runner._description(huge) == {
        "type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": " ".join("x" * 6000)}]}]
    }  # fmt: skip


def test_more_than_20_labels(world):
    labels = ";".join(f"l{i}" for i in range(22))
    client = world.client()
    job = analyzed(client, world.project, f'Title,Labels\nOne,"{labels}"\n'.encode())
    body = start(client, job).json()
    assert body["result"]["issues"][0]["reason"] == "More than 20 labels · extra labels dropped"
    assert Task.objects.get(title="One").labels.count() == 20


# ───────────────────────── notification rules ─────────────────────────


def test_no_notification_when_the_creator_left_the_project(world, settings, monkeypatch):
    from apps.notifications.events import emit
    from apps.projects.models import ProjectMember

    client = world.client()
    job = mapped_sample(world)
    start(client, job)
    Notification.objects.all().delete()
    ProjectMember.objects.filter(project=world.project, user=world.alex).delete()
    emit("import_finished", workspace=world.ws, project=world.project, payload={"jobId": job["id"]})
    emit("import_finished", workspace=world.ws, project=world.project, payload={"jobId": None})
    assert not Notification.objects.exists()


# ───────────────────────── retention ─────────────────────────


def test_purge_imports(world, monkeypatch):
    client = world.client()
    draft = analyzed(client, world.project, SAMPLE)
    done = mapped_sample(world)
    start(client, done)
    old_draft = ImportJob.objects.get(pk=draft["id"])
    finished = ImportJob.objects.get(pk=done["id"])
    keys = [old_draft.source_key, old_draft.parsed_key, finished.source_key, finished.parsed_key, finished.report_key]
    assert all(get_storage().head(k) for k in keys)
    call_command("purge_imports")
    assert ImportJob.objects.count() == 2  # nothing expired yet
    later = timezone.now() + dt.timedelta(hours=25)
    counts = services.purge_expired(later)
    assert counts["drafts canceled"] == 1 and counts["jobs deleted"] == 1
    assert not ImportJob.objects.filter(pk=draft["id"]).exists()
    assert ImportJob.objects.filter(pk=done["id"]).exists()
    counts = services.purge_expired(timezone.now() + dt.timedelta(days=31))
    assert counts["jobs deleted"] == 1 and counts["rows deleted"] == 48
    assert not any(get_storage().head(k) for k in keys)
    assert Task.objects.filter(project=world.project, number__gt=60).count() == 44  # imported tasks stay
    assert client.get(f"/api/v1/imports/{done['id']}").status_code == 404


def test_purge_keeps_running_jobs(world, monkeypatch):
    rec = _queued(world, monkeypatch)
    ImportJob.objects.filter(pk=rec.pk).update(expires_at=timezone.now() - dt.timedelta(days=1))
    assert services.purge_expired()["jobs deleted"] == 0


def test_project_purge_removes_import_files(world):
    from apps.audit.trash import purge_project

    client = world.client()
    job = mapped_sample(world)
    start(client, job)
    rec = ImportJob.objects.get(pk=job["id"])
    keys = [rec.source_key, rec.parsed_key, rec.report_key]
    purge_project(type(world.project).all_objects.get(pk=world.project.pk))
    assert not any(get_storage().head(k) for k in keys)
    assert not ImportJob.objects.exists()


def test_viewer_cannot_read_even_their_own_old_job(world):
    job = mapped_sample(world)
    world.project.members.filter(user=world.alex).update(role=world.ws.roles.get(system_key="viewer"))
    res = client_for(world.alex).get(f"/api/v1/imports/{job['id']}")
    assert res.status_code == 403
