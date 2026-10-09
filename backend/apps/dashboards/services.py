"""Dashboard reads and writes (docs/v2/33-dashboards-presence.md §4.3, §5.2, §6).

Object rules: a personal dashboard of someone else is 404, never 403. Editing needs ownership plus
`dashboard.create`, or a shared dashboard plus `dashboard.manage`. Every write bumps `version` once, is audited
(audit-only, not in activity feeds) and publishes `dashboard.changed` after commit.
"""

from __future__ import annotations

import uuid
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.db.models.functions import Lower

from apps.access import services as access
from apps.audit.services import change, record
from apps.common.exceptions import ApiError, conflict, forbidden, invalid, not_found
from apps.common.utils import iso
from apps.projects.models import Project
from apps.projects.selectors import project_for, project_in_workspace

from . import widgets as W
from .models import Dashboard, DashboardWidget

SHARED_LIMIT = 20
PERSONAL_LIMIT = 10
MAX_NAME = 60
SHARED_LIMIT_MESSAGE = "A project can have up to 20 shared dashboards."
PERSONAL_LIMIT_MESSAGE = "You can have up to 10 personal dashboards in a project."


# ───────────────────────── rules (§4.3) ─────────────────────────


def can_view(user: Any, dashboard: Dashboard) -> bool:
    return access.can(user, "project.view", dashboard.project) and (
        dashboard.visibility == "shared" or dashboard.owner_id == user.pk
    )


def can_edit(user: Any, dashboard: Dashboard) -> bool:
    project = dashboard.project
    return (dashboard.owner_id == user.pk and access.can(user, "dashboard.create", project)) or (
        dashboard.visibility == "shared" and access.can(user, "dashboard.manage", project)
    )


def can_change_visibility(user: Any, dashboard: Dashboard) -> bool:
    return dashboard.owner_id == user.pk and access.can(user, "dashboard.create", dashboard.project)


def _edit_code(user: Any, dashboard: Dashboard) -> str:
    return (
        "dashboard.manage" if dashboard.visibility == "shared" and dashboard.owner_id != user.pk else "dashboard.create"
    )


def require_edit(user: Any, dashboard: Dashboard) -> None:
    if not can_edit(user, dashboard):
        raise forbidden("You can’t edit this dashboard.", {"permission": _edit_code(user, dashboard)})


def _uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def dashboard_for(user: Any, dashboard_id: Any) -> Dashboard:
    """Unknown, another workspace's or someone else's personal dashboard → 404; a shared dashboard in a project
    the caller isn't on → v1 403 `project_membership_required`."""
    dashboard = (
        Dashboard.objects.select_related("project", "owner").filter(pk=dashboard_id).first()
        if _uuid(dashboard_id)
        else None
    )
    if dashboard is None or (dashboard.visibility == "personal" and dashboard.owner_id != user.pk):
        raise not_found("Dashboard not found.")
    try:
        project_in_workspace(user, dashboard.project_id)
    except ApiError as exc:
        raise not_found("Dashboard not found.") from exc
    dashboard.project = project_for(user, dashboard.project_id)
    return dashboard


# ───────────────────────── reads ─────────────────────────


def owner_data(user: Any) -> dict[str, Any]:
    return {"id": str(user.pk), "name": user.name, "hue": user.hue, "avatarUrl": user.avatar_url}


def dashboard_data(dashboard: Dashboard, refs: W.Refs | None = None) -> dict[str, Any]:
    refs = refs or W.Refs.for_project(dashboard.project_id)
    items = sorted(dashboard.widgets.all(), key=lambda x: x.position)
    return {
        "id": str(dashboard.pk),
        "projectId": str(dashboard.project_id),
        "name": dashboard.name,
        "visibility": dashboard.visibility,
        "ownerId": str(dashboard.owner_id),
        "owner": owner_data(dashboard.owner),
        "version": dashboard.version,
        "widgets": [
            {"id": str(x.pk), "type": x.type, "w": x.w, "h": x.h, "config": W.read_config(x.type, x.config, refs)}
            for x in items
        ],
        "createdAt": iso(dashboard.created_at),
        "updatedAt": iso(dashboard.updated_at),
    }


def current_payload(dashboard: Dashboard) -> dict[str, Any]:
    fresh = Dashboard.objects.select_related("owner").prefetch_related("widgets").get(pk=dashboard.pk)
    return dashboard_data(fresh)


def summaries(user: Any, project: Project) -> list[dict[str, Any]]:
    """DB1: shared dashboards (name A–Z), then the caller's personal ones (name A–Z)."""
    rows = (
        Dashboard.objects.filter(project=project)
        .filter(Q(visibility="shared") | Q(visibility="personal", owner_id=user.pk))
        .annotate(widget_count=Count("widgets"), lname=Lower("name"))
        .order_by("-visibility", "lname", "name")  # "shared" sorts after "personal"; descending puts it first
    )
    return [
        {
            "id": str(d.pk),
            "projectId": str(d.project_id),
            "name": d.name,
            "visibility": d.visibility,
            "ownerId": str(d.owner_id),
            "widgetCount": d.widget_count,
            "updatedAt": iso(d.updated_at),
        }
        for d in rows
    ]


# ───────────────────────── validation ─────────────────────────


def _clean_name(raw: Any, project: Any, owner_id: Any, exclude: Any = None) -> str:
    name = raw.strip() if isinstance(raw, str) else ""
    if not name:
        raise invalid({"name": "Name is required"})
    if len(name) > MAX_NAME:
        raise invalid({"name": "Up to 60 characters"})
    taken = Dashboard.objects.filter(project=project, owner_id=owner_id, name__iexact=name)
    if exclude is not None:
        taken = taken.exclude(pk=exclude)
    if taken.exists():
        raise invalid({"name": "You already have a dashboard with this name"})
    return name


def _check_limit(project: Any, visibility: str, owner_id: Any) -> None:
    if visibility == "shared":
        if Dashboard.objects.filter(project=project, visibility="shared").count() >= SHARED_LIMIT:
            raise conflict("dashboard_limit", SHARED_LIMIT_MESSAGE)
    elif Dashboard.objects.filter(project=project, visibility="personal", owner_id=owner_id).count() >= PERSONAL_LIMIT:
        raise conflict("dashboard_limit", PERSONAL_LIMIT_MESSAGE)


def _check_version(dashboard: Dashboard, version: Any) -> None:
    if isinstance(version, bool) or not isinstance(version, int):
        raise invalid({"version": "Send the version you edited"})
    if version != dashboard.version:
        raise conflict(
            "version_conflict", "Someone else changed this dashboard.", {"current": current_payload(dashboard)}
        )


def _int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _clean_layout(
    user: Any, dashboard: Dashboard, raw: Any, existing: dict[str, DashboardWidget]
) -> list[dict[str, Any]]:
    """DB5: the complete ordered list → [{"id": existing id | None, type, w, h, config}] (§5.2 messages)."""
    if not isinstance(raw, list):
        raise invalid({"widgets": "Send a list of widgets"})
    if len(raw) > W.MAX_WIDGETS:
        raise invalid({"widgets": "Up to 6 widgets"})
    refs = W.Refs.for_project(dashboard.project_id)
    can_report = access.can(user, "report.view", dashboard.project)
    errors: dict[str, str] = {}
    seen_types: set[str] = set()
    seen_ids: set[str] = set()
    out: list[dict[str, Any]] = []
    for i, item in enumerate(raw):
        it = item if isinstance(item, dict) else {}
        path = f"widgets.{i}"
        raw_id = it.get("id")
        widget_type = it.get("type")
        current = existing.get(str(raw_id)) if isinstance(raw_id, str) else None
        if raw_id is not None and (current is None or str(current.pk) in seen_ids):
            errors[f"{path}.id"] = "Unknown widget"
        if widget_type not in W.WIDGET_TYPES:
            errors[f"{path}.type"] = "Pick a widget type"
            continue
        if current is not None and current.type != widget_type:
            errors[f"{path}.type"] = "A widget’s type can’t be changed"
        if current is None and W.WIDGET_NEEDS[widget_type] == "report.view" and not can_report:
            errors[f"{path}.type"] = "You can’t view this report"
        if widget_type in seen_types:
            errors["widgets"] = "Each widget type can appear once"
        seen_types.add(widget_type)
        if current is not None:
            seen_ids.add(str(current.pk))
        w, h = _int(it.get("w")), _int(it.get("h"))
        if w is None or not W.MIN_W <= w <= W.MAX_W:
            errors[f"{path}.w"] = "Width is 3 to 12 columns"
        if h is None or not 1 <= h <= W.MAX_H:
            errors[f"{path}.h"] = "Height is 1 to 4 rows"
        elif h < W.MIN_H[widget_type]:
            errors[f"{path}.h"] = f"{W.WIDGET_NAME[widget_type]} needs at least {W.MIN_H[widget_type]} rows"
        config = W.clean_config(widget_type, it.get("config"), refs, f"{path}.config", errors)
        out.append({"current": current, "type": widget_type, "w": w, "h": h, "config": config})
    if errors:
        raise invalid(errors)
    return out


# ───────────────────────── writes ─────────────────────────


def _audit(dashboard: Dashboard, actor: Any, action: str, *, changes=None, data=None) -> None:
    record(
        workspace=dashboard.project.workspace_id,
        project=dashboard.project_id,
        actor=actor,
        action=action,
        target=dashboard.name,
        entity_id=dashboard.pk,
        entity_key=dashboard.project.key,
        changes=changes,
        data=data,
    )


def _publish(dashboard: Dashboard, actor: Any, op: str, *, visibility: str | None = None) -> None:
    """`dashboard.changed`: shared → project members; personal → the owner only (§2.4)."""
    from apps.realtime.services import publish

    visibility = visibility or dashboard.visibility
    publish(
        "dashboard.changed",
        workspace=dashboard.project.workspace_id,
        project=dashboard.project_id,
        user=dashboard.owner_id if visibility == "personal" else None,
        actor=actor,
        data={"dashboardId": str(dashboard.pk), "op": op, "version": None if op == "deleted" else dashboard.version},
    )


def _layout_summary(dashboard: Dashboard) -> list[str]:
    return [f"{x.type}:{x.w}x{x.h}" for x in dashboard.widgets.order_by("position")]


@transaction.atomic
def create_dashboard(actor: Any, project: Project, data: dict[str, Any]) -> Dashboard:
    if not access.can(actor, "dashboard.create", project):
        raise forbidden(details={"permission": "dashboard.create"})
    project = Project.objects.select_for_update().get(pk=project.pk)  # serialises the limit checks
    visibility = data.get("visibility", "shared")
    template = data.get("template", "blank")
    errors = {}
    if visibility not in ("shared", "personal"):
        errors["visibility"] = "Pick shared or personal"
    if template not in ("blank", "sprint_health"):
        errors["template"] = "Pick blank or sprint_health"
    if errors:
        raise invalid(errors)
    name = _clean_name(data.get("name"), project, actor.pk)
    _check_limit(project, visibility, actor.pk)
    try:
        with transaction.atomic():
            dashboard = Dashboard.objects.create(project=project, owner=actor, name=name, visibility=visibility)
    except IntegrityError as exc:  # a concurrent create with the same name
        raise invalid({"name": "You already have a dashboard with this name"}) from exc
    if template == "sprint_health":
        perms = access.project_permissions(actor, project)
        types = [t for t in W.SPRINT_HEALTH if W.WIDGET_NEEDS[t] in perms]
        DashboardWidget.objects.bulk_create(
            [
                DashboardWidget(
                    dashboard=dashboard,
                    type=t,
                    position=i,
                    w=W.DEFAULT_SIZE[t][0],
                    h=W.DEFAULT_SIZE[t][1],
                    config=W.default_config(t),
                )
                for i, t in enumerate(types)
            ]
        )
    _audit(dashboard, actor, "dashboard.created", data={"visibility": visibility, "template": template})
    _publish(dashboard, actor, "created")
    return dashboard


@transaction.atomic
def update_dashboard(actor: Any, dashboard: Dashboard, data: dict[str, Any]) -> Dashboard:
    """DB4: rename and/or change visibility (owner only). `version` is required."""
    project = dashboard.project
    dashboard = Dashboard.objects.select_for_update().select_related("owner").get(pk=dashboard.pk)
    dashboard.project = project
    require_edit(actor, dashboard)
    _check_version(dashboard, data.get("version"))
    changes = []
    before_visibility = dashboard.visibility
    visibility = data.get("visibility", dashboard.visibility)
    if "visibility" in data:
        if visibility not in ("shared", "personal"):
            raise invalid({"visibility": "Pick shared or personal"})
        if visibility != dashboard.visibility:
            if not can_change_visibility(actor, dashboard):
                raise forbidden(
                    "Only the owner can change who sees this dashboard.", {"permission": "dashboard.create"}
                )
            _check_limit(project, visibility, dashboard.owner_id)
    if "name" in data:
        name = _clean_name(data.get("name"), project, dashboard.owner_id, exclude=dashboard.pk)
        if name != dashboard.name:
            changes.append(change("Name", dashboard.name, name))
            dashboard.name = name
    if visibility != dashboard.visibility:
        changes.append(change("Visibility", dashboard.visibility, visibility))
        dashboard.visibility = visibility
    dashboard.version += 1
    try:
        with transaction.atomic():
            dashboard.save()
    except IntegrityError as exc:
        raise invalid({"name": "You already have a dashboard with this name"}) from exc
    if changes:
        _audit(dashboard, actor, "dashboard.updated", changes=changes)
    if before_visibility != dashboard.visibility:
        _publish(dashboard, actor, "updated", visibility=before_visibility)  # whoever could see it before
    _publish(dashboard, actor, "updated")
    return dashboard


@transaction.atomic
def save_layout(actor: Any, dashboard: Dashboard, data: dict[str, Any]) -> Dashboard:
    """DB5: replace the ordered widget list (update by id, create without id, delete the missing ones)."""
    project = dashboard.project
    dashboard = Dashboard.objects.select_for_update().select_related("owner").get(pk=dashboard.pk)
    dashboard.project = project
    require_edit(actor, dashboard)
    _check_version(dashboard, data.get("version"))
    existing = {str(x.pk): x for x in DashboardWidget.objects.filter(dashboard=dashboard)}
    plan = _clean_layout(actor, dashboard, data.get("widgets"), existing)
    kept = {str(p["current"].pk) for p in plan if p["current"] is not None}
    DashboardWidget.objects.filter(dashboard=dashboard).exclude(pk__in=kept).delete()
    for position, p in enumerate(plan):
        current = p["current"]
        if current is None:
            DashboardWidget.objects.create(
                dashboard=dashboard, type=p["type"], position=position, w=p["w"], h=p["h"], config=p["config"]
            )
        else:
            current.position, current.w, current.h, current.config = position, p["w"], p["h"], p["config"]
            current.save(update_fields=["position", "w", "h", "config", "updated_at"])
    dashboard.version += 1
    dashboard.save(update_fields=["version", "updated_at"])
    _audit(dashboard, actor, "dashboard.layout_updated", data={"widgets": _layout_summary(dashboard)})
    _publish(dashboard, actor, "layout")
    return dashboard


@transaction.atomic
def delete_dashboard(actor: Any, dashboard: Dashboard) -> None:
    require_edit(actor, dashboard)
    count = dashboard.widgets.count()
    _audit(dashboard, actor, "dashboard.deleted", data={"visibility": dashboard.visibility, "widgets": count})
    _publish(dashboard, actor, "deleted")
    dashboard.delete()


def delete_personal_for_member(project: Any, user_id: Any) -> None:
    """A user removed from a project loses their personal dashboards there; their shared ones stay (§3.2)."""
    Dashboard.objects.filter(project=project, owner_id=user_id, visibility="personal").delete()
