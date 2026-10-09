"""Board 39: custom-field definitions (F1–F5)."""

import pytest

from apps.audit.models import AuditLog
from apps.common.testing import UserFactory, add_project_member, client_for, make_project, make_workspace
from apps.projects.custom_fields import MAX_FIELDS
from apps.projects.models import CustomField, CustomFieldOption
from apps.tasks.models import TaskFieldValue
from apps.tasks.services import create_task, delete_task

pytestmark = pytest.mark.django_db

OPTIONS = [
    {"name": "Production", "color": "var(--danger)"},
    {"name": "Staging", "color": "var(--warn)"},
    {"name": "Preview", "color": "var(--low)"},
]


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def api_owner(owner):
    return client_for(owner)


def url(project) -> str:
    return f"/api/v1/projects/{project.id}/custom-fields"


def create(client, project, **body):
    return client.post(
        url(project), {"name": "Environment", "type": "select", "options": OPTIONS, **body}, format="json"
    )


def test_create_select_field_payload_and_audit(api_owner, project, owner):
    res = create(api_owner, project, required=True)
    assert res.status_code == 201, res.content
    body = res.json()
    assert set(body) == {
        "id", "projectId", "name", "type", "required", "position", "options", "taskCount", "createdAt",
    }  # fmt: skip
    assert body["name"] == "Environment"
    assert body["type"] == "select"
    assert body["required"] is True
    assert body["position"] == 0
    assert body["taskCount"] == 0
    assert [(o["name"], o["color"], o["position"]) for o in body["options"]] == [
        ("Production", "var(--danger)", 0),
        ("Staging", "var(--warn)", 1),
        ("Preview", "var(--low)", 2),
    ]
    row = AuditLog.objects.get(action="project.custom_field_created")
    assert row.project_id == project.id
    assert row.target == "Environment"
    assert [(c["field"], c["after"]) for c in row.changes] == [("Type", "select"), ("Required", True)]


def test_non_select_types_ignore_options_and_go_last(api_owner, project):
    for i, kind in enumerate(["text", "number", "date", "user"]):
        res = api_owner.post(url(project), {"name": f"F{i}", "type": kind, "options": OPTIONS}, format="json")
        assert res.status_code == 201
        assert res.json()["options"] == []
        assert res.json()["position"] == i
        assert res.json()["required"] is False
    listed = api_owner.get(url(project)).json()
    assert [f["name"] for f in listed] == ["F0", "F1", "F2", "F3"]


@pytest.mark.parametrize(
    ("body", "path", "message"),
    [
        ({"name": "  "}, "name", "Name is required"),
        ({"name": "x" * 41}, "name", "Up to 40 characters"),
        ({"type": "boolean"}, "type", "Pick text, number, select, date or person"),
        ({"options": [{"name": " ", "color": "var(--low)"}]}, "options", "Add at least one option"),
        ({"options": "nope"}, "options", "Add at least one option"),
        (
            {"options": [{"name": "A", "color": "var(--low)"}, {"name": " a ", "color": "var(--ok)"}]},
            "options",
            "Options must be unique",
        ),
        ({"options": [{"name": f"O{i}", "color": "var(--low)"} for i in range(51)]}, "options", "Up to 50 options"),
        ({"options": [{"name": "x" * 33, "color": "var(--low)"}]}, "options.0.name", "Up to 32 characters"),
        (
            {"options": [{"name": "", "color": "x"}, {"name": "A", "color": "#fff"}]},
            "options.1.color",
            "Pick a colour from the palette",
        ),
    ],
)
def test_create_validation(api_owner, project, body, path, message):
    res = create(api_owner, project, **body)
    assert res.status_code == 422, res.content
    assert res.json()["code"] == "validation_failed"
    assert res.json()["details"]["fields"][path] == message


def test_duplicate_name_is_case_insensitive(api_owner, project):
    assert create(api_owner, project).status_code == 201
    res = create(api_owner, project, name=" environment ")
    assert res.json()["details"]["fields"]["name"] == "A field with this name exists"


def test_blank_option_rows_are_dropped(api_owner, project):
    res = create(api_owner, project, options=[*OPTIONS, {"name": "", "color": "var(--low)"}])
    assert len(res.json()["options"]) == 3


def test_field_limit(api_owner, project):
    CustomField.objects.bulk_create(
        [CustomField(project=project, name=f"F{i}", type="text", position=i) for i in range(MAX_FIELDS)]
    )
    res = create(api_owner, project)
    assert res.status_code == 409
    assert res.json()["code"] == "field_limit"
    assert res.json()["message"] == "A project can have up to 50 custom fields."


def test_update_name_required_and_options(api_owner, project, owner):
    field = create(api_owner, project).json()
    task = create_task(owner, project, {"title": "T"})
    prod, staging, preview = field["options"]
    patch = api_owner.patch(
        f"/api/v1/tasks/{task.id}", {"customFields": {field["id"]: staging["id"]}, "version": 1}, format="json"
    )
    assert patch.status_code == 200, patch.content
    assert api_owner.get(url(project)).json()[0]["taskCount"] == 1
    res = api_owner.patch(
        f"/api/v1/custom-fields/{field['id']}",
        {
            "name": "Env",
            "required": True,
            "type": "select",  # unchanged type is allowed
            "options": [
                {"id": preview["id"], "name": "Preview", "color": "var(--info)"},
                {"id": prod["id"], "name": "Prod", "color": "var(--danger)"},
                {"name": "Canary", "color": "var(--ok)"},
            ],
        },
        format="json",
    )
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["name"] == "Env"
    assert body["required"] is True
    assert [(o["name"], o["color"]) for o in body["options"]] == [
        ("Preview", "var(--info)"),
        ("Prod", "var(--danger)"),
        ("Canary", "var(--ok)"),
    ]
    assert body["options"][0]["id"] == preview["id"]
    # The removed option took its value with it.
    assert body["taskCount"] == 0
    assert not TaskFieldValue.objects.filter(task=task).exists()
    row = AuditLog.objects.get(action="project.custom_field_updated")
    changes = {c["field"]: (c["before"], c["after"]) for c in row.changes}
    assert changes["Name"] == ("Environment", "Env")
    assert changes["Required"] == (False, True)
    assert changes["Options"] == ("Production, Staging, Preview", "Preview, Prod, Canary")


def test_options_can_swap_names(api_owner, project):
    field = create(api_owner, project).json()
    a, b, _ = field["options"]
    res = api_owner.patch(
        f"/api/v1/custom-fields/{field['id']}",
        {
            "options": [
                {"id": a["id"], "name": "Staging", "color": "var(--low)"},
                {"id": b["id"], "name": "Production", "color": "var(--low)"},
            ]
        },
        format="json",
    )
    assert res.status_code == 200, res.content
    assert [o["name"] for o in res.json()["options"]] == ["Staging", "Production"]


def test_update_validation(api_owner, project, ws, owner):
    field = create(api_owner, project).json()
    target = f"/api/v1/custom-fields/{field['id']}"
    res = api_owner.patch(target, {"type": "text"}, format="json")
    assert res.json()["details"]["fields"] == {"type": "A field’s type can’t be changed"}
    other_field = create(api_owner, project, name="Other").json()
    res = api_owner.patch(target, {"name": "OTHER"}, format="json")
    assert res.json()["details"]["fields"]["name"] == "A field with this name exists"
    res = api_owner.patch(
        target,
        {"options": [{"id": other_field["options"][0]["id"], "name": "X", "color": "var(--low)"}]},
        format="json",
    )
    assert res.json()["details"]["fields"]["options.0.id"] == "Unknown option"
    res = api_owner.patch(target, {"options": []}, format="json")
    assert res.json()["details"]["fields"]["options"] == "Add at least one option"
    # Colour-only edits are saved (and audited without a diff line).
    res = api_owner.patch(target, {"options": [{**o, "color": "var(--ok)"} for o in field["options"]]}, format="json")
    assert {o["color"] for o in res.json()["options"]} == {"var(--ok)"}
    # Unknown / invisible ids → 404.
    assert api_owner.patch("/api/v1/custom-fields/nope", {}, format="json").status_code == 404
    elsewhere = make_project(make_workspace(UserFactory(), slug="elsewhere"), key="ELS")
    foreign = CustomField.objects.create(project=elsewhere, name="X", type="text")
    res = api_owner.patch(f"/api/v1/custom-fields/{foreign.id}", {"name": "Y"}, format="json")
    assert res.status_code == 404
    assert res.json()["message"] == "Custom field not found."


def test_create_rejects_option_ids(api_owner, project):
    res = create(api_owner, project, options=[{"id": "x", "name": "A", "color": "var(--low)"}])
    assert res.json()["details"]["fields"]["options.0.id"] == "Unknown option"


def test_delete_cascades_values_and_compacts_positions(api_owner, project, owner):
    fields = [api_owner.post(url(project), {"name": n, "type": "text"}, format="json").json() for n in ("A", "B", "C")]
    live = create_task(owner, project, {"title": "Live"})
    gone = create_task(owner, project, {"title": "Gone"})
    for task in (live, gone):
        api_owner.patch(
            f"/api/v1/tasks/{task.id}", {"customFields": {fields[1]["id"]: "x"}, "version": 1}, format="json"
        )
    delete_task(owner, gone)
    assert api_owner.get(url(project)).json()[1]["taskCount"] == 1  # deleted tasks don't count
    assert api_owner.delete(f"/api/v1/custom-fields/{fields[1]['id']}").status_code == 204
    assert not TaskFieldValue.objects.exists()
    assert [(f["name"], f["position"]) for f in api_owner.get(url(project)).json()] == [("A", 0), ("C", 1)]
    row = AuditLog.objects.get(action="project.custom_field_deleted")
    assert row.data == {"valuesRemoved": 1}
    assert row.target == "B"


def test_reorder_requires_every_field_once(api_owner, project):
    ids = [api_owner.post(url(project), {"name": n, "type": "text"}, format="json").json()["id"] for n in "ABC"]
    order = f"{url(project)}/order"
    for bad in ([ids[0], ids[1]], [*ids, ids[0]], "x", [*ids[:2], "00000000-0000-0000-0000-000000000000"]):
        res = api_owner.put(order, {"ids": bad}, format="json")
        assert res.status_code == 422
        assert res.json()["details"]["fields"] == {"ids": "Send every field once"}
    res = api_owner.put(order, {"ids": [ids[2], ids[0], ids[1]]}, format="json")
    assert res.status_code == 200
    assert [(f["name"], f["position"]) for f in res.json()] == [("C", 0), ("A", 1), ("B", 2)]
    row = AuditLog.objects.get(action="project.custom_fields_reordered")
    assert row.changes == [{"field": "Order", "kind": "value", "before": "A, B, C", "after": "C, A, B"}]


def test_roles(project, owner):
    member = add_project_member(project, key="project_member")
    viewer = add_project_member(project, key="viewer")
    manager = add_project_member(project, key="manager")
    for user in (member, viewer):
        client = client_for(user)
        assert client.get(url(project)).status_code == 200
        res = create(client, project)
        assert res.status_code == 403
        assert res.json()["details"]["permission"] == "field.manage"
    field = create(client_for(manager), project)
    assert field.status_code == 201
    res = client_for(member).delete(f"/api/v1/custom-fields/{field.json()['id']}")
    assert res.status_code == 403


def test_archived_project_is_read_only(api_owner, project):
    field = create(api_owner, project).json()
    assert api_owner.post(f"/api/v1/projects/{project.id}/archive").status_code == 200
    assert api_owner.get(url(project)).status_code == 200
    assert create(api_owner, project, name="New").status_code == 403
    assert api_owner.patch(f"/api/v1/custom-fields/{field['id']}", {"name": "N"}, format="json").status_code == 403


def test_option_model_fallbacks(project, owner):
    from apps.projects.serializers import custom_field_data

    field = CustomField.objects.create(project=project, name="Plain", type="select")
    CustomFieldOption.objects.create(field=field, name="B", color="var(--low)", position=1)
    CustomFieldOption.objects.create(field=field, name="A", color="var(--low)", position=0)
    data = custom_field_data(field)  # no annotations: counts with a query
    assert data["taskCount"] == 0
    assert [o["name"] for o in data["options"]] == ["A", "B"]
