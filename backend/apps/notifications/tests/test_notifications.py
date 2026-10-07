import datetime as dt

import pytest
from django.core import mail
from django.core.management import call_command
from django.utils import timezone

from apps.common.richtext import plain_doc
from apps.common.testing import add_member, add_project_member, client_for, make_project
from apps.notifications.handlers import process_event
from apps.notifications.models import DomainEvent, Notification, NotificationPreference
from apps.planning.models import Sprint
from apps.tasks.services import create_task

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def st(project):
    return {s.glyph: s for s in project.statuses.all()}


@pytest.fixture
def sam(project):
    return add_project_member(project, key="project_member")


def inbox(user, tab="all"):
    return client_for(user).get(f"/api/v1/notifications?filter[tab]={tab}").json()


def test_assignment_notifies_assignee_in_app_and_by_email(owner, project, sam):
    mail.outbox.clear()
    task = create_task(owner, project, {"title": "Fix reflow", "assigneeId": str(sam.id), "priority": 3})
    data = inbox(sam)
    assert data["counts"] == {"all": 1, "mentions": 0, "assigned": 1, "unread": 1}
    n = data["data"][0]
    assert n["type"] == "assigned"
    assert n["taskKey"] == task.key
    assert n["projectName"] == project.name
    assert n["actorId"] == str(owner.id)
    assert set(n) == {
        "id",
        "type",
        "actorId",
        "projectId",
        "projectName",
        "taskId",
        "taskKey",
        "taskTitle",
        "payload",
        "createdAt",
        "readAt",
    }
    assert [m.to for m in mail.outbox] == [[sam.email]]
    assert "Fix reflow" in mail.outbox[0].alternatives[0][0]
    assert "PRJ-1" in mail.outbox[0].body
    assert inbox(owner)["counts"]["all"] == 0  # never notify the actor


def test_mentions_and_comments(owner, project, sam):
    reporter = add_project_member(project, key="project_member")
    task = create_task(reporter, project, {"title": "Discuss"})
    mail.outbox.clear()
    doc = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "Look "},
                    {"type": "mention", "attrs": {"id": str(sam.id), "label": "Sam"}},
                ],
            }
        ],
    }
    client_for(owner).post(f"/api/v1/tasks/{task.id}/comments", {"body": doc}, format="json")
    mention = inbox(sam, "mentions")["data"]
    assert len(mention) == 1
    assert mention[0]["payload"]["quote"] == "Look @Sam"
    comment = inbox(reporter)["data"]
    assert comment[0]["type"] == "comment"
    # Mention emails are on by default, comment emails off.
    assert [m.to for m in mail.outbox] == [[sam.email]]
    assert "mentioned" in mail.outbox[0].subject.lower()


def test_status_change_notifies_assignee_and_reporter(owner, project, sam, st):
    reporter = add_project_member(project, key="manager")
    task = create_task(reporter, project, {"title": "Ship", "assigneeId": str(sam.id)})
    client_for(owner).patch(
        f"/api/v1/tasks/{task.id}", {"statusId": str(st["progress"].id), "version": 1}, format="json"
    )
    for user in (sam, reporter):
        rows = [n for n in inbox(user)["data"] if n["type"] == "status"]
        assert rows[0]["payload"] == {"fromStatus": "Todo", "toStatus": "In progress"}


def test_description_mentions_notify(owner, project, sam):
    doc = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "mention", "attrs": {"id": str(sam.id), "label": "Sam"}}]}
        ],
    }
    create_task(owner, project, {"title": "Spec", "description": doc})
    assert inbox(sam, "mentions")["counts"]["mentions"] == 1


def test_preferences_control_channels(owner, project, sam):
    client = client_for(sam)
    prefs = client.get("/api/v1/notification-preferences").json()
    assert prefs["emailDelivery"] == "instant"
    assert prefs["events"]["assigned"] == {"in_app": True, "email": True}
    prefs["events"]["assigned"] = {"in_app": False, "email": True, "telegram": True}
    prefs["events"]["bogus"] = {"in_app": True}
    saved = client.put("/api/v1/notification-preferences", prefs, format="json").json()
    assert saved["events"]["assigned"] == {"in_app": False, "email": True}
    assert "bogus" not in saved["events"]
    assert (
        client.put(
            "/api/v1/notification-preferences", {"events": {}, "emailDelivery": "weekly"}, format="json"
        ).status_code
        == 422
    )
    mail.outbox.clear()
    create_task(owner, project, {"title": "Email only", "assigneeId": str(sam.id)})
    assert inbox(sam)["counts"]["all"] == 0
    assert len(mail.outbox) == 1
    # Both channels off: nothing at all.
    prefs["events"]["assigned"] = {"in_app": False, "email": False}
    client.put("/api/v1/notification-preferences", prefs, format="json")
    mail.outbox.clear()
    create_task(owner, project, {"title": "Silent", "assigneeId": str(sam.id)})
    assert len(mail.outbox) == 0


def test_digest_delivery_queues_emails(owner, project, sam):
    NotificationPreference.objects.update_or_create(user=sam, defaults={"email_delivery": "hourly"})
    mail.outbox.clear()
    create_task(owner, project, {"title": "Later", "assigneeId": str(sam.id)})
    assert len(mail.outbox) == 0
    assert Notification.objects.filter(recipient=sam, email_pending=True).count() == 1
    call_command("send_notification_emails", "--delivery", "daily")
    assert len(mail.outbox) == 0
    call_command("send_notification_emails", "--delivery", "hourly")
    assert [m.to for m in mail.outbox] == [[sam.email]]
    assert not Notification.objects.filter(email_pending=True).exists()


def test_sprint_started_and_completed(owner, project, sam):
    NotificationPreference.objects.update_or_create(
        user=sam,
        defaults={
            "events": {**NotificationPreference(user=sam).events, "sprint_started": {"in_app": True, "email": True}}
        },
    )
    sprint = Sprint.objects.create(
        project=project, name="Sprint 14", number=14, start_date="2026-10-01", end_date="2026-10-14"
    )
    create_task(owner, project, {"title": "Mine", "sprintId": str(sprint.id), "assigneeId": str(sam.id), "estimate": 3})
    mail.outbox.clear()
    client = client_for(owner)
    client.post(f"/api/v1/sprints/{sprint.id}/start", {}, format="json")
    rows = [n for n in inbox(sam)["data"] if n["type"] == "sprint"]
    assert rows[0]["payload"] == {"sprintName": "Sprint 14"}
    assert any("Sprint 14" in m.subject for m in mail.outbox)
    mail.outbox.clear()
    client.post(f"/api/v1/sprints/{sprint.id}/complete", {"moveOpenTasksTo": "backlog"}, format="json")
    assert [m.to for m in mail.outbox] == [[sam.email]]
    assert "Sprint 14" in mail.outbox[0].subject


def test_access_request_notifies_project_admins(owner, ws, project):
    requester = add_member(ws, key="member")
    client_for(requester).post(f"/api/v1/projects/{project.id}/access-requests", {}, format="json")
    rows = inbox(owner)["data"]
    assert rows[0]["payload"]["quote"] == f"{requester.name} requested access to {project.name}"


def test_due_soon_command_is_idempotent(owner, project, sam, st):
    tomorrow = timezone.now().date() + dt.timedelta(days=1)
    task = create_task(owner, project, {"title": "Due", "assigneeId": str(sam.id), "dueDate": tomorrow.isoformat()})
    create_task(
        owner,
        project,
        {"title": "Done", "assigneeId": str(sam.id), "dueDate": tomorrow.isoformat(), "statusId": str(st["done"].id)},
    )
    create_task(owner, project, {"title": "Nobody", "dueDate": tomorrow.isoformat()})
    mail.outbox.clear()
    call_command("send_due_soon")
    call_command("send_due_soon")
    due = [n for n in inbox(sam)["data"] if n["type"] == "due"]
    assert len(due) == 1
    assert due[0]["taskId"] == str(task.id)
    assert due[0]["payload"] == {"dueDate": tomorrow.isoformat()}
    assert len(mail.outbox) == 1
    assert "PRJ-1" in mail.outbox[0].body
    call_command("send_due_soon", "--today")


def test_read_unread_read_all_and_undo(owner, project, sam):
    for i in range(3):
        create_task(owner, project, {"title": f"T{i}", "assigneeId": str(sam.id)})
    client = client_for(sam)
    rows = inbox(sam)["data"]
    one = client.post(f"/api/v1/notifications/{rows[0]['id']}/read", {"read": True}, format="json").json()
    assert one["readAt"] is not None
    assert client.get("/api/v1/notifications/unread-count").json() == {"count": 2}
    assert len(client.get("/api/v1/notifications?filter[unread]=true").json()["data"]) == 2
    back = client.post(f"/api/v1/notifications/{rows[0]['id']}/read", {"read": False}, format="json").json()
    assert back["readAt"] is None
    changed = client.post("/api/v1/notifications/read-all", {}, format="json").json()["ids"]
    assert len(changed) == 3
    assert client.get("/api/v1/notifications/unread-count").json() == {"count": 0}
    undone = client.post("/api/v1/notifications/read-all", {"ids": changed[:2], "unread": True}, format="json").json()
    assert sorted(undone["ids"]) == sorted(changed[:2])
    assert client.get("/api/v1/notifications/unread-count").json() == {"count": 2}
    assert client.post("/api/v1/notifications/read-all", {"ids": "x"}, format="json").status_code == 422
    assert client.get("/api/v1/notifications?filter[tab]=bogus").status_code == 422
    # Someone else's notification is invisible.
    assert client_for(owner).post(f"/api/v1/notifications/{rows[0]['id']}/read", {}, format="json").status_code == 404


def test_workspace_filter_and_removed_members(owner, ws, project, sam):
    create_task(owner, project, {"title": "T", "assigneeId": str(sam.id)})
    client = client_for(sam)
    assert client.get(f"/api/v1/notifications?filter[workspace]={ws.id}").json()["counts"]["all"] == 1
    assert (
        client.get("/api/v1/notifications?filter[workspace]=00000000-0000-0000-0000-000000000000").json()["counts"][
            "all"
        ]
        == 0
    )
    assert client.get("/api/v1/notifications?filter[workspace]=nope").json()["counts"]["all"] == 0
    assert client.get(f"/api/v1/notifications/unread-count?filter[workspace]={ws.id}").json()["count"] == 1
    from apps.projects.models import ProjectMember

    ProjectMember.objects.filter(user=sam, project=project).delete()
    assert client.get("/api/v1/notifications").json()["counts"]["all"] == 0


def test_outbox_is_processed_once_and_failures_retry(owner, project, sam, monkeypatch):
    event = DomainEvent.objects.create(
        type="task_assigned", workspace=project.workspace, project=project, actor=owner, payload={"taskId": None}
    )
    assert process_event(event.pk) is True
    assert process_event(event.pk) is False  # already processed
    boom = DomainEvent.objects.create(type="status_change", workspace=project.workspace, project=project, payload={})

    def explode(_event):
        raise RuntimeError("smtp down")

    from apps.notifications import handlers

    monkeypatch.setitem(handlers.HANDLERS, "status_change", explode)
    assert process_event(boom.pk) is False
    boom.refresh_from_db()
    assert boom.processed_at is None
    assert boom.attempts == 1
    assert "smtp down" in boom.error
    monkeypatch.setitem(handlers.HANDLERS, "status_change", lambda e: None)
    call_command("process_outbox")
    boom.refresh_from_db()
    assert boom.processed_at is not None


def test_unknown_event_types_are_marked_processed(project):
    event = DomainEvent.objects.create(type="something_new", workspace=project.workspace, payload={})
    assert process_event(event.pk) is True


def test_comment_text_quote_is_plain(owner, project, sam):
    task = create_task(owner, project, {"title": "T", "assigneeId": str(sam.id)})
    client_for(owner).post(f"/api/v1/tasks/{task.id}/comments", {"body": plain_doc("<b>not html</b>")}, format="json")
    row = next(n for n in inbox(sam)["data"] if n["type"] == "comment")
    assert row["payload"]["quote"] == "<b>not html</b>"  # stored as text, the client renders it as text
