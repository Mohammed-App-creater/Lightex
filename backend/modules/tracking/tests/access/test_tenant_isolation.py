"""Platform Stage 5: tenant isolation, generated from the URL resolver (docs/platform/stage5-contract.md §1.5).

Every `tracking/` and `sales/` route and every core workspace-scoped route (scoped views and the generic
comment/attachment routes) is called, with every method it implements, by a user of workspace A against the objects
of workspace B. The answer is always 404: B's records don't exist for A. A route the walk finds but can't build fails
the test until it gets kwargs here or a listed skip, so new routes are covered automatically.

Also here: the model-level guarantees (every module and platform table has a non-null workspace and the scoped
manager, with the listed exceptions) and the scoped manager's policy itself.
"""

from __future__ import annotations

import re
import uuid

import pytest
from django.apps import apps
from django.test import override_settings
from django.urls import URLResolver, get_resolver

from core.access.permissions import ScopedView
from core.common import scoping
from core.common.models import WorkspaceScopedMixin
from core.common.testing import client_for, shared_world

from .matrix_world import build_world

METHODS = ("get", "post", "put", "patch", "delete")
MODULE_PREFIXES = ("api/v1/tracking/", "api/v1/sales/")
#: Core routes that are scoped to one workspace through a record instead of a ScopedView.
CORE_RECORD_ROUTES = {
    "target-comments", "target-attachments", "target-attachment-upload-url", "comment-detail", "attachment-detail",
    "attachment-confirm", "attachment-download-url",
}  # fmt: skip

#: Routes with no workspace in them, each with the reason; the user-level ones get explicit cases below.
SKIPS = {
    "my-tasks": "user-level list across the user's workspaces (explicit case below)",
    "my-recents": "user-level list across the user's workspaces (explicit case below)",
    "my-timer": "the user's own timer (explicit case below)",
    "my-timer-stop": "the user's own timer (explicit case below)",
    "integration-github-setup": "provider redirect, bound to a signed state, no user session",
    "integration-github-callback": "OAuth callback, bound to a signed state, no user session",
    "integration-gitlab-callback": "OAuth callback, bound to a signed state, no user session",
    "integration-fake-authorize": "the fake provider's authorize page (development), no workspace data",
    "webhook-github": "provider webhook: authenticated by HMAC signature, no user",
    "webhook-gitlab": "provider webhook: authenticated by its per-integration secret, no user",
    "workspace-stream": "server-sent events; covered by test_stream (404 for non-members) — needs Accept and streaming",
}


def _walk(patterns, prefix=""):
    for p in patterns:
        if isinstance(p, URLResolver):
            yield from _walk(p.url_patterns, prefix + str(p.pattern))
        else:
            yield prefix + str(p.pattern), p


def _in_scope(route: str, pattern) -> bool:
    if route.startswith(MODULE_PREFIXES):
        return True
    cls = getattr(pattern.callback, "cls", None)
    return pattern.name in CORE_RECORD_ROUTES or (cls is not None and issubclass(cls, ScopedView))


def _routes():
    out = []
    for route, pattern in _walk(get_resolver().url_patterns):
        if not route.startswith("api/v1/") or not _in_scope(route, pattern):
            continue
        cls = getattr(pattern.callback, "cls", None)
        for method in METHODS:
            if cls is not None and hasattr(cls, method):
                out.append(pytest.param(route, pattern.name, method, id=f"{pattern.name}-{method.upper()}"))
    return out


ROUTES = _routes()


def _sales_objects(w) -> dict:
    """Workspace B's sales records (built through the app registry: tracking never imports the sales module)."""
    if "sales" not in w.extra:
        get = apps.get_model
        owner = w.users["owner"]
        company = get("sales", "Company").objects.create(workspace=w.ws, owner=owner, name="Abay Trading")
        stage = get("sales", "PipelineStage").objects.create(workspace=w.ws, name="Discovery")
        opportunity = get("sales", "Opportunity").objects.create(
            workspace=w.ws, owner=owner, company=company, title="Abay deal", stage=stage
        )
        w.extra["sales"] = {
            "stage_id": stage.pk,
            "lead_id": get("sales", "Lead").objects.create(workspace=w.ws, owner=owner, contact_name="Abebe").pk,
            "opportunity_id": opportunity.pk,
            "quotation_id": get("sales", "Quotation")
            .objects.create(opportunity=opportunity, owner=owner, number="Q-2026-0001", title="Offer")
            .pk,
            "product_id": get("sales", "Product").objects.create(workspace=w.ws, name="Switch").pk,
            "lost_reason_id": get("sales", "LostReason").objects.create(workspace=w.ws, name="Price").pk,
            "holiday_id": get("sales", "Holiday").objects.create(workspace=w.ws, date="2026-09-11", name="New year").pk,
            "company_id": company.pk,
            "contact_id": get("sales", "Contact").objects.create(company=company, owner=owner, name="Hana").pk,
        }
        on_company = {"target_type": "sales.company", "target_id": company.pk, "target_company": company}
        w.extra["sales"]["activity_id"] = (
            get("sales", "Activity")
            .objects.create(workspace=w.ws, owner=owner, occurred_at=company.created_at, company=company, **on_company)
            .pk
        )
        w.extra["sales"]["follow_up_id"] = (
            get("sales", "FollowUp")
            .objects.create(
                workspace=w.ws, owner=owner, title="Call", due_date="2099-01-01", company=company, **on_company
            )
            .pk
        )
    return w.extra["sales"]


def _kwargs(name: str, route: str, w) -> dict:
    """URL kwargs that point at workspace B's objects."""
    items = {"objective": w.objective, "milestone": w.milestone, "epic": w.epic, "sprint": w.sprint}
    values = {
        "slug": w.ws.slug,
        "project_id": w.project.pk,
        "task_id": w.task.pk,
        "task_ref": str(w.task.pk),
        "request_id": w.access_request.pk,
        "status_id": w.status.pk,
        "label_id": w.label.pk,
        "field_id": w.field.pk,
        "view_id": w.view.pk,
        "import_id": w.import_job.pk,
        "entry_id": w.entry.pk,
        "dependency_id": w.dependency.pk,
        "sprint_id": w.sprint.pk,
        "dashboard_id": w.dashboard.pk,
        "integration_id": w.integration.pk,
        "repository_id": w.repository.pk,
        "link_id": str(w.dev_link.pk),
        "target_type": "tracking.task",
        "target_id": w.task.pk,
        "comment_id": w.comment.pk,
        "attachment_id": w.attachment.pk,
        "invite_id": w.invite.pk,
        "role_id": w.custom_role.pk,
        "team_id": w.team.pk,
        "session_id": uuid.uuid4(),
        "kind": "tracking.task",
        "user_id": w.users["pmember"].pk,
    }
    out = {}
    for kw in re.findall(r"<(?:\w+:)?(\w+)>", route):
        if kw == "item_id":
            entity = name.split("-")[0]
            out[kw] = items[entity].pk if entity in items else w.deleted_task.pk  # trash-item-restore
        elif kw == "key":
            out[kw] = {"workspace-module": "sales", "workspace-project-by-key": w.project.key}.get(name, w.task.key)
        elif kw in values:
            out[kw] = values[kw]
        elif route.startswith("api/v1/sales/") and kw in _sales_objects(w):
            out[kw] = _sales_objects(w)[kw]
        else:
            raise AssertionError(f"{name}: no tenant-isolation kwargs for {kw!r}; add them or list a skip")
    return out


def _shared_world():
    w = build_world()
    _sales_objects(w)  # created up front: a lazily added object would vanish with the first test's rollback
    return w


@pytest.fixture(scope="module")
def isolation_world(django_db_setup, django_db_blocker):
    """Built once for the module; every test runs in a savepoint and is rolled back to it."""
    with shared_world(django_db_blocker) as build:
        yield build(_shared_world)


@pytest.mark.django_db
@pytest.mark.parametrize(("route", "name", "method"), ROUTES)
def test_a_user_of_another_workspace_gets_404(isolation_world, route, name, method):
    if name in SKIPS:
        pytest.skip(SKIPS[name])
    w = isolation_world
    path = "/" + re.sub(r"<(?:\w+:)?(\w+)>", lambda m: str(_kwargs(name, route, w)[m.group(1)]), route)
    client = client_for(w.users["outsider"])  # owns workspace `elsewhere`, not a member of `platform`
    call = getattr(client, method)
    res = call(path) if method in ("get", "delete") else call(path, {}, format="json")
    assert res.status_code == 404, f"{name} {method.upper()} {path}: {res.status_code} {res.content[:200]!r}"


def test_the_walk_covers_the_module_and_core_routes():
    names = {p.values[1] for p in ROUTES}
    expected = {
        "project-detail",
        "task-detail",
        "sales-company-detail",
        "workspace-audit",
        "team-detail",
        "comment-detail",
    }
    assert {"sales-companies", "sales-contact-detail", "sales-stage-detail", "sales-settings"} <= names
    assert expected <= names
    assert len(ROUTES) > 150


@pytest.mark.django_db
def test_user_level_routes_never_show_another_workspace(isolation_world):
    """The explicit cases for the skipped user-level routes: B's tasks, recents and timer never reach A."""
    w = isolation_world
    outsider = client_for(w.users["outsider"])
    owner = client_for(w.users["owner"])
    owner.get(f"/api/v1/tracking/tasks/{w.task.pk}")  # puts the task in the owner's recents
    assert outsider.get("/api/v1/tracking/me/tasks").json()["data"] == []
    assert outsider.get("/api/v1/tracking/me/recents").json() == []
    assert outsider.get("/api/v1/tracking/me/timer").json()["timer"] is None
    assert outsider.post("/api/v1/tracking/me/timer/stop", {}, format="json").status_code in (200, 404, 409)
    assert owner.get("/api/v1/tracking/me/timer").json()["timer"] is not None  # B's timer still running


# ───────────────────────── models ─────────────────────────

#: Tables without a workspace, each with the reason (global by nature).
GLOBAL_MODELS = {
    "accounts.user": "users are global",
    "accounts.passwordresettoken": "per user",
    "access.permission": "the permission catalogue is global",
    "workspaces.workspace": "the tenant itself",
    "channels.telegramlinkrequest": "per-user channel connection (board 38)",
    "channels.telegramlinkfailure": "per Telegram chat",
    "channels.telegramconnection": "per-user channel connection",
    "channels.smsverification": "per-user channel connection",
    "channels.otpsend": "per-user OTP rate-limit log",
    "channels.smsconnection": "per-user channel connection",
    "channels.pushsubscription": "per-user device",
    "notifications.notificationpreference": "per-user preferences",
    "integrations.webhookdelivery": "inbound queue stored before its integration (and workspace) is known",
}
#: Tables with a workspace that don't use the scoped manager yet, each with the reason.
UNSCOPED_MODELS = {
    "channels.channeldelivery": "user-level delivery log; link messages have no workspace (nullable)",
    "realtime.realtimeevent": "BigAutoField stream log read by the SSE generator and LISTEN thread; filtered by "
    "workspace_id explicitly",
    "timetracking.runningtimer": "one timer per user across workspaces: its reads are per user",
}


def _our_models():
    return [m for m in apps.get_models() if m.__module__.startswith(("core.", "modules."))]


def test_every_module_and_platform_table_has_a_non_null_workspace():
    for model in _our_models():
        label = model._meta.label_lower
        if label in GLOBAL_MODELS:
            continue
        field = next((f for f in model._meta.fields if f.name == "workspace"), None)
        assert field is not None and field.is_relation, f"{label} has no workspace foreign key"
        assert not field.null or label == "channels.channeldelivery", f"{label}.workspace is nullable"


def test_workspace_tables_use_the_scoped_manager():
    for model in _our_models():
        label = model._meta.label_lower
        if label in GLOBAL_MODELS or label in UNSCOPED_MODELS:
            continue
        assert issubclass(model, WorkspaceScopedMixin), f"{label} is not a WorkspaceScopedModel"
        assert hasattr(model._default_manager, "for_workspace"), label


@pytest.mark.django_db
def test_scoped_manager_policy(isolation_world):
    from modules.tracking.tasks.models import Task

    w = isolation_world
    with scoping.strict():
        with pytest.raises(scoping.UnscopedQueryError):
            Task.objects.filter(pk=w.task.pk).exists()
        assert Task.objects.for_workspace(w.ws).filter(pk=w.task.pk).exists()
        assert not Task.objects.for_workspace(w.other_ws).filter(pk=w.task.pk).exists()
        assert Task.objects.unscoped().filter(pk=w.task.pk).exists()
        with scoping.workspace_context(w.other_ws):
            assert not Task.objects.filter(pk=w.task.pk).exists()  # filtered to the context's workspace
            assert not w.project.tasks.exists()  # related managers too
        with scoping.workspace_context(w.ws):
            assert Task.objects.filter(pk=w.task.pk).exists()
        with scoping.unscoped():
            assert Task.objects.filter(pk=w.task.pk).exists()
        # Writes name or derive their workspace and skip the read policy; children take their parent's workspace.
        from modules.tracking.projects.models import Label

        label = Label.objects.create(project=w.project, name="derived")
        assert label.workspace_id == w.ws.pk
        assert w.task.workspace_id == w.project.workspace_id


@override_settings(WORKSPACE_SCOPE_DEFAULT="strict")
def test_outside_a_request_the_default_is_strict():
    from modules.tracking.tasks.models import Task

    with pytest.raises(scoping.UnscopedQueryError):
        Task.objects.all()
    assert str(Task.objects.unscoped().query)  # the escape hatch builds a query without touching the database
