"""Sales S0 §3: the jobs registry, runner, idempotency helper, management command, Celery task and the internal
endpoint."""

import datetime as dt
import io

import pytest
from django.core.management import CommandError, call_command
from django.utils import timezone

from core.access.services import sync_permission_catalogue
from core.common import scoping
from core.common.testing import UserFactory, make_workspace
from core.jobs.models import JobMark
from core.jobs.registry import get_job, jobs, register_job, unregister_job
from core.jobs.services import claim, run_job
from core.jobs.tasks import run_job_task
from core.modules import services as modules
from core.tests.fake_module import module as fake
from core.workspaces.models import Workspace

pytestmark = pytest.mark.django_db

SECRET = "s3cret-jobs-value-0123456789abcdef"
SENT: list[tuple[str, dt.datetime]] = []


def digest(workspace, *, now):
    """A daily job: sends once per workspace per local day."""
    if claim(workspace, "test_digest", now.date().isoformat()):
        SENT.append((workspace.slug, now))


def broken(workspace, *, now):
    JobMark.objects.create(workspace=workspace, job="test_broken", key="x")  # rolled back with the failure
    if workspace.slug == "platform":
        raise RuntimeError("boom")


def scoped(workspace, *, now):
    """Scoped managers are pinned to the workspace being run."""
    assert scoping.current_workspace_id() == str(workspace.pk)
    SENT.append((workspace.slug, now))


@pytest.fixture(autouse=True)
def registered():
    SENT.clear()
    register_job("test_digest", digest, schedule="daily 07:30", description="Test digest")
    register_job("test_fake", digest, module="fake", schedule="hourly")
    register_job("test_broken", broken)
    register_job("test_scoped", scoped)
    yield
    for name in ("test_digest", "test_fake", "test_broken", "test_scoped"):
        unregister_job(name)


@pytest.fixture
def fake_module():
    fake.register()
    sync_permission_catalogue()
    yield
    fake.unregister()


@pytest.fixture
def two(ws):
    other = make_workspace(UserFactory(), name="Other", slug="other")
    other.timezone = "America/Los_Angeles"
    other.save()
    return ws, other


# ───────────────────────── registry and runner ─────────────────────────


def test_registry():
    assert get_job("test_digest").schedule == "daily 07:30"
    assert "test_digest" in [j.name for j in jobs()]
    with pytest.raises(ValueError):
        register_job("Bad-Name", digest)
    assert get_job("nope") is None


def test_runs_per_workspace_in_its_timezone_and_only_once(two):
    ws, other = two
    now = dt.datetime(2026, 10, 17, 21, 30, tzinfo=dt.UTC)  # 00:30 on the 18th in Addis, 14:30 on the 17th in LA
    result = run_job("test_digest", now=now)
    assert result.as_dict() == {
        "job": "test_digest",
        "ran": 2,
        "skipped": 0,
        "failed": 0,
        "workspaces": [
            {"workspaceId": str(ws.pk), "status": "ran"},
            {"workspaceId": str(other.pk), "status": "ran"},
        ],
    }
    assert [(slug, n.isoformat()) for slug, n in SENT] == [
        ("platform", "2026-10-18T00:30:00+03:00"),
        ("other", "2026-10-17T14:30:00-07:00"),
    ]
    # Running twice sends once.
    run_job("test_digest", now=now + dt.timedelta(minutes=5))
    assert len(SENT) == 2
    assert set(JobMark.objects.values_list("workspace__slug", "key")) == {
        ("platform", "2026-10-18"),
        ("other", "2026-10-17"),
    }
    # The next local day sends again.
    run_job("test_digest", now=now + dt.timedelta(days=1))
    assert len(SENT) == 4


def test_skips_deleted_workspaces_and_runs_one(two):
    ws, other = two
    Workspace.objects.filter(pk=other.pk).update(deleted_at=timezone.now())
    assert [w["workspaceId"] for w in run_job("test_digest").workspaces] == [str(ws.pk)]
    SENT.clear()
    JobMark.objects.all().delete()
    result = run_job("test_digest", workspace_id=str(ws.pk))
    assert result.count("ran") == 1 and [s for s, _ in SENT] == ["platform"]
    from core.common.exceptions import ApiError

    for bad in (str(other.pk), "nope", "00000000-0000-0000-0000-000000000000"):
        with pytest.raises(ApiError) as exc:
            run_job("test_digest", workspace_id=bad)
        assert exc.value.status_code == 404
    with pytest.raises(ApiError):
        run_job("missing_job")


def test_module_disabled_workspaces_are_skipped(fake_module, two, owner):
    ws, other = two
    modules.set_module_enabled(owner, ws, "fake", True)
    result = run_job("test_fake")
    assert [(w["workspaceId"], w["status"]) for w in result.workspaces] == [
        (str(ws.pk), "ran"),
        (str(other.pk), "skipped"),
    ]
    modules.set_module_enabled(owner, ws, "fake", False)
    assert run_job("test_fake").count("skipped") == 2


def test_a_failure_is_isolated_and_rolled_back(two):
    ws, other = two
    result = run_job("test_broken")
    assert [(w["workspaceId"], w["status"], w.get("error")) for w in result.workspaces] == [
        (str(ws.pk), "failed", "RuntimeError"),
        (str(other.pk), "ran", None),
    ]
    assert list(JobMark.objects.values_list("workspace__slug", flat=True)) == ["other"]


def test_jobs_run_scoped_to_the_workspace(two):
    assert run_job("test_scoped").count("ran") == 2


def test_claim_outside_a_job(ws):
    assert claim(ws, "manual", "k") is True
    assert claim(ws.pk, "manual", "k") is False
    assert claim(ws, "manual", "other") is True


# ───────────────────────── command and Celery ─────────────────────────


def test_command(two):
    ws, _ = two
    out = io.StringIO()
    call_command("run_job", "test_digest", stdout=out)
    assert "test_digest: ran 2, skipped 0" in out.getvalue()
    out = io.StringIO()
    call_command("run_job", "test_digest", "--workspace", str(ws.pk), stdout=out)
    assert f"{ws.pk}  ran" in out.getvalue()
    out = io.StringIO()
    call_command("run_job", "--list", stdout=out)
    assert "test_digest  [core]  daily 07:30  Test digest" in out.getvalue()
    assert "test_fake  [fake]  hourly" in out.getvalue()
    with pytest.raises(CommandError, match="Job not found"):
        call_command("run_job", "missing_job")
    with pytest.raises(CommandError, match="Name a job"):
        call_command("run_job")
    with pytest.raises(CommandError, match="failed 1"):
        call_command("run_job", "test_broken", stdout=io.StringIO())


def test_celery_task(two):
    assert run_job_task.name == "core.jobs.run_job"
    assert run_job_task.delay("test_digest").get()["ran"] == 2  # eager in tests
    assert len(SENT) == 2


# ───────────────────────── internal endpoint ─────────────────────────


def url(name="test_digest"):
    return f"/api/v1/internal/jobs/{name}"


def test_endpoint_refuses_everything_without_a_configured_secret(api, ws, settings):
    for secret in ("", "   "):
        settings.JOBS_SECRET = secret
        res = api.post(url(), HTTP_X_JOBS_SECRET=secret)
        assert (res.status_code, res.json()["code"]) == (403, "forbidden")
        assert api.post(url(), HTTP_X_JOBS_SECRET="anything").status_code == 403
    assert SENT == []


def test_endpoint_checks_the_secret(api, ws, settings):
    settings.JOBS_SECRET = SECRET
    assert api.post(url()).status_code == 403
    assert api.post(url(), HTTP_X_JOBS_SECRET=SECRET + "x").status_code == 403
    assert api.post(url("missing_job"), HTTP_X_JOBS_SECRET="wrong").status_code == 403  # no job-name probing
    assert SENT == []
    missing = api.post(url("missing_job"), HTTP_X_JOBS_SECRET=SECRET)
    assert (missing.status_code, missing.json()["code"]) == (404, "not_found")
    ok = api.post(url(), HTTP_X_JOBS_SECRET=SECRET)
    assert ok.status_code == 200
    assert ok.json()["ran"] == 1 and len(SENT) == 1
    again = api.post(url(), {"workspaceId": str(ws.pk)}, format="json", HTTP_X_JOBS_SECRET=SECRET)
    assert again.json()["workspaces"] == [{"workspaceId": str(ws.pk), "status": "ran"}]
    assert len(SENT) == 1  # idempotent
    bad_ws = api.post(url(), {"workspaceId": "nope"}, format="json", HTTP_X_JOBS_SECRET=SECRET)
    assert bad_ws.status_code == 404


def test_endpoint_ignores_user_auth(ws, owner, settings):
    from core.common.testing import client_for

    settings.JOBS_SECRET = SECRET
    assert client_for(owner).post(url()).status_code == 403
