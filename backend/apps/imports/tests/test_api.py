"""Board 40 endpoints I1 (create), I2 (analyze), I3 (get), I4 (mapping), I5 (rows), I7 (cancel), I9 (history)."""

import datetime as dt

import pytest
from django.test import override_settings

from apps.collaboration import storage as storage_module
from apps.collaboration.storage import get_storage
from apps.common.testing import UserFactory, add_member, client_for, make_project, make_workspace
from apps.imports.models import ImportJob

from .fixtures import JIRA, SAMPLE, analyzed, create, mapped_sample, sample_text, save_mapping, start, upload

pytestmark = pytest.mark.django_db

JOB_KEYS = {
    "id", "projectId", "source", "preset", "status", "cancelRequested", "file", "analysis", "mapping", "validation",
    "progress", "result", "error", "createdById", "createdAt", "startedAt", "finishedAt", "expiresAt",
}  # fmt: skip


# ───────────────────────── I1 ─────────────────────────


def test_create_returns_a_draft_job_and_a_signed_upload_ticket(world):
    res = create(world.client(), world.project, name="tasks-export.csv", size=4210)
    assert res.status_code == 201
    body = res.json()
    job, ticket = body["job"], body["upload"]
    assert set(job) == JOB_KEYS
    assert job["status"] == "draft" and job["source"] == "csv" and job["preset"] == "generic"
    assert job["file"] == {
        "name": "tasks-export.csv", "size": 4210, "encoding": "", "delimiter": "", "rowCount": 0, "columnCount": 0
    }  # fmt: skip
    assert job["analysis"] is job["mapping"] is job["validation"] is job["progress"] is job["result"] is None
    assert job["createdById"] == str(world.alex.id)
    created = dt.datetime.fromisoformat(job["createdAt"])
    assert dt.datetime.fromisoformat(job["expiresAt"]) - created == dt.timedelta(hours=24)
    assert ticket["uploadId"] == job["id"]
    assert ticket["method"] == "PUT" and ticket["headers"] == {"Content-Type": "text/csv"}
    key = ImportJob.objects.get(pk=job["id"]).source_key
    assert key == f"ws/{world.ws.id}/p/{world.project.id}/imports/{job['id']}/source.csv"
    assert "tasks-export" not in key
    assert ticket["url"].startswith("https://storage.test/upload/")


@pytest.mark.parametrize("backend", ["local", "r2"])
def test_create_ticket_for_every_storage_backend(world, backend, tmp_path):
    extra = {"MEDIA_ROOT": tmp_path} if backend == "local" else {
        "R2_ACCOUNT_ID": "acct", "R2_ACCESS_KEY_ID": "key", "R2_SECRET_ACCESS_KEY": "secret", "R2_BUCKET": "bucket",
    }  # fmt: skip
    storage_module.get_storage.cache_clear()
    try:
        with override_settings(STORAGE_BACKEND=backend, **extra):
            res = create(world.client(), world.project)
            assert res.status_code == 201, res.content
            url = res.json()["upload"]["url"]
            assert ("/api/v1/storage/upload/" in url) if backend == "local" else ("X-Amz-Signature" in url)
    finally:
        storage_module.get_storage.cache_clear()


@pytest.mark.parametrize(
    ("payload", "fields"),
    [
        ({"source": "trello", "fileName": "a.csv", "size": 10}, {"source": "Trello import is coming soon"}),
        ({"source": "asana", "fileName": "a.csv", "size": 10}, {"source": "Pick CSV or Jira"}),
        ({"source": "csv", "fileName": "tasks.xlsx", "size": 10}, {"file": "Only .csv files"}),
        ({"source": "csv", "fileName": "tasks", "size": 10}, {"file": "Only .csv files"}),
        ({"source": "csv", "fileName": "a.csv", "size": 0}, {"file": "File is empty"}),
        ({"source": "csv", "fileName": "a.csv", "size": "10"}, {"file": "File is empty"}),
        ({"source": "csv", "fileName": "a.csv", "size": True}, {"file": "File is empty"}),
        ({"source": "csv", "fileName": "a.csv", "size": 13002342}, {"file": "File is too large"}),
    ],
)
def test_create_validation(world, payload, fields):
    res = world.client().post(f"/api/v1/projects/{world.project.id}/imports", payload)
    assert res.status_code == 422
    assert res.json()["code"] == "validation_failed"
    assert res.json()["details"]["fields"] == fields
    if fields == {"file": "File is too large"}:
        assert res.json()["details"]["file"] == {"reason": "too_large", "size": 13002342}


def test_create_cleans_the_file_name(world):
    res = create(world.client(), world.project, name="C:\\Users\\me\\My\x07 tasks.CSV")
    assert res.json()["job"]["file"]["name"] == "My tasks.CSV"


def test_create_permissions(world, custom_member):
    assert create(world.client(world.sam), world.project).status_code == 201  # project Member
    res = create(world.client(world.taylor), world.project)  # Viewer
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "project.import"
    no_create = custom_member("project.view", "project.import")
    res = create(world.client(no_create), world.project)
    assert res.status_code == 403 and res.json()["details"]["permission"] == "task.create"
    no_import = custom_member("project.view", "task.create", name="Nadia")
    res = create(world.client(no_import), world.project)
    assert res.status_code == 403 and res.json()["details"]["permission"] == "project.import"
    outsider_on_ws = add_member(world.ws, UserFactory(), "admin")
    res = create(client_for(outsider_on_ws), world.project)
    assert res.status_code == 403 and res.json()["code"] == "project_membership_required"
    stranger = UserFactory()
    make_workspace(stranger, name="Elsewhere", slug="elsewhere")
    assert create(client_for(stranger), world.project).status_code == 404


def test_archived_projects_refuse_imports(world):
    world.client().post(f"/api/v1/projects/{world.project.id}/archive")
    res = create(world.client(), world.project)
    assert res.status_code == 403 and res.json()["details"]["permission"] == "project.import"
    assert world.client().get(f"/api/v1/projects/{world.project.id}/imports").status_code == 403


def test_create_is_throttled(world, monkeypatch):
    from apps.common.throttles import ImportThrottle

    monkeypatch.setattr(ImportThrottle, "THROTTLE_RATES", {"imports": "2/hour"})
    client = world.client()
    assert create(client, world.project).status_code == 201
    assert create(client, world.project).status_code == 201
    res = create(client, world.project)
    assert res.status_code == 429 and res.json()["code"] == "rate_limited"
    assert client.get(f"/api/v1/projects/{world.project.id}/imports").status_code == 200  # reads aren't throttled


def test_project_payload_has_next_task_number(world):
    body = world.client().get(f"/api/v1/projects/{world.project.id}").json()
    assert body["nextTaskNumber"] == 61
    listed = world.client().get("/api/v1/workspaces/platform/projects").json()
    assert listed[0]["nextTaskNumber"] == 61


# ───────────────────────── I2 ─────────────────────────


def test_analyze_the_sample(world):
    job = analyzed(world.client(), world.project, SAMPLE)
    todo, progress, done, review = (str(world.status(n).id) for n in ("Todo", "In progress", "Done", "In review"))
    assert job["status"] == "ready" and job["preset"] == "generic"
    assert job["file"] == {
        "name": "tasks-export.csv", "size": len(SAMPLE), "encoding": "utf-8", "delimiter": ",", "rowCount": 48,
        "columnCount": 8,
    }  # fmt: skip
    columns = {c["name"]: c for c in job["analysis"]["columns"]}
    assert list(columns) == ["Title", "Description", "Status", "Assignee", "Priority", "Estimate", "Due", "Tags"]
    assert columns["Title"] == {
        "index": 0, "name": "Title",
        "samples": ["Fix login redirect loop", "Add SSO for admin console", "Board loads slowly with 500 cards"],
        "inferredType": "text", "emptyCount": 2, "distinctCount": 46, "dateOrder": None,
    }  # fmt: skip
    assert columns["Status"]["samples"] == ["todo", "in progress", "done"]
    assert columns["Status"]["distinctCount"] == 5
    assert columns["Due"]["inferredType"] == "date" and columns["Due"]["dateOrder"] == "ymd"
    assert columns["Due"]["samples"] == ["2026-10-08", "2026-10-09", "2026-10-10"]
    # §4.3's own rule (≥ 30 % of non-empty cells hold a list) makes Tags "text" here (1 in 4); the mock agrees.
    assert columns["Tags"]["inferredType"] == "text"
    assert columns["Tags"]["samples"] == ["frontend", "backend", "frontend;perf"]
    assert columns["Assignee"]["inferredType"] == "text"  # 3 of 4 names are members: under the 80 % bar
    assert job["mapping"] == {
        "revision": 0,
        "columns": [{"field": f} for f in
                    ("title", "description", "status", "assignee", "priority", "estimate", "dueDate", "labels")],
        "statuses": {"todo": todo, "in progress": progress, "done": done, "review": review, "blocked": None},
        "types": {},
        "people": {"alex kim": str(world.alex.id), "riley chen": str(world.riley.id), "sam patel": str(world.sam.id),
                   "chris ortiz": None},
    }  # fmt: skip
    v = job["validation"]
    assert v["ready"] is False
    assert v["blockers"] == [{"code": "status_unmapped", "message": "Map 1 more status", "field": "status"}]
    assert v["values"]["statuses"] == [
        {"key": "todo", "value": "todo", "count": 14, "target": todo, "auto": True},
        {"key": "in progress", "value": "in progress", "count": 14, "target": progress, "auto": True},
        {"key": "done", "value": "done", "count": 7, "target": done, "auto": True},
        {"key": "review", "value": "review", "count": 7, "target": review, "auto": True},
        {"key": "blocked", "value": "blocked", "count": 6, "target": None, "auto": False},
    ]
    assert v["values"]["types"] == []
    assert [(p["value"], p["count"], p["target"], p["auto"], p["matchedBy"]) for p in v["values"]["people"]] == [
        ("Alex Kim", 10, str(world.alex.id), True, "name"),
        ("Riley Chen", 10, str(world.riley.id), True, "name"),
        ("Sam Patel", 10, str(world.sam.id), True, "name"),
        ("Chris Ortiz", 9, None, False, None),
    ]
    assert v["counts"] == {"rows": 48, "tasks": 44, "epics": 0, "skipped": 4, "warnings": 0, "statuses": 5, "people": 3}
    assert v["skipReasons"] == [
        {"reason": "Missing title", "count": 2},
        {"reason": "Invalid due date", "count": 1},
        {"reason": "Estimate is not a number", "count": 1},
    ]
    assert v["creates"] == {"labels": ["api"], "epics": [], "options": []}
    assert v["keyRange"] == {"first": "PRJ-61", "last": "PRJ-104"}
    assert world.client().get(f"/api/v1/imports/{job['id']}").json() == job  # I3 returns the same job


def test_analyze_is_idempotent_and_creator_only(world):
    job = analyzed(world.client(), world.project, SAMPLE)
    again = world.client().post(f"/api/v1/imports/{job['id']}/analyze")
    assert again.status_code == 200 and again.json() == job
    res = world.client(world.riley).post(f"/api/v1/imports/{job['id']}/analyze")
    assert res.status_code == 403
    assert res.json()["message"] == "Only the person who started this import can change it."
    assert "permission" not in res.json()["details"]


def _analysis_error(world, data: bytes | None, declared: int = 10):
    client = world.client()
    job = create(client, world.project, size=declared).json()["job"]
    if data is not None:
        upload(job, data)
    res = client.post(f"/api/v1/imports/{job['id']}/analyze")
    assert res.status_code == 422, res.content
    body = res.json()
    assert body["details"]["fields"]["file"] == body["message"]
    assert ImportJob.objects.get(pk=job["id"]).status == "draft"
    return body["message"], body["details"]["file"]


def test_analysis_errors(world):
    assert _analysis_error(world, None) == ("Couldn’t read file", {"reason": "upload_missing"})
    big = b"Title\n" + b"x" * (10 * 1024 * 1024)
    assert _analysis_error(world, big) == ("File is too large", {"reason": "too_large", "size": len(big)})
    assert _analysis_error(world, b"") == ("File is empty", {"reason": "empty"})
    assert _analysis_error(world, b"PK\x03\x04rest") == ("Only .csv files", {"reason": "excel"})
    assert _analysis_error(world, b"\xd0\xcf\x11\xe0rest") == ("Only .csv files", {"reason": "excel"})
    assert _analysis_error(world, b"Title\nA\x00B\n") == ("Not a text file", {"reason": "binary"})
    unclosed = b'Title,Notes\nA,ok\nB,"never closed\nC,x\n'
    assert _analysis_error(world, unclosed) == ("Unclosed quote", {"reason": "unclosed_quote", "line": 3})
    long = b"Title\nok\n" + b"x" * 65_537 + b"\n"
    assert _analysis_error(world, long) == ("A cell is too long", {"reason": "cell_too_long", "line": 3})
    assert _analysis_error(world, b"\r\n\r\n") == ("No rows found", {"reason": "no_rows"})
    assert _analysis_error(world, b"Title,Status\r\n") == ("Header only, no rows", {"reason": "header_only"})
    wide = ",".join(f"C{i}" for i in range(45)).encode() + b"\nx\n"
    assert _analysis_error(world, wide) == (
        "Too many columns",
        {"reason": "too_many_columns", "columns": 45, "max": 40},
    )
    many = b"Title\n" + b"\n".join(b"t%d" % i for i in range(5001)) + b"\n"
    assert _analysis_error(world, many) == ("Too many rows", {"reason": "too_many_rows", "rows": 5001, "max": 5000})


def test_analysis_reports_encoding_and_delimiter(world):
    data = "Title;Estimate\nCafé;1,5\nB;2\n".encode("cp1252")
    job = analyzed(world.client(), world.project, data)
    assert job["file"]["encoding"] == "windows-1252" and job["file"]["delimiter"] == ";"
    assert job["analysis"]["columns"][0]["samples"] == ["Café", "B"]
    tab = b"\xff\xfe" + "Title\tStatus\r\nA\ttodo\r\n".encode("utf-16-le")
    job = analyzed(world.client(), world.project, tab)
    assert job["file"]["encoding"] == "utf-16" and job["file"]["delimiter"] == "\t"


@pytest.mark.parametrize(
    ("header", "preset"),
    [
        (JIRA.split(b"\n")[0], "jira"),
        (b"ID,Title,Status,Cycle Name", "linear"),
        (b"ID,Title,Team", "linear"),
        (b"Task ID,Name,Section/Column,Assignee,Assignee Email,Notes,Parent task", "asana"),
        (b"Title,Status", "generic"),
    ],
)
def test_preset_detection(world, header, preset):
    width = len(header.split(b","))
    job = analyzed(world.client(), world.project, header + b"\n" + b",".join([b"x"] * width) + b"\n")
    assert job["preset"] == preset


def test_jira_suggestions(world):
    job = analyzed(world.client(), world.project, JIRA, source="jira")
    assert job["source"] == "jira" and job["preset"] == "jira"
    fields = [c["field"] for c in job["mapping"]["columns"]]
    assert fields == [
        "sourceId", "sourceId", "title", "type", "status", "priority", "assignee", "estimate", "timeEstimate", "parent",
        "labels", "labels", "startDate", "dueDate", "blockedBy", "sprint",
    ]  # fmt: skip
    assert job["mapping"]["columns"][8] == {"field": "timeEstimate", "unit": "seconds"}
    assert [c["name"] for c in job["analysis"]["columns"]][10:12] == ["Labels", "Labels (2)"]
    v = job["validation"]
    assert v["blockers"] == []
    assert [(t["key"], t["target"]) for t in v["values"]["types"]] == [
        ("epic", "epic"), ("story", "feature"), ("sub-task", "feature"), ("bug", "feature" if False else "bug"),
        ("task", "feature"),
    ]  # fmt: skip
    people = {p["value"]: (p["target"], p["matchedBy"]) for p in v["values"]["people"]}
    assert people == {
        "Alex Kim": (str(world.alex.id), "name"),
        "Jordan Lee": (str(world.jordan.id), "name"),
        "jordan.lee": (str(world.jordan.id), "initial"),
        "Sam P.": (str(world.sam.id), "initial"),
        "Dana Wu": (None, None),
    }
    assert v["counts"] == {"rows": 6, "tasks": 4, "epics": 1, "skipped": 1, "warnings": 1, "statuses": 4, "people": 4}
    assert v["creates"] == {"labels": ["ux", "api"], "epics": ["Checkout redesign"], "options": []}
    assert v["keyRange"] == {"first": "PRJ-61", "last": "PRJ-64"}


def test_canceled_draft_cannot_be_analyzed(world):
    client = world.client()
    job = create(client, world.project).json()["job"]
    upload(job, SAMPLE)
    assert client.post(f"/api/v1/imports/{job['id']}/cancel").json()["status"] == "canceled"
    res = client.post(f"/api/v1/imports/{job['id']}/analyze")
    assert res.status_code == 409 and res.json()["code"] == "import_state"
    assert res.json()["message"] == "This import has finished."


# ───────────────────────── I4 ─────────────────────────


def test_mapping_choices_explicit_nulls_and_stale_keys(world):
    client = world.client()
    job = analyzed(client, world.project, SAMPLE)
    todo = str(world.status("Todo").id)
    res = save_mapping(
        client, job, statuses={"blocked": todo, "gone": todo}, people={"chris ortiz": None, "alex kim": None}
    )
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["mapping"]["revision"] == 1
    assert body["mapping"]["statuses"]["blocked"] == todo and "gone" not in body["mapping"]["statuses"]
    people = {p["key"]: p for p in body["validation"]["values"]["people"]}
    assert people["alex kim"]["target"] is None and people["alex kim"]["auto"] is False
    assert people["riley chen"]["auto"] is True  # absent key → the server's suggestion
    assert body["validation"]["ready"] is True and body["validation"]["counts"]["people"] == 2
    assert "_user" not in body["mapping"]
    stored = ImportJob.objects.get(pk=job["id"]).mapping["_user"]
    assert stored["statuses"] == {"blocked": todo}  # "gone" no longer occurs: dropped


def test_mapping_revision_conflict_returns_the_current_job(world):
    client = world.client()
    job = mapped_sample(world)
    stale = {**job["mapping"], "revision": 1}
    res = client.put(f"/api/v1/imports/{job['id']}/mapping", stale)
    assert res.status_code == 409 and res.json()["code"] == "mapping_conflict"
    assert res.json()["details"]["current"]["mapping"]["revision"] == 1
    assert client.put(f"/api/v1/imports/{job['id']}/mapping", {**stale, "revision": "2"}).status_code == 409


def test_mapping_validation_errors(world):
    from apps.projects.models import CustomField

    other = make_project(world.ws, world.alex, key="OTH", name="Other")
    foreign_field = CustomField.objects.create(project=other, name="Foreign", type="text")
    client = world.client()
    job = analyzed(client, world.project, SAMPLE)
    cols = job["mapping"]["columns"]

    def put(**changes):
        return save_mapping(client, job, **changes)

    assert put(columns=cols[:3]).json()["details"]["fields"] == {"columns": "Send one entry per column"}
    bad = [*cols[:7], {"field": "nope"}]
    assert put(columns=bad).json()["details"]["fields"] == {"columns.7.field": "Pick a field"}
    bad = [*cols[:7], {"field": "customField", "customFieldId": str(foreign_field.id)}]
    assert put(columns=bad).json()["details"]["fields"] == {"columns.7.customFieldId": "This field was deleted"}
    res = put(statuses={"blocked": str(other.statuses.first().id)})
    assert res.json()["details"]["fields"] == {"statuses.blocked": "Pick a status from this project"}
    assert put(types={"x": "task"}).json()["details"]["fields"] == {
        "types.x": "Pick feature, bug, chore, spike or epic"
    }
    stranger = UserFactory()
    res = put(people={"chris ortiz": str(stranger.id)})
    assert res.json()["details"]["fields"] == {"people.chris ortiz": "Pick someone on this project"}


def test_mapping_respects_the_importers_permissions(world, custom_member):
    # Sam (project Member) lacks epic.manage: "epic" isn't suggested and can't be chosen.
    client = world.client(world.sam)
    job = analyzed(client, world.project, JIRA)
    v = job["validation"]
    assert v["blockers"][0] == {"code": "type_unmapped", "message": "Map 1 more type", "field": "type"}
    assert v["creates"]["epics"] == []
    res = save_mapping(client, job, types={"epic": "epic"})
    assert res.json()["details"]["fields"] == {"types.epic": "You can’t create epics in this project"}
    # A custom role without task.assign: only "You" can be suggested or chosen.
    loner = custom_member("project.view", "task.create", "project.import", name="Lee Loner")
    client = client_for(loner)
    job = analyzed(client, world.project, SAMPLE)
    assert [p["target"] for p in job["validation"]["values"]["people"]] == [None, None, None, None]
    res = save_mapping(client, job, people={"alex kim": str(world.alex.id)})
    assert res.json()["details"]["fields"] == {"people.alex kim": "You can only assign tasks to yourself"}
    assert save_mapping(client, job, people={"alex kim": str(loner.id)}).status_code == 200


def test_mapping_time_estimate_unit_defaults(world):
    client = world.client()
    job = analyzed(client, world.project, JIRA, source="jira")
    cols = [dict(c) for c in job["mapping"]["columns"]]
    cols[8] = {"field": "timeEstimate"}
    body = save_mapping(client, job, columns=cols).json()
    assert body["mapping"]["columns"][8] == {"field": "timeEstimate", "unit": "seconds"}
    cols[8] = {"field": "timeEstimate", "unit": "minutes"}
    assert save_mapping(client, body, columns=cols).json()["mapping"]["columns"][8]["unit"] == "minutes"


def test_blockers_in_order(world):
    from apps.projects.models import CustomField

    client = world.client()
    job = analyzed(client, world.project, SAMPLE)
    cols = job["mapping"]["columns"]
    skip = {"field": "skip"}
    res = save_mapping(client, job, columns=[skip, cols[1], cols[2], cols[3], {"field": "status"}, *cols[5:]])
    assert [b["message"] for b in res.json()["validation"]["blockers"]] == [
        "Map a column to Title",
        "Two columns map to Status",
        "Map 1 more status",
        "No rows can be imported",
    ]
    job = res.json()
    field = CustomField.objects.create(project=world.project, name="Area", type="text")
    cf = {"field": "customField", "customFieldId": str(field.id)}
    res = save_mapping(client, job, columns=[cols[0], cf, cols[2], cols[3], cf, *cols[5:]])
    assert res.json()["validation"]["blockers"][0]["message"] == "Two columns map to Area"
    job = res.json()
    res = save_mapping(client, job, columns=[cols[0], cols[1], {"field": "type"}, *cols[3:]])
    blockers = res.json()["validation"]["blockers"]
    assert blockers[0] == {"code": "type_unmapped", "message": "Map 5 more types", "field": "type"}


def test_too_many_values_and_creates(world):
    rows = [f"T{i},S{i},P{i},l{i}" for i in range(210)]
    data = ("Title,Status,Assignee,Labels\n" + "\n".join(rows) + "\n").encode()
    job = analyzed(world.client(), world.project, data)
    blockers = [b["message"] for b in job["validation"]["blockers"]]
    assert "Too many statuses (210 · max 50)" in blockers
    assert "Too many people (210 · max 200)" in blockers
    assert "Too many new labels (210 · max 100)" in blockers
    rows = [f"T{i},{'Epic' if i < 60 else 'Bug'},E{i}" for i in range(80)]
    data = ("Title,Type,Epic\n" + "\n".join(rows) + "\n").encode()
    blockers = [b["message"] for b in analyzed(world.client(), world.project, data)["validation"]["blockers"]]
    assert "Too many new epics (80 · max 50)" in blockers
    data = ("Title,Type\n" + "\n".join(f"T{i},K{i}" for i in range(25)) + "\n").encode()
    blockers = [b["message"] for b in analyzed(world.client(), world.project, data)["validation"]["blockers"]]
    assert "Too many types (25 · max 20)" in blockers


def test_mapping_outside_ready_is_409(world):
    client = world.client()
    job = mapped_sample(world)
    start(client, job)
    res = save_mapping(client, job)
    assert res.status_code == 409 and res.json()["code"] == "import_state"
    assert res.json()["details"]["status"] == "completed"


# ───────────────────────── I5 ─────────────────────────


def test_rows_dry_run_and_filters(world):
    client = world.client()
    job = analyzed(client, world.project, SAMPLE)
    url = f"/api/v1/imports/{job['id']}/rows"
    page = client.get(url, {"limit": 5}).json()
    assert [r["row"] for r in page["data"]] == [2, 3, 4, 5, 6]
    first = page["data"][0]
    assert first["outcome"] == "task" and first["key"] == "PRJ-61" and first["issues"] == []
    assert first["values"] == {
        "title": "Fix login redirect loop", "type": "feature", "statusId": str(world.status("Todo").id),
        "assigneeId": str(world.alex.id), "priority": 3, "estimate": 3, "timeEstimateMinutes": None,
        "startDate": None, "dueDate": "2026-10-08", "labels": ["frontend"], "epic": None, "sprintId": None,
        "parent": None, "customFields": {},
    }  # fmt: skip
    assert page["nextCursor"]
    second = client.get(url, {"limit": 5, "cursor": page["nextCursor"]}).json()
    assert [r["row"] for r in second["data"]] == [7, 8, 9, 10, 11]
    row8 = second["data"][1]
    assert row8["outcome"] == "skipped" and row8["key"] is None and row8["values"]["statusId"] is None
    assert row8["issues"] == [{"severity": "skip", "field": "title", "reason": "Missing title", "value": ""}]
    skipped = client.get(url, {"filter[outcome]": "skipped", "limit": 100}).json()
    assert [r["row"] for r in skipped["data"]] == [8, 20, 27, 42] and skipped["nextCursor"] is None
    assert client.get(url, {"filter[outcome]": "warning"}).json()["data"] == []
    assert client.get(url, {"filter[outcome]": "nope"}).status_code == 422
    assert len(client.get(url, {"limit": 500}).json()["data"]) == 48


def test_rows_after_the_run_come_from_import_rows(world):
    client = world.client()
    job = mapped_sample(world)
    start(client, job)
    url = f"/api/v1/imports/{job['id']}/rows"
    tasks = client.get(url, {"filter[outcome]": "task", "limit": 100}).json()["data"]
    assert len(tasks) == 44
    assert tasks[0]["key"] == "PRJ-61" and tasks[-1]["key"] == "PRJ-104"
    assert tasks[0]["values"]["title"] == "Fix login redirect loop"
    assert len(client.get(url, {"filter[outcome]": "skipped"}).json()["data"]) == 4


# ───────────────────────── I3 / I7 / I9 ─────────────────────────


def test_get_and_history_permissions(world, custom_member):
    client = world.client()
    job = mapped_sample(world)
    assert world.client(world.riley).get(f"/api/v1/imports/{job['id']}").status_code == 200
    res = world.client(world.taylor).get(f"/api/v1/imports/{job['id']}")
    assert res.status_code == 403 and res.json()["details"]["permission"] == "project.import"
    outsider = add_member(world.ws, UserFactory(), "member")
    res = client_for(outsider).get(f"/api/v1/imports/{job['id']}")
    assert res.status_code == 403 and res.json()["code"] == "project_membership_required"
    assert client.get("/api/v1/imports/00000000-0000-0000-0000-000000000000").status_code == 404
    assert world.client(world.taylor).get(f"/api/v1/projects/{world.project.id}/imports").status_code == 403
    no_create = custom_member("project.view", "project.import")
    res = client_for(no_create).get(f"/api/v1/projects/{world.project.id}/imports")
    assert res.status_code == 403 and res.json()["details"]["permission"] == "task.create"


def test_history_lists_started_jobs_newest_first(world):
    client = world.client()
    create(client, world.project)  # a draft: not listed
    ready = analyzed(client, world.project, SAMPLE)
    done = mapped_sample(world)
    start(client, done)
    rows = client.get(f"/api/v1/projects/{world.project.id}/imports").json()
    assert [r["id"] for r in rows] == [done["id"], ready["id"]]
    assert set(rows[0]) == {
        "id", "projectId", "source", "status", "fileName", "imported", "skipped", "firstKey", "lastKey",
        "hasErrorReport", "createdById", "createdAt", "startedAt", "finishedAt", "expiresAt", "error",
    }  # fmt: skip
    assert rows[0]["status"] == "completed" and rows[0]["imported"] == 44 and rows[0]["skipped"] == 4
    assert (rows[0]["firstKey"], rows[0]["lastKey"], rows[0]["hasErrorReport"]) == ("PRJ-61", "PRJ-104", True)
    assert rows[1]["status"] == "ready" and rows[1]["firstKey"] is None


def test_cancel_draft_and_ready_delete_the_files(world):
    client = world.client()
    job = analyzed(client, world.project, SAMPLE)
    rec = ImportJob.objects.get(pk=job["id"])
    assert get_storage().head(rec.source_key) and get_storage().head(rec.parsed_key)
    res = client.post(f"/api/v1/imports/{job['id']}/cancel")
    assert res.status_code == 200 and res.json()["status"] == "canceled"
    assert res.json()["result"] is None and res.json()["progress"] is None
    assert get_storage().head(rec.source_key) is None and get_storage().head(rec.parsed_key) is None
    again = client.post(f"/api/v1/imports/{job['id']}/cancel")
    assert again.status_code == 409 and again.json()["message"] == "This import has finished."
    draft = create(client, world.project).json()["job"]
    assert client.post(f"/api/v1/imports/{draft['id']}/cancel").json()["status"] == "canceled"


def test_cancel_permissions(world):
    job = analyzed(world.client(world.sam), world.project, SAMPLE)
    res = world.client(world.riley).post(f"/api/v1/imports/{job['id']}/cancel")
    assert res.status_code == 403 and res.json()["details"]["permission"] == "project.update"
    # A project.update holder (Alex, Project Admin) may stop someone else's import.
    assert world.client().post(f"/api/v1/imports/{job['id']}/cancel").json()["status"] == "canceled"


def test_member_import_from_a_larger_file_reads_all_rows(world):
    data = sample_text(120).encode()
    job = analyzed(world.client(), world.project, data)
    assert job["file"]["rowCount"] == 120
