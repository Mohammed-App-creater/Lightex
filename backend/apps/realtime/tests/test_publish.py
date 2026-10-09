"""Publishing (docs/v2/33-dashboards-presence.md §2.7, §6.2): after commit only, the audit hook's mapping, the
explicit publication points, commit-ordered ids under the advisory lock. Durable events are read back from the
event table (the `local` broker stores them for replay)."""

import pytest
from django.db import connection, transaction
from django.test.utils import CaptureQueriesContext

from apps.audit.services import change, record
from apps.common.richtext import plain_doc
from apps.common.testing import client_for
from apps.common.utils import today
from apps.realtime import services
from apps.realtime.models import RealtimeEvent
from apps.realtime.services import publish
from apps.tasks.services import create_task

pytestmark = pytest.mark.django_db
ORIGINAL_ON_COMMIT = transaction.on_commit  # captured before the suite's "run on_commit at once" fixture


def _events(type_=None):
    rows = RealtimeEvent.objects.order_by("id")
    if type_:
        rows = rows.filter(type=type_)
    return [{**r.payload, "userId": str(r.user_id) if r.user_id else None, "id": r.pk} for r in rows]


def _clear():
    RealtimeEvent.objects.all().delete()


@pytest.fixture
def task(world):
    t = create_task(world.owner, world.project, {"title": "Ship it"})
    _clear()
    return t


# ── publish() ──


def test_sends_after_commit_and_never_on_rollback(world, monkeypatch, django_capture_on_commit_callbacks):
    monkeypatch.setattr(transaction, "on_commit", ORIGINAL_ON_COMMIT)
    with (
        django_capture_on_commit_callbacks(execute=True) as callbacks,
        pytest.raises(RuntimeError),
        transaction.atomic(),
    ):
        publish("project.changed", workspace=world.ws, project=world.project, data={"areas": ["labels"]})
        raise RuntimeError
    assert callbacks == [] and not RealtimeEvent.objects.exists()
    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        with transaction.atomic():
            publish("project.changed", workspace=world.ws, project=world.project, data={"areas": ["labels"]})
        assert not RealtimeEvent.objects.exists()  # nothing until the transaction commits
    assert len(callbacks) == 1
    callbacks[0]()
    assert [e["type"] for e in _events()] == ["project.changed"]


def test_durable_ids_increase_and_are_allocated_under_the_advisory_lock(world):
    with CaptureQueriesContext(connection) as ctx:
        for _ in range(3):
            publish("project.changed", workspace=world.ws, project=world.project, data={"areas": ["epics"]})
    ids = [e["id"] for e in _events()]
    assert len(ids) == 3 and ids == sorted(ids) and len(set(ids)) == 3
    sql = [q["sql"] for q in ctx.captured_queries]
    locks = [i for i, q in enumerate(sql) if "pg_advisory_xact_lock" in q]
    inserts = [i for i, q in enumerate(sql) if q.startswith('INSERT INTO "realtime_realtimeevent"')]
    assert len(locks) == 3 and all(lock < insert for lock, insert in zip(locks, inserts, strict=True))


def test_publishing_failures_never_fail_the_write(world, monkeypatch, caplog):
    from apps.realtime.brokers import LocalBroker

    def boom(self, event, *, durable):
        raise RuntimeError("broker down")

    monkeypatch.setattr(LocalBroker, "send", boom)
    res = client_for(world.owner).post(f"/api/v1/projects/{world.project.pk}/tasks", {"title": "Still saved"})
    assert res.status_code == 201
    assert "Publishing realtime event task.changed failed" in caplog.text


def test_payload_is_an_id_only_envelope(world, task):
    res = client_for(world.owner).patch(
        f"/api/v1/tasks/{task.pk}", {"title": "Secret title", "version": task.version}, format="json"
    )
    assert res.status_code == 200
    (event,) = _events("task.changed")
    assert event == {
        "v": 1,
        "type": "task.changed",
        "ws": str(world.ws.pk),
        "projectId": str(world.project.pk),
        "actorId": str(world.owner.pk),
        "at": event["at"],
        "data": {"taskId": str(task.pk), "key": task.key, "op": "updated", "version": 2, "fields": ["title"]},
        "userId": None,
        "id": event["id"],
    }
    assert "Secret" not in str(event)


# ── the audit hook (§6.2) ──


def test_task_writes(world, task):
    owner = client_for(world.owner)
    done = world.project.statuses.filter(category="done").first()
    owner.patch(f"/api/v1/tasks/{task.pk}", {"dueDate": "2026-12-01", "priority": 1, "version": 1}, format="json")
    owner.patch(f"/api/v1/tasks/{task.pk}", {"statusId": str(done.pk), "version": 2}, format="json")
    owner.patch(f"/api/v1/tasks/{task.pk}", {"assigneeId": str(world.sam.pk), "version": 3}, format="json")
    owner.delete(f"/api/v1/tasks/{task.pk}")
    owner.post(f"/api/v1/tasks/{task.pk}/restore")
    got = [(e["data"]["op"], e["data"]["version"], e["data"]["fields"]) for e in _events("task.changed")]
    assert got == [
        ("updated", 2, ["priority", "dueDate"]),
        ("updated", 3, ["statusId"]),
        ("updated", 4, ["assigneeId"]),
        ("deleted", None, []),
        ("restored", 6, []),
    ]


def test_created_task(world):
    _clear()
    res = client_for(world.owner).post(f"/api/v1/projects/{world.project.pk}/tasks", {"title": "New"})
    (event,) = _events("task.changed")
    assert event["data"] == {
        "taskId": res.json()["id"],
        "key": res.json()["key"],
        "op": "created",
        "version": 1,
        "fields": [],
    }


def test_custom_field_values_map_to_their_ids(world, task):
    from apps.projects.custom_fields import create_field

    field = create_field(world.owner, world.project, {"name": "Browser", "type": "text"})
    _clear()
    client_for(world.owner).patch(
        f"/api/v1/tasks/{task.pk}", {"customFields": {str(field.pk): "Firefox"}, "version": 1}, format="json"
    )
    (event,) = _events("task.changed")
    assert event["data"]["fields"] == [f"customFields.{field.pk}"]


def test_dependencies_and_time_are_unversioned(world, task):
    other = create_task(world.owner, world.project, {"title": "Blocker"})
    _clear()
    owner = client_for(world.owner)
    owner.post(f"/api/v1/tasks/{task.pk}/dependencies", {"relation": "blocked_by", "taskId": str(other.pk)})
    owner.post(f"/api/v1/tasks/{task.pk}/time-entries", {"minutes": 30, "date": today().isoformat()})
    got = [(e["data"]["key"], e["data"]["version"], e["data"]["fields"]) for e in _events("task.changed")]
    assert got == [
        (task.key, None, ["dependencies"]),
        (other.key, None, ["dependencies"]),
        (task.key, None, ["loggedMinutes"]),
    ]


def test_comments(world, task):
    owner = client_for(world.owner)
    res = owner.post(f"/api/v1/tasks/{task.pk}/comments", {"body": plain_doc("hello")}, format="json")
    comment = res.json()["id"]
    owner.patch(f"/api/v1/comments/{comment}", {"body": plain_doc("edited")}, format="json")
    owner.delete(f"/api/v1/comments/{comment}")
    got = [(e["data"]["commentId"], e["data"]["op"], e["data"]["key"]) for e in _events("comment.changed")]
    assert got == [(comment, "created", task.key), (comment, "updated", task.key), (comment, "deleted", task.key)]


@pytest.mark.parametrize(
    ("action", "expected"),
    [
        ("attachment.created", ("attachment.changed", {"op": "created"})),
        ("attachment.deleted", ("attachment.changed", {"op": "deleted"})),
        ("comment.restored", ("comment.changed", {"op": "created"})),
        ("status.created", ("project.changed", {"areas": ["statuses"]})),
        ("label.deleted", ("project.changed", {"areas": ["labels"]})),
        ("sprint.started", ("project.changed", {"areas": ["sprints"]})),
        ("epic.updated", ("project.changed", {"areas": ["epics"]})),
        ("objective.task_unlinked", ("project.changed", {"areas": ["objectives"]})),
        ("milestone.created", ("project.changed", {"areas": ["milestones"]})),
        ("project.updated", ("project.changed", {"areas": ["settings"]})),
        ("project.archived", ("project.changed", {"areas": ["settings"]})),
        ("project.custom_field_created", ("project.changed", {"areas": ["custom_fields"]})),
        ("project.custom_fields_reordered", ("project.changed", {"areas": ["custom_fields"]})),
        ("project.import_completed", ("tasks.bulk_changed", {"taskIds": None, "op": "created"})),
        ("task.purged", None),
        ("comment.purged", None),
        ("project.access_requested", None),
        ("view.created", None),
        ("workspace.updated", None),
        ("member.invited", None),
        ("dashboard.created", None),  # dashboards publish explicitly (owner and visibility)
    ],
)
def test_audit_action_mapping(world, task, action, expected):
    record(
        workspace=world.ws, project=world.project, task=task, actor=world.owner, action=action, entity_id=task.pk,
        entity_key=task.key, target="x",
    )  # fmt: skip
    events = _events()
    if expected is None:
        assert events == []
        return
    (event,) = events
    type_, data = expected
    assert event["type"] == type_ and event["projectId"] == str(world.project.pk)
    assert data.items() <= event["data"].items()


def test_membership_changes_target_the_member(world):
    _clear()
    owner = client_for(world.owner)
    manager = world.ws.roles.get(system_key="manager")
    owner.patch(f"/api/v1/projects/{world.project.pk}/members/{world.sam.pk}", {"roleId": str(manager.pk)})
    owner.delete(f"/api/v1/projects/{world.project.pk}/members/{world.viewer.pk}")
    got = [(e["type"], e["userId"], e["data"]) for e in _events()]
    members = {"areas": ["members"]}
    project = {"projectId": str(world.project.pk)}
    assert got == [
        ("access.changed", str(world.sam.pk), project),
        ("project.changed", None, members),
        ("access.changed", str(world.viewer.pk), project),
        ("project.changed", None, members),
    ]


def test_workspace_removal_and_custom_role_edits_reach_the_holders(world):
    from apps.access.models import Permission as Perm
    from apps.access.models import Role, RolePermission
    from apps.projects.models import ProjectMember

    role = Role.objects.create(workspace=world.ws, name="Release captain", scope="project")
    RolePermission.objects.create(role=role, permission=Perm.objects.get(code="project.view"))
    ProjectMember.objects.filter(project=world.project, user=world.viewer).update(role=role)
    _clear()
    owner = client_for(world.owner)
    res = owner.put(f"/api/v1/roles/{role.pk}/permissions", {"permissions": ["project.view", "report.view"]})
    assert res.status_code == 200, res.content
    owner.delete(f"/api/v1/workspaces/platform/members/{world.sam.pk}")
    got = [(e["type"], e["userId"], e["data"]) for e in _events("access.changed")]
    assert got == [
        ("access.changed", str(world.viewer.pk), {"projectId": None}),
        ("access.changed", str(world.sam.pk), {"projectId": None}),
    ]


def test_a_new_project_tells_its_creator(world):
    _clear()
    res = client_for(world.owner).post("/api/v1/workspaces/platform/projects", {"name": "Mobile", "key": "MOB"})
    project_id = res.json()["id"]
    (event,) = _events("access.changed")
    assert event["userId"] == str(world.owner.pk) and event["data"] == {"projectId": project_id}


# ── explicit publication points ──


def test_a_board_move_publishes_one_moved_event(world, task):
    progress = world.project.statuses.filter(category="in_progress").first()
    res = client_for(world.owner).post(
        f"/api/v1/tasks/{task.pk}/move", {"statusId": str(progress.pk), "position": "n", "version": 1}, format="json"
    )
    assert res.status_code == 200, res.content
    (event,) = _events()
    assert event["type"] == "task.changed"
    assert event["data"] == {
        "taskId": str(task.pk),
        "key": task.key,
        "op": "moved",
        "version": 2,
        "fields": ["statusId", "position"],
    }


def test_bulk_operations_publish_one_event(world, task):
    other = create_task(world.owner, world.project, {"title": "Two"})
    _clear()
    owner = client_for(world.owner)
    ids = [str(task.pk), str(other.pk)]
    res = owner.post(
        f"/api/v1/projects/{world.project.pk}/tasks/bulk", {"ids": ids, "patch": {"priority": 1}}, format="json"
    )
    assert res.status_code == 200, res.content
    owner.post(f"/api/v1/projects/{world.project.pk}/tasks/bulk", {"ids": ids, "delete": True}, format="json")
    owner.post(f"/api/v1/projects/{world.project.pk}/tasks/bulk", {"ids": ids, "restore": True}, format="json")
    got = [(e["type"], sorted(e["data"]["taskIds"]), e["data"]["op"]) for e in _events()]
    assert got == [
        ("tasks.bulk_changed", sorted(ids), "updated"),
        ("tasks.bulk_changed", sorted(ids), "deleted"),
        ("tasks.bulk_changed", sorted(ids), "restored"),
    ]


def test_more_than_200_ids_are_sent_as_many(world):
    services.publish_bulk(world.owner, world.project, list(range(201)), "updated")
    assert _events()[0]["data"] == {"taskIds": None, "op": "updated"}


def test_notifications_publish_the_unread_count(world, task):
    client_for(world.owner).patch(
        f"/api/v1/tasks/{task.pk}", {"assigneeId": str(world.sam.pk), "version": 1}, format="json"
    )
    (event,) = _events("inbox.changed")
    assert event["userId"] == str(world.sam.pk) and event["data"] == {"unread": 1} and event["projectId"] is None
    sam = client_for(world.sam)
    notification = sam.get("/api/v1/notifications").json()["data"][0]["id"]
    sam.post(f"/api/v1/notifications/{notification}/read", {"read": True})
    assert _events("inbox.changed")[-1]["data"] == {"unread": 0}
    sam.post("/api/v1/notifications/read-all", {"unread": True}, format="json")
    last = _events("inbox.changed")[-1]
    assert last["data"] == {"unread": 1} and last["ws"] == str(world.ws.pk)
    count = len(_events("inbox.changed"))
    sam.post("/api/v1/notifications/read-all", {"unread": True}, format="json")  # nothing changed
    assert len(_events("inbox.changed")) == count


def test_suppressed_audit_rows_publish_nothing(world, task):
    with services.suppress_audit_events():
        record(workspace=world.ws, project=world.project, task=task, actor=world.owner, action="task.updated",
               changes=[change("Title", "a", "b")])  # fmt: skip
    assert _events() == []
