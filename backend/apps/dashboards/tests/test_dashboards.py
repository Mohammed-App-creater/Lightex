"""Dashboards DB1–DB6 (docs/v2/33-dashboards-presence.md §3.2, §3.3, §4.3, §5.2, §6.1)."""

import itertools

import pytest
from django.db import IntegrityError, transaction

from apps.access.models import Permission, Role, RolePermission
from apps.audit.models import AuditLog
from apps.common.testing import UserFactory, add_member, add_project_member, client_for, make_project
from apps.dashboards import services
from apps.dashboards.models import Dashboard, DashboardWidget
from apps.planning.models import Sprint
from apps.realtime.models import RealtimeEvent

pytestmark = pytest.mark.django_db

SPRINT_HEALTH = [
    ("burndown", 6, 2, {"sprintId": None}),
    ("my_tasks", 3, 2, {"showDone": True}),
    ("objectives", 3, 2, {"quarter": None}),
    ("workload", 6, 2, {"unit": "points", "sprintId": None, "personField": None}),
    ("velocity", 3, 2, {"range": "last6"}),
    ("activity", 3, 2, {}),
]


class World:
    def __init__(self, ws, owner):
        self.ws, self.owner = ws, owner
        self.project = make_project(ws, owner, key="PRJ")
        self.manager = add_project_member(self.project, key="manager")
        self.sam = add_project_member(self.project, key="project_member")
        self.viewer = add_project_member(self.project, key="viewer")
        self.outsider = add_member(ws, UserFactory(), "member")  # in the workspace, not on the project
        self.url = f"/api/v1/projects/{self.project.pk}/dashboards"


@pytest.fixture
def w(ws, owner):
    return World(ws, owner)


def create(user, w, **body):
    return client_for(user).post(w.url, {"name": "Sprint 14 health", "visibility": "shared", **body}, format="json")


def layout(user, d, widgets, version=None):
    version = d["version"] if version is None else version
    return client_for(user).put(
        f"/api/v1/dashboards/{d['id']}/layout", {"version": version, "widgets": widgets}, format="json"
    )


def _widgets(body):
    return [(x["type"], x["w"], x["h"], x["config"]) for x in body["widgets"]]


# ── models ──


def test_constraints(w):
    d = Dashboard.objects.create(project=w.project, owner=w.owner, name="Health", visibility="shared")
    with pytest.raises(IntegrityError), transaction.atomic():
        Dashboard.objects.create(project=w.project, owner=w.owner, name="HEALTH", visibility="personal")
    Dashboard.objects.create(project=w.project, owner=w.sam, name="Health", visibility="personal")  # another owner
    DashboardWidget.objects.create(dashboard=d, type="burndown", position=0, w=6, h=2)
    for bad in (
        {"type": "burndown", "position": 1, "w": 6, "h": 2},
        {"type": "velocity", "position": 2, "w": 2, "h": 2},
        {"type": "velocity", "position": 2, "w": 13, "h": 2},
        {"type": "velocity", "position": 2, "w": 3, "h": 5},
        {"type": "velocity", "position": 2, "w": 3, "h": 0},
    ):
        with pytest.raises(IntegrityError), transaction.atomic():
            DashboardWidget.objects.create(dashboard=d, **bad)
    with pytest.raises(IntegrityError), transaction.atomic():  # positions are unique (checked at commit)
        DashboardWidget.objects.create(dashboard=d, type="velocity", position=0, w=3, h=2)
        DashboardWidget.objects.filter(dashboard=d).count()
        from django.db import connection

        connection.cursor().execute("SET CONSTRAINTS ALL IMMEDIATE")


# ── DB2 create ──


def test_create_sprint_health(w):
    res = create(w.manager, w, template="sprint_health")
    assert res.status_code == 201, res.content
    body = res.json()
    assert body["version"] == 1 and body["visibility"] == "shared" and body["ownerId"] == str(w.manager.pk)
    assert body["owner"] == {"id": str(w.manager.pk), "name": w.manager.name, "hue": w.manager.hue, "avatarUrl": None}
    assert body["projectId"] == str(w.project.pk) and body["createdAt"] and body["updatedAt"]
    assert _widgets(body) == [(t, ww, h, c) for t, ww, h, c in SPRINT_HEALTH]
    row = AuditLog.objects.get(action="dashboard.created")
    assert (row.target, row.data, row.project_id) == (
        "Sprint 14 health",
        {"visibility": "shared", "template": "sprint_health"},
        w.project.pk,
    )


def test_create_blank_personal_trims_the_name(w):
    res = create(w.sam, w, name="  My focus  ", visibility="personal")
    assert res.status_code == 201
    assert (res.json()["name"], res.json()["visibility"], res.json()["widgets"]) == ("My focus", "personal", [])


def test_templates_skip_widgets_the_creator_cannot_read(w):
    role = Role.objects.create(workspace=w.ws, name="Board keeper", scope="project")
    for code in ("project.view", "dashboard.create"):
        RolePermission.objects.create(role=role, permission=Permission.objects.get(code=code))
    keeper = add_project_member(w.project)
    keeper.project_memberships.filter(project=w.project).update(role=role)
    res = create(keeper, w, template="sprint_health")
    assert res.status_code == 201
    assert [x["type"] for x in res.json()["widgets"]] == ["my_tasks", "activity"]


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({"name": ""}, {"name": "Name is required"}),
        ({"name": "   "}, {"name": "Name is required"}),
        ({"name": 12}, {"name": "Name is required"}),
        ({"name": "x" * 61}, {"name": "Up to 60 characters"}),
        ({"visibility": "team"}, {"visibility": "Pick shared or personal"}),
        ({"template": "fancy"}, {"template": "Pick blank or sprint_health"}),
        (
            {"visibility": "x", "template": "y"},
            {"visibility": "Pick shared or personal", "template": "Pick blank or sprint_health"},
        ),
    ],
)
def test_create_validation(w, body, fields):
    res = create(w.sam, w, **body)
    assert res.status_code == 422
    assert res.json()["details"]["fields"] == fields


def test_create_duplicate_name_per_owner(w):
    create(w.sam, w, name="Focus", visibility="personal")
    res = create(w.sam, w, name="FOCUS")
    assert res.json()["details"]["fields"] == {"name": "You already have a dashboard with this name"}
    assert create(w.manager, w, name="Focus").status_code == 201


def test_create_limits(w):
    for i in range(services.SHARED_LIMIT):
        Dashboard.objects.create(project=w.project, owner=w.manager, name=f"S{i}", visibility="shared")
    res = create(w.sam, w, name="One more")
    assert res.status_code == 409
    assert res.json() == {
        "code": "dashboard_limit",
        "message": "A project can have up to 20 shared dashboards.",
        "details": {},
    }
    for i in range(services.PERSONAL_LIMIT):
        Dashboard.objects.create(project=w.project, owner=w.sam, name=f"P{i}", visibility="personal")
    res = create(w.sam, w, name="One more", visibility="personal")
    assert res.status_code == 409
    assert res.json()["message"] == "You can have up to 10 personal dashboards in a project."
    assert create(w.manager, w, name="Mine", visibility="personal").status_code == 201  # the limit is per user


def test_create_needs_the_permission(w):
    res = create(w.viewer, w)
    assert res.status_code == 403 and res.json()["details"] == {"permission": "dashboard.create"}
    assert create(w.outsider, w).json()["code"] == "project_membership_required"


def test_archived_projects_are_view_only(w):
    d = create(w.owner, w, template="sprint_health").json()
    client_for(w.owner).post(f"/api/v1/projects/{w.project.pk}/archive")
    assert create(w.owner, w, name="New").status_code == 403
    owner = client_for(w.owner)
    assert owner.get(f"/api/v1/dashboards/{d['id']}").status_code == 200
    assert owner.get(w.url).status_code == 200
    assert owner.patch(f"/api/v1/dashboards/{d['id']}", {"name": "X", "version": 1}, format="json").status_code == 403
    assert layout(w.owner, d, []).status_code == 403
    assert owner.delete(f"/api/v1/dashboards/{d['id']}").status_code == 403


# ── DB1 list, DB3 read ──


def test_list_shared_then_my_personal_ones_by_name(w):
    for owner, name, vis in [
        (w.manager, "zeta", "shared"), (w.owner, "Alpha", "shared"), (w.sam, "mine B", "personal"),
        (w.sam, "Mine a", "personal"), (w.manager, "Not yours", "personal"),
    ]:  # fmt: skip
        Dashboard.objects.create(project=w.project, owner=owner, name=name, visibility=vis)
    d = Dashboard.objects.get(name="Alpha")
    DashboardWidget.objects.create(dashboard=d, type="activity", position=0, w=3, h=1)
    body = client_for(w.sam).get(w.url).json()
    assert [x["name"] for x in body] == ["Alpha", "zeta", "Mine a", "mine B"]
    assert body[0] == {
        "id": str(d.pk), "projectId": str(w.project.pk), "name": "Alpha", "visibility": "shared",
        "ownerId": str(w.owner.pk), "widgetCount": 1, "updatedAt": body[0]["updatedAt"],
    }  # fmt: skip
    assert client_for(w.outsider).get(w.url).status_code == 403


def test_read_rules(w, ws):
    shared = create(w.sam, w, name="Team").json()
    personal = create(w.sam, w, name="Mine", visibility="personal").json()
    assert client_for(w.viewer).get(f"/api/v1/dashboards/{shared['id']}").status_code == 200
    res = client_for(w.owner).get(f"/api/v1/dashboards/{personal['id']}")
    assert res.status_code == 404 and res.json()["message"] == "Dashboard not found."
    assert client_for(w.sam).get(f"/api/v1/dashboards/{personal['id']}").status_code == 200
    res = client_for(w.outsider).get(f"/api/v1/dashboards/{shared['id']}")
    assert res.status_code == 403 and res.json()["code"] == "project_membership_required"
    assert client_for(w.outsider).get(f"/api/v1/dashboards/{personal['id']}").status_code == 404
    stranger = UserFactory()
    assert client_for(stranger).get(f"/api/v1/dashboards/{shared['id']}").status_code == 404
    assert client_for(w.sam).get("/api/v1/dashboards/00000000-0000-0000-0000-000000000000").status_code == 404


def test_deleted_references_fall_back_to_defaults_on_read(w):
    sprint = Sprint.objects.create(
        project=w.project, name="Sprint 3", number=3, start_date="2026-10-01", end_date="2026-10-14"
    )
    d = create(w.owner, w).json()
    res = layout(w.owner, d, [{"type": "burndown", "w": 6, "h": 2, "config": {"sprintId": str(sprint.pk)}}])
    assert res.json()["widgets"][0]["config"] == {"sprintId": str(sprint.pk)}
    sprint.delete()
    assert client_for(w.owner).get(f"/api/v1/dashboards/{d['id']}").json()["widgets"][0]["config"] == {"sprintId": None}


# ── DB4 update ──


def test_rename_and_visibility(w):
    d = create(w.sam, w, name="Team").json()
    sam = client_for(w.sam)
    res = sam.patch(
        f"/api/v1/dashboards/{d['id']}",
        {"name": "Release health", "visibility": "personal", "version": 1},
        format="json",
    )
    assert res.status_code == 200, res.content
    assert (res.json()["name"], res.json()["visibility"], res.json()["version"]) == ("Release health", "personal", 2)
    row = AuditLog.objects.get(action="dashboard.updated")
    assert [(c["field"], c["before"], c["after"]) for c in row.changes] == [
        ("Name", "Team", "Release health"), ("Visibility", "shared", "personal"),
    ]  # fmt: skip


def test_update_needs_a_version_and_detects_conflicts(w):
    d = create(w.sam, w).json()
    sam = client_for(w.sam)
    res = sam.patch(f"/api/v1/dashboards/{d['id']}", {"name": "x"}, format="json")
    assert res.status_code == 422 and res.json()["details"]["fields"] == {"version": "Send the version you edited"}
    sam.patch(f"/api/v1/dashboards/{d['id']}", {"name": "y", "version": 1}, format="json")
    res = sam.patch(f"/api/v1/dashboards/{d['id']}", {"name": "z", "version": 1}, format="json")
    assert res.status_code == 409 and res.json()["code"] == "version_conflict"
    current = res.json()["details"]["current"]
    assert (current["name"], current["version"]) == ("y", 2)


def test_only_the_owner_changes_visibility(w):
    d = create(w.sam, w).json()
    res = client_for(w.manager).patch(
        f"/api/v1/dashboards/{d['id']}", {"visibility": "personal", "version": 1}, format="json"
    )
    assert res.status_code == 403
    assert res.json()["message"] == "Only the owner can change who sees this dashboard."
    assert res.json()["details"] == {"permission": "dashboard.create"}
    res = client_for(w.manager).patch(f"/api/v1/dashboards/{d['id']}", {"name": "Managed", "version": 1}, format="json")
    assert res.status_code == 200  # dashboard.manage edits a shared one
    res = client_for(w.manager).patch(
        f"/api/v1/dashboards/{d['id']}", {"visibility": "shared", "version": 2}, format="json"
    )
    assert res.status_code == 200  # unchanged visibility is not a visibility change


def test_update_validation_and_name_rules(w):
    d = create(w.sam, w, name="One").json()
    create(w.sam, w, name="Two")
    sam = client_for(w.sam)
    url = f"/api/v1/dashboards/{d['id']}"
    assert sam.patch(url, {"visibility": "x", "version": 1}, format="json").json()["details"]["fields"] == {
        "visibility": "Pick shared or personal"
    }
    res = sam.patch(url, {"name": "two", "version": 1}, format="json")
    assert res.json()["details"]["fields"] == {"name": "You already have a dashboard with this name"}
    assert sam.patch(url, {"name": "ONE", "version": 1}, format="json").status_code == 200  # its own name


def test_visibility_change_respects_the_limits(w):
    for i in range(services.PERSONAL_LIMIT):
        Dashboard.objects.create(project=w.project, owner=w.sam, name=f"P{i}", visibility="personal")
    d = create(w.sam, w, name="Shared one").json()
    res = client_for(w.sam).patch(
        f"/api/v1/dashboards/{d['id']}", {"visibility": "personal", "version": 1}, format="json"
    )
    assert res.status_code == 409 and res.json()["code"] == "dashboard_limit"


# ── DB5 layout ──


def test_layout_creates_updates_deletes_and_orders(w):
    d = create(w.manager, w, template="sprint_health").json()
    ids = {x["type"]: x["id"] for x in d["widgets"]}
    res = layout(
        w.manager,
        d,
        [
            {"id": ids["burndown"], "type": "burndown", "w": 12, "h": 2, "config": {"sprintId": None, "junk": 1}},
            {"id": ids["objectives"], "type": "objectives", "w": 3, "h": 1, "config": {"quarter": "Q4"}},
            {"type": "velocity", "w": 3, "h": 2, "config": {}},
        ],
    )
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["version"] == 2
    assert _widgets(body) == [
        ("burndown", 12, 2, {"sprintId": None}),
        ("objectives", 3, 1, {"quarter": "Q4"}),
        ("velocity", 3, 2, {"range": "last6"}),
    ]
    assert body["widgets"][0]["id"] == ids["burndown"] and body["widgets"][2]["id"] != ids["velocity"]
    assert DashboardWidget.objects.filter(dashboard_id=d["id"]).count() == 3
    rows = AuditLog.objects.filter(action="dashboard.layout_updated")
    assert rows.count() == 1
    assert rows.get().data == {"widgets": ["burndown:12x2", "objectives:3x1", "velocity:3x2"]}
    # reorder only
    res = layout(w.manager, body, [{**x} for x in reversed(body["widgets"])])
    assert [x["type"] for x in res.json()["widgets"]] == ["velocity", "objectives", "burndown"]
    assert res.json()["version"] == 3


def test_layout_version_is_checked_first(w):
    d = create(w.manager, w).json()
    res = layout(w.manager, d, "junk", version=7)
    assert res.status_code == 409 and res.json()["details"]["current"]["version"] == 1


ROW = {"type": "velocity", "w": 3, "h": 2}


@pytest.mark.parametrize(
    ("widgets", "fields"),
    [
        ("nope", {"widgets": "Send a list of widgets"}),
        ([ROW] * 7, {"widgets": "Up to 6 widgets"}),
        ([ROW, ROW], {"widgets": "Each widget type can appear once"}),
        ([{**ROW, "id": "00000000-0000-0000-0000-000000000000"}], {"widgets.0.id": "Unknown widget"}),
        ([{**ROW, "type": "pie"}], {"widgets.0.type": "Pick a widget type"}),
        ([{**ROW, "w": 2}], {"widgets.0.w": "Width is 3 to 12 columns"}),
        ([{**ROW, "w": 13}], {"widgets.0.w": "Width is 3 to 12 columns"}),
        ([{**ROW, "w": "6"}], {"widgets.0.w": "Width is 3 to 12 columns"}),
        ([{**ROW, "w": True}], {"widgets.0.w": "Width is 3 to 12 columns"}),
        ([{**ROW, "h": 5}], {"widgets.0.h": "Height is 1 to 4 rows"}),
        ([{**ROW, "h": 0}], {"widgets.0.h": "Height is 1 to 4 rows"}),
        ([{**ROW, "h": 1}], {"widgets.0.h": "Velocity needs at least 2 rows"}),
        ([{"type": "burndown", "w": 6, "h": 1}], {"widgets.0.h": "Burndown needs at least 2 rows"}),
        ([{"type": "workload", "w": 6, "h": 1}], {"widgets.0.h": "Workload by person needs at least 2 rows"}),
        (
            [{"type": "burndown", "w": 6, "h": 2, "config": {"sprintId": "x"}}],
            {"widgets.0.config.sprintId": "Pick a sprint from this project"},
        ),
        (
            [{"type": "my_tasks", "w": 3, "h": 1, "config": {"showDone": "yes"}}],
            {"widgets.0.config.showDone": "Use true or false"},
        ),
        (
            [{"type": "objectives", "w": 3, "h": 1, "config": {"quarter": "Q" * 17}}],
            {"widgets.0.config.quarter": "Up to 16 characters"},
        ),
        (
            [{"type": "workload", "w": 6, "h": 2, "config": {"unit": "days"}}],
            {"widgets.0.config.unit": "Pick points or hours"},
        ),
        (
            [{"type": "workload", "w": 6, "h": 2, "config": {"personField": "x"}}],
            {"widgets.0.config.personField": "Pick a person field from this project"},
        ),
        ([{**ROW, "config": {"range": "last90"}}], {"widgets.0.config.range": "Pick last2 or last6"}),
        ([{"type": "my_tasks", "w": 3, "h": 1}, {**ROW, "w": 1}], {"widgets.1.w": "Width is 3 to 12 columns"}),
    ],
)
def test_layout_validation(w, widgets, fields):
    d = create(w.manager, w).json()
    res = layout(w.manager, d, widgets)
    assert res.status_code == 422, res.content
    assert res.json()["details"]["fields"] == fields


def test_layout_type_and_id_rules(w):
    d = create(w.manager, w, template="sprint_health").json()
    ids = {x["type"]: x["id"] for x in d["widgets"]}
    res = layout(w.manager, d, [{"id": ids["velocity"], "type": "activity", "w": 3, "h": 2}])
    assert res.json()["details"]["fields"] == {"widgets.0.type": "A widget’s type can’t be changed"}
    same = {"id": ids["velocity"], **ROW}
    res = layout(w.manager, d, [same, same])
    assert res.json()["details"]["fields"]["widgets.1.id"] == "Unknown widget"
    other = create(w.manager, w, name="Other", template="sprint_health").json()
    foreign = {"id": other["widgets"][0]["id"], "type": "burndown", "w": 6, "h": 2}
    assert layout(w.manager, d, [foreign]).json()["details"]["fields"] == {"widgets.0.id": "Unknown widget"}


def test_person_field_and_sprint_configs_from_this_project(w):
    from apps.projects.custom_fields import create_field

    person = create_field(w.owner, w.project, {"name": "Reviewer", "type": "user"})
    text = create_field(w.owner, w.project, {"name": "Note", "type": "text"})
    sprint = Sprint.objects.create(
        project=w.project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-14"
    )
    d = create(w.manager, w).json()
    good = {"unit": "hours", "sprintId": str(sprint.pk), "personField": str(person.pk)}
    res = layout(w.manager, d, [{"type": "workload", "w": 6, "h": 2, "config": good}])
    assert res.json()["widgets"][0]["config"] == good
    res = layout(w.manager, res.json(), [{"type": "workload", "w": 6, "h": 2, "config": {"personField": str(text.pk)}}])
    assert res.json()["details"]["fields"] == {"widgets.0.config.personField": "Pick a person field from this project"}


def test_adding_a_report_widget_needs_report_view(w):
    role = Role.objects.create(workspace=w.ws, name="Arranger", scope="project")
    for code in ("project.view", "dashboard.manage"):
        RolePermission.objects.create(role=role, permission=Permission.objects.get(code=code))
    arranger = add_project_member(w.project)
    arranger.project_memberships.filter(project=w.project).update(role=role)
    d = create(w.manager, w).json()
    d = layout(w.manager, d, [{**ROW}]).json()
    res = layout(arranger, d, [{"type": "burndown", "w": 6, "h": 2}])
    assert res.json()["details"]["fields"] == {"widgets.0.type": "You can’t view this report"}
    kept = layout(arranger, d, [{**d["widgets"][0], "w": 12}, {"type": "activity", "w": 3, "h": 1}])
    assert kept.status_code == 200  # keeping one is fine; activity needs only project.view


# ── DB6 delete ──


def test_delete_is_hard_and_cascades(w):
    d = create(w.sam, w, template="sprint_health").json()
    assert client_for(w.sam).delete(f"/api/v1/dashboards/{d['id']}").status_code == 204
    assert not Dashboard.objects.exists() and not DashboardWidget.objects.exists()
    row = AuditLog.objects.get(action="dashboard.deleted")
    assert row.data == {"visibility": "shared", "widgets": 6}
    assert client_for(w.sam).delete(f"/api/v1/dashboards/{d['id']}").status_code == 404


def test_dashboard_actions_stay_out_of_activity_feeds(w):
    create(w.sam, w)
    feed = client_for(w.sam).get(f"/api/v1/projects/{w.project.pk}/activity").json()["data"]
    assert all("dashboard" not in str(item) for item in feed)


# ── §4.3 truth table ──


@pytest.mark.parametrize(
    ("is_owner", "has_create", "has_manage", "visibility"),
    list(itertools.product([True, False], [True, False], [True, False], ["shared", "personal"])),
)
def test_object_rules_truth_table(w, is_owner, has_create, has_manage, visibility):
    role = Role.objects.create(workspace=w.ws, name="Probe", scope="project")
    codes = (
        ["project.view"] + (["dashboard.create"] if has_create else []) + (["dashboard.manage"] if has_manage else [])
    )
    for code in codes:
        RolePermission.objects.create(role=role, permission=Permission.objects.get(code=code))
    user = add_project_member(w.project)
    user.project_memberships.filter(project=w.project).update(role=role)
    d = Dashboard.objects.create(
        project=w.project, owner=user if is_owner else w.owner, name="D", visibility=visibility
    )
    d = Dashboard.objects.select_related("project").get(pk=d.pk)
    expected_edit = (is_owner and has_create) or (visibility == "shared" and has_manage)
    assert services.can_edit(user, d) == expected_edit
    assert services.can_view(user, d) == (visibility == "shared" or is_owner)
    assert services.can_change_visibility(user, d) == (is_owner and has_create)
    res = client_for(user).patch(f"/api/v1/dashboards/{d.pk}", {"name": "E", "version": 1}, format="json")
    if not services.can_view(user, d):
        assert res.status_code == 404
    elif expected_edit:
        assert res.status_code == 200
    else:
        assert res.status_code == 403
        expected_code = "dashboard.manage" if visibility == "shared" and not is_owner else "dashboard.create"
        assert res.json()["details"] == {"permission": expected_code}


# ── membership hooks ──


def test_removing_a_member_deletes_their_personal_dashboards_only(w):
    create(w.sam, w, name="Mine", visibility="personal")
    create(w.sam, w, name="Team")
    assert client_for(w.owner).delete(f"/api/v1/projects/{w.project.pk}/members/{w.sam.pk}").status_code == 204
    assert list(Dashboard.objects.values_list("name", flat=True)) == ["Team"]


def test_leaving_the_workspace_deletes_personal_dashboards(w):
    create(w.sam, w, name="Mine", visibility="personal")
    assert client_for(w.owner).delete(f"/api/v1/workspaces/platform/members/{w.sam.pk}").status_code == 204
    assert not Dashboard.objects.filter(visibility="personal").exists()


# ── realtime ──


def _events():
    return [
        (r.type, str(r.user_id) if r.user_id else None, r.payload["data"]) for r in RealtimeEvent.objects.order_by("id")
    ]


def test_dashboard_changed_events(w):
    RealtimeEvent.objects.all().delete()
    d = create(w.sam, w).json()
    layout(w.sam, d, [{**ROW}])
    client_for(w.sam).patch(f"/api/v1/dashboards/{d['id']}", {"visibility": "personal", "version": 2}, format="json")
    client_for(w.sam).delete(f"/api/v1/dashboards/{d['id']}")
    did, sam = d["id"], str(w.sam.pk)
    assert _events() == [
        ("dashboard.changed", None, {"dashboardId": did, "op": "created", "version": 1}),
        ("dashboard.changed", None, {"dashboardId": did, "op": "layout", "version": 2}),
        ("dashboard.changed", None, {"dashboardId": did, "op": "updated", "version": 3}),  # the old audience
        ("dashboard.changed", sam, {"dashboardId": did, "op": "updated", "version": 3}),
        ("dashboard.changed", sam, {"dashboardId": did, "op": "deleted", "version": None}),
    ]
    assert all(r.project_id == w.project.pk for r in RealtimeEvent.objects.all())
