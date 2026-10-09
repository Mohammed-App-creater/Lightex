"""Board 39: custom-field values and the time estimate through PATCH /tasks/:id (T1)."""

import pytest

from apps.audit.models import AuditLog
from apps.common.testing import UserFactory, add_project_member, client_for, make_project
from apps.projects.custom_fields import create_field
from apps.tasks.models import Task, TaskFieldValue
from apps.tasks.services import create_task

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def fields(project, owner):
    def make(name, kind, **extra):
        return create_field(owner, project, {"name": name, "type": kind, **extra})

    return {
        "browser": make(
            "Browser",
            "select",
            options=[{"name": "Chrome", "color": "var(--low)"}, {"name": "Safari", "color": "var(--accent-t)"}],
        ),
        "found": make("Found in", "text", required=True),
        "accounts": make("Accounts affected", "number"),
        "signoff": make("QA sign-off", "date"),
        "owner": make("QA owner", "user"),
    }


def opt(field, name):
    return str(field.options.get(name=name).id)


def patch(client, task, body, version=None):
    task.refresh_from_db()
    return client.patch(
        f"/api/v1/tasks/{task.id}", {**body, "version": task.version if version is None else version}, format="json"
    )


def test_set_each_type_merge_and_clear(owner, project, fields):
    task = create_task(owner, project, {"title": "Bug"})
    client = client_for(owner)
    f = {k: str(v.id) for k, v in fields.items()}
    res = patch(
        client,
        task,
        {
            "customFields": {
                f["browser"]: opt(fields["browser"], "Safari"),
                f["found"]: "  v2.3.1 ",
                f["accounts"]: 1240,
                f["signoff"]: "2026-10-09",
                f["owner"]: str(owner.id),
            }
        },
    )
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["customFields"] == {
        f["browser"]: opt(fields["browser"], "Safari"),
        f["found"]: "v2.3.1",
        f["accounts"]: 1240,
        f["signoff"]: "2026-10-09",
        f["owner"]: str(owner.id),
    }
    assert body["version"] == 2  # bumped once for the whole PATCH
    # Merge: unlisted keys stay; null and "" clear; decimals round to 2 places.
    res = patch(client, task, {"customFields": {f["accounts"]: 12.345, f["signoff"]: None, f["owner"]: ""}})
    assert res.json()["customFields"] == {
        f["browser"]: opt(fields["browser"], "Safari"),
        f["found"]: "v2.3.1",
        f["accounts"]: 12.35,
    }
    assert TaskFieldValue.objects.filter(task=task).count() == 3
    # {} is a no-op that still needs a version (and bumps it like any PATCH).
    assert patch(client, task, {"customFields": {}}).status_code == 200
    # Clearing an already-empty field changes nothing.
    assert patch(client, task, {"customFields": {f["signoff"]: None}}).status_code == 200


@pytest.mark.parametrize(
    ("key", "value", "message"),
    [
        ("found", "x" * 121, "Up to 120 characters"),
        ("found", 12, "Up to 120 characters"),
        ("accounts", "12", "Enter a number from 0 to 1,000,000,000"),
        ("accounts", -1, "Enter a number from 0 to 1,000,000,000"),
        ("accounts", 1_000_000_001, "Enter a number from 0 to 1,000,000,000"),
        ("accounts", True, "Enter a number from 0 to 1,000,000,000"),
        ("browser", "00000000-0000-0000-0000-000000000000", "Pick one of the options"),
        ("signoff", "09/10/2026", "Pick a date"),
        ("signoff", "2026-02-30", "Pick a date"),
        ("owner", "00000000-0000-0000-0000-000000000000", "Pick someone on this project"),
        ("owner", "nobody", "Pick someone on this project"),
        ("found", None, "This field is required"),
        ("found", "   ", "This field is required"),
    ],
)
def test_value_validation(owner, project, fields, key, value, message):
    task = create_task(owner, project, {"title": "Bug"})
    field_id = str(fields[key].id)
    res = patch(client_for(owner), task, {"customFields": {field_id: value}})
    assert res.status_code == 422, res.content
    assert res.json()["details"]["fields"] == {f"customFields.{field_id}": message}
    assert Task.objects.get(pk=task.pk).version == 1


def test_unknown_or_foreign_fields_and_bad_shape(owner, ws, project, fields):
    task = create_task(owner, project, {"title": "Bug"})
    other = make_project(ws, owner, key="OTH")
    foreign = create_field(owner, other, {"name": "Elsewhere", "type": "text"})
    client = client_for(owner)
    res = patch(client, task, {"customFields": {str(foreign.id): "x", "garbage": "y"}})
    assert res.json()["details"]["fields"] == {
        f"customFields.{foreign.id}": "This field was deleted",
        "customFields.garbage": "This field was deleted",
    }
    res = patch(client, task, {"customFields": ["nope"]})
    assert res.json()["details"]["fields"] == {"customFields": "Send an object of field ids"}


def test_user_must_be_project_member(owner, ws, project, fields):
    task = create_task(owner, project, {"title": "Bug"})
    outsider = UserFactory()
    res = patch(client_for(owner), task, {"customFields": {str(fields["owner"].id): str(outsider.id)}})
    assert res.json()["details"]["fields"][f"customFields.{fields['owner'].id}"] == "Pick someone on this project"


def test_version_is_checked_first(owner, project, fields):
    task = create_task(owner, project, {"title": "Bug"})
    res = patch(client_for(owner), task, {"customFields": {"garbage": 1}}, version=99)
    assert res.status_code == 409
    assert res.json()["code"] == "version_conflict"
    current = res.json()["details"]["current"]
    assert current["customFields"] == {}
    assert current["loggedMinutes"] == 0


def test_edit_rules(owner, project, fields):
    member = add_project_member(project, key="project_member")
    viewer = add_project_member(project, key="viewer")
    mine = create_task(member, project, {"title": "Mine"})
    theirs = create_task(owner, project, {"title": "Theirs"})
    body = {"customFields": {str(fields["found"].id): "v1"}}
    assert patch(client_for(member), mine, body).status_code == 200  # edit_own
    res = patch(client_for(member), theirs, body)
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "task.edit_any"
    assert patch(client_for(viewer), theirs, body).status_code == 403
    # A role with only task.move can't sneak values in: it isn't a status-only patch.
    from apps.access.models import Permission, Role, RolePermission
    from apps.projects.models import ProjectMember

    mover_role = Role.objects.create(workspace=project.workspace, name="Mover", scope="project")
    for code in ("project.view", "task.move"):
        RolePermission.objects.create(role=mover_role, permission=Permission.objects.get(code=code))
    mover = add_project_member(project, key="viewer")
    ProjectMember.objects.filter(project=project, user=mover).update(role=mover_role)
    res = patch(client_for(mover), theirs, {"timeEstimateMinutes": 60})
    assert res.status_code == 403


def test_time_estimate(owner, project):
    task = create_task(owner, project, {"title": "Bug"})
    client = client_for(owner)
    res = patch(client, task, {"timeEstimateMinutes": 360})
    assert res.json()["timeEstimateMinutes"] == 360
    assert res.json()["estimate"] is None  # story points are separate
    assert patch(client, task, {"timeEstimateMinutes": 360.0}).json()["timeEstimateMinutes"] == 360
    assert patch(client, task, {"timeEstimateMinutes": 0}).json()["timeEstimateMinutes"] is None
    assert patch(client, task, {"timeEstimateMinutes": 60_000}).json()["timeEstimateMinutes"] == 60_000
    assert patch(client, task, {"timeEstimateMinutes": None}).json()["timeEstimateMinutes"] is None
    for bad in (60_001, -5, 1.5, "60", True):
        res = patch(client, task, {"timeEstimateMinutes": bad})
        assert res.status_code == 422, bad
        assert res.json()["details"]["fields"] == {"timeEstimateMinutes": "Estimate is 1 minute to 1000 hours"}


def test_audit_changes(owner, project, fields):
    task = create_task(owner, project, {"title": "Bug"})
    client = client_for(owner)
    f = {k: str(v.id) for k, v in fields.items()}
    patch(
        client,
        task,
        {
            "customFields": {
                f["browser"]: opt(fields["browser"], "Chrome"),
                f["owner"]: str(owner.id),
                f["signoff"]: "2026-10-09",
                f["accounts"]: 5,
            },
            "timeEstimateMinutes": 90,
        },
    )
    row = AuditLog.objects.filter(action="task.updated").latest("created_at")
    changes = {c["field"]: c for c in row.changes}
    assert changes["Browser"] == {"field": "Browser", "kind": "value", "before": None, "after": "Chrome"}
    assert changes["QA owner"] == {"field": "QA owner", "kind": "person", "before": None, "after": str(owner.id)}
    assert changes["QA sign-off"]["after"] == "2026-10-09"
    assert changes["Accounts affected"]["after"] == 5
    assert changes["Time estimate"] == {"field": "Time estimate", "kind": "value", "before": None, "after": 90}
    patch(client, task, {"customFields": {f["browser"]: opt(fields["browser"], "Safari"), f["owner"]: None}})
    row = AuditLog.objects.filter(action="task.updated").latest("created_at")
    changes = {c["field"]: (c["before"], c["after"]) for c in row.changes}
    assert changes == {"Browser": ("Chrome", "Safari"), "QA owner": (str(owner.id), None)}


def test_create_and_bulk_do_not_take_board39_fields(owner, project, fields):
    client = client_for(owner)
    res = client.post(
        f"/api/v1/projects/{project.id}/tasks",
        {"title": "New", "customFields": {str(fields["found"].id): "x"}, "timeEstimateMinutes": 30},
        format="json",
    )
    assert res.status_code == 201
    assert res.json()["customFields"] == {}  # ignored on create
    assert res.json()["timeEstimateMinutes"] is None
    res = client.post(
        f"/api/v1/projects/{project.id}/tasks/bulk",
        {"ids": [res.json()["id"]], "patch": {"customFields": {}}},
        format="json",
    )
    assert res.status_code == 422
    assert res.json()["details"]["fields"] == {"patch.customFields": "This field can’t be bulk-edited"}


def test_values_survive_soft_delete_and_restore(owner, project, fields):
    task = create_task(owner, project, {"title": "Bug"})
    client = client_for(owner)
    patch(client, task, {"customFields": {str(fields["found"].id): "v1"}})
    assert client.delete(f"/api/v1/tasks/{task.id}").status_code == 204
    # v1: PATCH /tasks/:id hides deleted tasks (404); the service itself refuses with 409.
    assert patch(client, task, {"customFields": {str(fields["found"].id): "v2"}}).status_code == 404
    from apps.common.exceptions import ApiError
    from apps.tasks.services import update_task

    task.refresh_from_db()
    with pytest.raises(ApiError) as exc:
        update_task(owner, task, {"customFields": {str(fields["found"].id): "v2"}, "version": task.version})
    assert exc.value.code == "task_deleted"
    assert client.post(f"/api/v1/tasks/{task.id}/restore").status_code == 200
    assert client.get(f"/api/v1/tasks/{task.id}").json()["customFields"] == {str(fields["found"].id): "v1"}
