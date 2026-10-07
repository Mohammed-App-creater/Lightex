import pytest
from django.test import override_settings

from apps.audit.models import AuditLog
from apps.collaboration.models import Attachment, Comment
from apps.collaboration.services import classify, clean_file_name
from apps.collaboration.storage import FakeStorage, LocalStorage, content_disposition, get_storage
from apps.common.exceptions import ApiError
from apps.common.richtext import plain_doc
from apps.common.testing import UserFactory, add_project_member, client_for, make_project
from apps.tasks.services import create_task

pytestmark = pytest.mark.django_db

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def task(owner, project):
    return create_task(owner, project, {"title": "Upload here"})


@pytest.fixture
def fake():
    storage = get_storage()
    assert isinstance(storage, FakeStorage)
    storage.objects.clear()
    return storage


def mention(user):
    return {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "Ping "},
                    {"type": "mention", "attrs": {"id": str(user.id), "label": user.name}},
                ],
            }
        ],
    }


# ───────────────────────── comments ─────────────────────────


def test_comment_crud_and_mentions(owner, project, task):
    member = add_project_member(project, key="project_member")
    stranger = UserFactory()
    client = client_for(owner)
    doc = mention(member)
    doc["content"][0]["content"].append({"type": "mention", "attrs": {"id": str(stranger.id), "label": "Nope"}})
    doc["content"][0]["content"].append({"type": "script", "text": "x"})
    res = client.post(f"/api/v1/tasks/{task.id}/comments", {"body": doc}, format="json")
    assert res.status_code == 201
    body = res.json()
    assert body["mentions"] == [str(member.id)]  # people outside the project can't be mentioned
    assert set(body) == {"id", "taskId", "authorId", "body", "mentions", "createdAt", "editedAt"}
    assert all(n["type"] != "script" for n in body["body"]["content"][0]["content"])
    listed = client.get(f"/api/v1/tasks/{task.id}/comments").json()
    assert [c["id"] for c in listed] == [body["id"]]
    assert client.get(f"/api/v1/tasks/{task.id}").json()["commentCount"] == 1
    edited = client.patch(f"/api/v1/comments/{body['id']}", {"body": plain_doc("Edited")}, format="json")
    assert edited.json()["editedAt"] is not None
    assert edited.json()["mentions"] == []
    assert AuditLog.objects.filter(action="comment.created").exists()
    activity = client.get(f"/api/v1/tasks/{task.id}/activity").json()
    assert activity[0]["verb"] == "commented"


def test_comment_validation(owner, task):
    client = client_for(owner)
    for body in [None, {"type": "doc"}, plain_doc("   "), plain_doc("x" * 2001), "<b>html</b>"]:
        assert client.post(f"/api/v1/tasks/{task.id}/comments", {"body": body}, format="json").status_code == 422


def test_comment_permissions(owner, project, task):
    member = add_project_member(project, key="project_member")
    viewer = add_project_member(project, key="viewer")
    manager = add_project_member(project, key="manager")
    assert (
        client_for(viewer)
        .post(f"/api/v1/tasks/{task.id}/comments", {"body": plain_doc("hi")}, format="json")
        .status_code
        == 403
    )
    mine = (
        client_for(member).post(f"/api/v1/tasks/{task.id}/comments", {"body": plain_doc("mine")}, format="json").json()
    )
    owners = (
        client_for(owner).post(f"/api/v1/tasks/{task.id}/comments", {"body": plain_doc("owner")}, format="json").json()
    )
    m = client_for(member)
    assert m.patch(f"/api/v1/comments/{owners['id']}", {"body": plain_doc("hack")}, format="json").status_code == 403
    assert m.delete(f"/api/v1/comments/{owners['id']}").status_code == 403
    assert m.delete(f"/api/v1/comments/{mine['id']}").status_code == 204
    # comment.delete_any removes anyone's.
    assert client_for(manager).delete(f"/api/v1/comments/{owners['id']}").status_code == 204
    assert Comment.all_objects.get(pk=owners["id"]).deleted_by == manager
    assert client_for(owner).get(f"/api/v1/tasks/{task.id}/comments").json() == []
    assert (
        client_for(owner).patch(f"/api/v1/comments/{mine['id']}", {"body": plain_doc("x")}, format="json").status_code
        == 404
    )
    outsider = UserFactory()
    assert client_for(outsider).get(f"/api/v1/tasks/{task.id}/comments").status_code == 404


# ───────────────────────── upload rules ─────────────────────────


@pytest.mark.parametrize(
    ("name", "mime", "kind", "stored"),
    [
        ("shot.png", "image/png", "image", "image/png"),
        ("photo.JPG", "", "image", "image/jpeg"),
        ("logo.svg", "image/svg+xml", "code", "image/svg+xml"),
        ("main.py", "text/x-python", "code", "text/x-python"),
        ("notes.md", "text/markdown", "text", "text/markdown"),
        ("page.html", "text/html", "code", "text/html"),
        ("data.json", "application/json", "code", "application/json"),
        ("build.log", "", "text", "application/octet-stream"),
    ],
)
def test_classify_allowed(name, mime, kind, stored):
    assert classify(name, mime, 100) == (kind, stored)


@pytest.mark.parametrize(
    ("name", "mime", "size"),
    [
        ("evil.exe", "application/octet-stream", 10),
        ("pic.png", "text/html", 10),
        ("pic.png", "image/jpeg", 10),
        ("code.py", "image/png", 10),
        ("notes.txt", "text/html", 10),
        ("archive.zip", "application/zip", 10),
        ("doc.pdf", "application/pdf", 10),
        ("big.png", "image/png", 10 * 1024 * 1024 + 1),
        ("empty.txt", "text/plain", 0),
        ("noext", "text/plain", 10),
        ("x.svg", "text/html", 10),
        ("x.py", "application/pdf", 10),
    ],
)
def test_classify_rejected(name, mime, size):
    with pytest.raises(ApiError):
        classify(name, mime, size)


def test_file_names_are_cleaned():
    assert clean_file_name("../../etc/passwd") == "passwd"
    assert clean_file_name("C:\\temp\\a\x00b.txt") == "ab.txt"
    assert (
        content_disposition('we"ird ñame.txt', False)
        == "attachment; filename=\"weird ame.txt\"; filename*=UTF-8''we%22ird%20%C3%B1ame.txt"
    )


# ───────────────────────── upload flow ─────────────────────────


def upload(client, task, name="shot.png", mime="image/png", size=PNG_SIZE):
    return client.post(
        f"/api/v1/tasks/{task.id}/attachments/upload-url",
        {"fileName": name, "size": size, "mimeType": mime},
        format="json",
    )


def test_upload_confirm_and_download(owner, task, fake):
    client = client_for(owner)
    ticket = upload(client, task)
    assert ticket.status_code == 200
    t = ticket.json()
    assert t["method"] == "PUT"
    assert t["headers"] == {"Content-Type": "image/png"}
    attachment = Attachment.objects.get(pk=t["uploadId"])
    assert attachment.storage_key.startswith(f"ws/{task.project.workspace_id}/p/{task.project_id}/t/{task.id}/")
    assert "shot" not in attachment.storage_key
    missing = client.post(f"/api/v1/tasks/{task.id}/attachments", {"uploadId": t["uploadId"]}, format="json")
    assert missing.status_code == 400
    assert missing.json()["code"] == "upload_missing"
    fake.put(attachment.storage_key, PNG, "image/png")
    res = client.post(f"/api/v1/tasks/{task.id}/attachments", {"uploadId": t["uploadId"]}, format="json")
    assert res.status_code == 201
    body = res.json()
    assert body["kind"] == "image"
    assert "cd=attachment" in body["downloadUrl"]
    assert "cd=inline" in body["previewUrl"]
    listed = client.get(f"/api/v1/tasks/{task.id}/attachments").json()
    assert [a["id"] for a in listed] == [body["id"]]
    assert client.get(f"/api/v1/tasks/{task.id}").json()["attachmentCount"] == 1
    dl = client.get(f"/api/v1/attachments/{body['id']}/download-url").json()
    assert dl["url"].startswith("https://storage.test/download/")
    assert AuditLog.objects.filter(action="attachment.created").exists()
    # Confirming twice fails: it's no longer pending.
    assert (
        client.post(f"/api/v1/tasks/{task.id}/attachments", {"uploadId": t["uploadId"]}, format="json").status_code
        == 400
    )


def test_svg_and_html_are_never_inline(owner, task, fake):
    client = client_for(owner)
    svg = b"<svg onload=alert(1)>"
    t = upload(client, task, name="logo.svg", mime="image/svg+xml", size=len(svg)).json()
    fake.put(Attachment.objects.get(pk=t["uploadId"]).storage_key, svg, "image/svg+xml")
    body = client.post(f"/api/v1/attachments/{t['uploadId']}/confirm").json()
    assert body["previewUrl"] is None
    assert "type=application/octet-stream" in body["downloadUrl"]
    assert "cd=attachment" in body["downloadUrl"]


def test_confirm_rejects_mismatches_and_deletes_the_object(owner, task, fake):
    client = client_for(owner)
    t = upload(client, task, size=len(PNG)).json()
    key = Attachment.objects.get(pk=t["uploadId"]).storage_key
    fake.put(key, PNG + b"extra", "image/png")  # bigger than declared
    res = client.post(f"/api/v1/tasks/{task.id}/attachments", {"uploadId": t["uploadId"]}, format="json")
    assert res.status_code == 422
    assert res.json()["code"] == "upload_rejected"
    assert fake.head(key) is None
    assert Attachment.objects.filter(pk=t["uploadId"]).count() == 0
    # Wrong content type
    t2 = upload(client, task).json()
    key2 = Attachment.objects.get(pk=t2["uploadId"]).storage_key
    fake.put(key2, PNG, "text/html")
    assert (
        client.post(f"/api/v1/tasks/{task.id}/attachments", {"uploadId": t2["uploadId"]}, format="json").status_code
        == 422
    )
    # Right size and type, but not actually a PNG
    t3 = upload(client, task, size=10).json()
    key3 = Attachment.objects.get(pk=t3["uploadId"]).storage_key
    fake.put(key3, b"<html>hi</", "image/png")
    res3 = client.post(f"/api/v1/tasks/{task.id}/attachments", {"uploadId": t3["uploadId"]}, format="json")
    assert res3.status_code == 422
    assert fake.head(key3) is None


def test_webp_magic_bytes(owner, task, fake):
    client = client_for(owner)
    good = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 8
    t = upload(client, task, name="a.webp", mime="image/webp", size=len(good)).json()
    fake.put(Attachment.objects.get(pk=t["uploadId"]).storage_key, good, "image/webp")
    assert client.post(f"/api/v1/attachments/{t['uploadId']}/confirm").status_code == 200
    bad = b"RIFF\x00\x00\x00\x00WAVEfmt " + b"\x00" * 8
    t2 = upload(client, task, name="b.webp", mime="image/webp", size=len(bad)).json()
    fake.put(Attachment.objects.get(pk=t2["uploadId"]).storage_key, bad, "image/webp")
    assert client.post(f"/api/v1/attachments/{t2['uploadId']}/confirm").status_code == 422


def test_upload_validation_and_permissions(owner, project, task, fake):
    client = client_for(owner)
    assert upload(client, task, name="virus.exe", mime="application/x-msdownload").status_code == 422
    assert upload(client, task, size=11 * 1024 * 1024).status_code == 422
    viewer = add_project_member(project, key="viewer")
    assert upload(client_for(viewer), task).status_code == 403
    member = add_project_member(project, key="project_member")
    t = upload(client, task).json()
    # Only the uploader can confirm their upload.
    assert (
        client_for(member)
        .post(f"/api/v1/tasks/{task.id}/attachments", {"uploadId": t["uploadId"]}, format="json")
        .status_code
        == 400
    )
    assert client.post(f"/api/v1/tasks/{task.id}/attachments", {"uploadId": "nope"}, format="json").status_code == 400


def test_delete_attachment_rules(owner, project, task, fake):
    member = add_project_member(project, key="project_member")
    manager = add_project_member(project, key="manager")

    def ready(user):
        t = upload(client_for(user), task).json()
        fake.put(Attachment.objects.get(pk=t["uploadId"]).storage_key, PNG, "image/png")
        return client_for(user).post(f"/api/v1/attachments/{t['uploadId']}/confirm").json()["id"]

    owners = ready(owner)
    mine = ready(member)
    assert client_for(member).delete(f"/api/v1/attachments/{owners}").status_code == 403
    assert client_for(member).delete(f"/api/v1/attachments/{mine}").status_code == 204
    assert client_for(manager).delete(f"/api/v1/attachments/{owners}").status_code == 204
    assert client_for(owner).get(f"/api/v1/tasks/{task.id}/attachments").json() == []
    assert client_for(owner).get(f"/api/v1/attachments/{owners}/download-url").status_code == 404


def test_pending_attachment_has_no_download(owner, task, fake):
    t = upload(client_for(owner), task).json()
    assert client_for(owner).get(f"/api/v1/attachments/{t['uploadId']}/download-url").status_code == 404


# ───────────────────────── local storage (dev) ─────────────────────────


def test_local_storage_roundtrip(owner, task, tmp_path, settings, api):
    settings.MEDIA_ROOT = tmp_path
    settings.STORAGE_BACKEND = "local"
    get_storage.cache_clear()
    try:
        client = client_for(owner)
        t = upload(client, task).json()
        assert t["url"].startswith("http://localhost:8000/api/v1/storage/upload/")
        path = t["url"].split("localhost:8000")[1]
        wrong = api.generic("PUT", path, PNG, content_type="text/html")
        assert wrong.status_code == 400
        ok = api.generic("PUT", path, PNG, content_type="image/png")
        assert ok.status_code == 200
        body = client.post(f"/api/v1/tasks/{task.id}/attachments", {"uploadId": t["uploadId"]}, format="json").json()
        dl = api.get(body["downloadUrl"].split("localhost:8000")[1])
        assert dl.status_code == 200
        assert dl["X-Content-Type-Options"] == "nosniff"
        assert dl["Content-Disposition"].startswith("attachment;")
        assert b"".join(dl.streaming_content) == PNG
        assert api.get("/api/v1/storage/download/garbage").status_code == 403
        assert api.generic("PUT", "/api/v1/storage/upload/garbage", b"x", content_type="image/png").status_code == 403
        storage = get_storage()
        assert isinstance(storage, LocalStorage)
        with pytest.raises(ValueError):
            storage.path("../../escape")
        key = Attachment.objects.get(pk=t["uploadId"]).storage_key
        storage.delete(key)
        assert storage.head(key) is None
    finally:
        settings.STORAGE_BACKEND = "fake"
        get_storage.cache_clear()


@override_settings(STORAGE_BACKEND="fake")
def test_local_endpoints_are_off_without_local_storage(api):
    get_storage.cache_clear()
    assert api.get("/api/v1/storage/download/x").status_code == 404
    assert api.generic("PUT", "/api/v1/storage/upload/x", b"x", content_type="image/png").status_code == 404
