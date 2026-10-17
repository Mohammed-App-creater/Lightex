"""The platform is generic (contract §5, architecture §12): the test-only `fake` module registers `fake.widget` and,
with no change to core, gets comments, attachments, comment notifications, search results, audit entries, trash and
realtime hints."""

import uuid

import pytest

from core.audit.models import AuditLog
from core.collab.models import Attachment, Comment
from core.collab.storage import get_storage
from core.common.testing import UserFactory, add_member, client_for, make_workspace
from core.events.services import emit
from core.notifications.models import Notification
from core.realtime.models import RealtimeEvent
from core.tests.fake_module.models import Widget

pytestmark = pytest.mark.django_db

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24


def doc(text, *mentions):
    content = [{"type": "text", "text": text}]
    content += [{"type": "mention", "attrs": {"id": str(u.id), "label": u.name}} for u in mentions]
    return {"type": "doc", "content": [{"type": "paragraph", "content": content}]}


@pytest.fixture
def people(ws, owner):
    """owner (Alex) owns the widget; Sam comments; Kim is mentioned; Lee is in another workspace."""
    sam = add_member(ws, UserFactory(name="Sam Rivera"))
    kim = add_member(ws, UserFactory(name="Kim Lo"))
    lee = UserFactory(name="Lee Outsider")
    make_workspace(lee, name="Elsewhere", slug="elsewhere")
    return {"sam": sam, "kim": kim, "lee": lee}


@pytest.fixture
def widget(ws, owner):
    return Widget.objects.create(workspace=ws, title="Quarterly sprocket", owner=owner)


def url(widget, tail):
    return f"/api/v1/targets/fake.widget/{widget.id}/{tail}"


def test_comments_on_a_fake_target(widget, people):
    sam = client_for(people["sam"])
    res = sam.post(url(widget, "comments"), {"body": doc("Looks good ")}, format="json")
    assert res.status_code == 201, res.json()
    body = res.json()
    assert body["targetType"] == "fake.widget"
    assert body["targetId"] == str(widget.id)
    assert "taskId" not in body
    listed = sam.get(url(widget, "comments")).json()
    assert [c["id"] for c in listed] == [body["id"]]
    comment = Comment.objects.get(pk=body["id"])
    assert comment.workspace_id == widget.workspace_id
    # Edit and delete through the generic routes; the resolver's rules apply.
    assert sam.patch(f"/api/v1/comments/{comment.id}", {"body": doc("Edited")}, format="json").status_code == 200
    kim = client_for(people["kim"])
    assert kim.delete(f"/api/v1/comments/{comment.id}").status_code == 403
    assert client_for(widget.owner).delete(f"/api/v1/comments/{comment.id}").status_code == 204


def test_fake_targets_are_isolated_by_workspace(widget, people):
    lee = client_for(people["lee"])
    assert lee.get(url(widget, "comments")).status_code == 404
    assert lee.post(url(widget, "comments"), {"body": doc("hi")}, format="json").status_code == 404
    assert lee.get(url(widget, "attachments")).status_code == 404
    sam = client_for(people["sam"])
    assert sam.get(f"/api/v1/targets/fake.nothing/{widget.id}/comments").status_code == 404
    assert sam.get(f"/api/v1/targets/fake.widget/{uuid.uuid4()}/comments").status_code == 404


def test_attachments_on_a_fake_target(widget, people):
    sam = client_for(people["sam"])
    ticket = sam.post(
        url(widget, "attachments/upload-url"), {"fileName": "shot.png", "size": len(PNG), "mimeType": "image/png"}
    )
    assert ticket.status_code == 200, ticket.json()
    upload_id = ticket.json()["uploadId"]
    attachment = Attachment.objects.get(pk=upload_id)
    assert attachment.storage_key.startswith(f"ws/{widget.workspace_id}/fake.widget/{widget.id}/")
    get_storage().put(attachment.storage_key, PNG, "image/png")
    confirmed = sam.post(f"/api/v1/attachments/{upload_id}/confirm")
    assert confirmed.status_code == 200, confirmed.json()
    assert confirmed.json()["targetType"] == "fake.widget"
    files = sam.get(url(widget, "attachments")).json()
    assert [(f["id"], f["targetId"]) for f in files] == [(upload_id, str(widget.id))]
    assert sam.get(f"/api/v1/attachments/{upload_id}/download-url").status_code == 200
    assert client_for(people["lee"]).get(f"/api/v1/attachments/{upload_id}/download-url").status_code == 404


def test_comment_notifications_for_subscribers_and_mentions(widget, people, owner):
    sam = client_for(people["sam"])
    sam.post(url(widget, "comments"), {"body": doc("Ping ", people["kim"])}, format="json")
    mention = Notification.objects.get(recipient=people["kim"])
    assert (mention.kind, mention.target_type, mention.target_id) == ("mention", "fake.widget", widget.id)
    assert mention.title == "Quarterly sprocket"
    assert mention.link.endswith(f"/widgets/{widget.id}")
    assert mention.scope_id is None
    subscriber = Notification.objects.get(recipient=owner)  # the widget's owner is its subscriber
    assert (subscriber.kind, subscriber.type) == ("comment", "core.comment.created")  # display kind, event type
    assert not Notification.objects.filter(recipient=people["sam"]).exists()  # never the actor
    inbox = client_for(people["kim"]).get("/api/v1/notifications").json()
    assert inbox["counts"]["mentions"] == 1
    row = inbox["data"][0]
    assert (row["targetType"], row["targetId"], row["projectId"]) == ("fake.widget", str(widget.id), None)
    assert row["link"].endswith(f"/widgets/{widget.id}")


def test_module_events_reach_registered_handlers(ws, widget, people, owner):
    emit(
        "fake.widget.pinged",
        workspace=ws,
        target_type="fake.widget",
        target_id=widget.id,
        actor=owner,
        payload={"userIds": [str(people["sam"].id), str(people["lee"].id)], "note": "hello"},
    )
    rows = Notification.objects.filter(event__type="fake.widget.pinged")
    assert [(n.recipient_id, n.payload) for n in rows] == [(people["sam"].id, {"note": "hello"})]  # lee can't see it


def test_search_fans_out_to_the_fake_provider(widget, people):
    sam = client_for(people["sam"])
    res = sam.get("/api/v1/workspaces/platform/search?q=sprocket&filter[type]=widget")
    assert res.status_code == 200
    assert [(r["type"], r["targetType"], r["targetId"]) for r in res.json()] == [
        ("widget", "fake.widget", str(widget.id))
    ]
    everywhere = sam.get("/api/v1/search?q=sprocket&type=widget").json()["data"]
    assert [r["targetId"] for r in everywhere] == [str(widget.id)]
    assert client_for(people["lee"]).get("/api/v1/search?q=sprocket&type=widget").json()["data"] == []


def test_audit_entries_for_fake_targets(ws, widget, people, owner):
    from core.audit.services import record

    record(workspace=ws, actor=owner, action="fake.widget.created", target=widget.title, entity_id=widget.id)
    client_for(people["sam"]).post(url(widget, "comments"), {"body": doc("Noted")}, format="json")
    row = AuditLog.objects.get(action="fake.widget.created")
    assert (row.module, row.target_type, row.target_id) == ("fake", "fake.widget", str(widget.id))
    comment_row = AuditLog.objects.get(action="core.comment.created")
    assert (comment_row.module, comment_row.target_type, comment_row.target) == ("core", "core.comment", widget.title)
    res = client_for(owner).get("/api/v1/workspaces/platform/audit?filter[entity]=widget").json()
    assert [(r["action"], r["module"], r["targetType"], r["targetId"]) for r in res["data"]] == [
        ("fake.widget.created", "fake", "fake.widget", str(widget.id))
    ]


def test_trash_lists_and_restores_fake_items(widget, people):
    sam = people["sam"]
    Widget.all_objects.filter(pk=widget.pk).update(deleted_at=widget.created_at, deleted_by=sam)
    listed = client_for(sam).get("/api/v1/workspaces/platform/trash").json()
    assert [(i["kind"], i["module"], i["id"]) for i in listed["data"]] == [("fake.widget", "fake", str(widget.id))]
    assert "fake.widget" in listed["kinds"]
    res = client_for(sam).post(f"/api/v1/trash/fake.widget/{widget.id}/restore")
    assert res.status_code == 200, res.json()
    assert Widget.objects.filter(pk=widget.pk).exists()


def test_comment_realtime_hints_carry_the_target(widget, people):
    RealtimeEvent.objects.all().delete()
    client_for(people["sam"]).post(url(widget, "comments"), {"body": doc("Live")}, format="json")
    event = RealtimeEvent.objects.get(type="core.comment.created")
    data = event.payload["data"]
    assert (data["targetType"], data["targetId"]) == ("fake.widget", str(widget.id))
    assert data["commentId"] == str(Comment.objects.get().pk)
    assert event.scope_id is None  # no project scope: a workspace-wide hint


def test_check_orphan_targets_reports_references_to_missing_records(widget, people):
    from django.core.management import CommandError, call_command

    from core.common.management.commands.check_orphan_targets import find_orphans

    client_for(people["sam"]).post(url(widget, "comments"), {"body": doc("Soon gone")}, format="json")
    assert "comments" not in find_orphans()
    Widget.all_objects.filter(pk=widget.pk).delete()  # a hard delete that skipped the module's purge
    assert find_orphans()["comments"] == [("fake.widget", str(widget.id))]
    with pytest.raises(CommandError):
        call_command("check_orphan_targets")


def test_purge_keeps_comments_and_attachments_of_a_disabled_module(ws, owner, widget):
    """Stage 5 (contract §1.6): disabling a module never deletes its data, so the trash purge skips generic rows whose
    target belongs to a module that is off in their workspace, and purges them once it is back on."""
    import datetime as dt

    from django.utils import timezone

    from core.access.services import sync_permission_catalogue
    from core.audit.trash import purge_expired
    from core.modules import services as modules
    from core.tests.fake_module import module as fake

    fake.register()  # toggleable, off until enabled
    sync_permission_catalogue()
    try:
        old = timezone.now() - dt.timedelta(days=40)
        comment = Comment.objects.create(
            workspace=ws, target_type="fake.widget", target_id=widget.pk, author=owner, body=doc("old"),
            body_text="old", deleted_at=old,
        )  # fmt: skip
        attachment = Attachment.objects.create(
            workspace=ws, target_type="fake.widget", target_id=widget.pk, uploader=owner, file_name="a.png", size=1,
            mime_type="image/png", kind="image", storage_key=f"ws/{ws.pk}/fake/{widget.pk}/old", status="ready",
            deleted_at=old,
        )  # fmt: skip
        assert not modules.is_enabled(ws, "fake")
        purge_expired()
        assert Comment.all_objects.filter(pk=comment.pk).exists()
        assert Attachment.all_objects.filter(pk=attachment.pk).exists()
        modules.set_module_enabled(owner, ws, "fake", True)
        purge_expired()
        assert not Comment.all_objects.filter(pk=comment.pk).exists()
        assert not Attachment.all_objects.filter(pk=attachment.pk).exists()
    finally:
        fake.unregister()
