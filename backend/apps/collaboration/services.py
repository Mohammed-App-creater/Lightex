"""Comments (with mentions) and attachments (signed upload → verify → ready)."""

from __future__ import annotations

import re
import uuid
from typing import Any

from django.conf import settings
from django.contrib.postgres.search import SearchVector
from django.db import transaction
from django.utils import timezone

from apps.access import services as access
from apps.audit.services import change, record
from apps.common.exceptions import ApiError, forbidden, invalid, not_found
from apps.common.richtext import doc_text, mention_ids, sanitize_doc
from apps.notifications.events import emit
from apps.projects.models import ProjectMember

from .models import Attachment, Comment, CommentMention
from .storage import get_storage

MAX_COMMENT_CHARS = 2000

# ───────────────────────── file rules (mirror the client's src/lib/files.ts) ─────────────────────────

RASTER_EXT = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
SVG_EXT = {"svg"}
CODE_EXT = {
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "swift", "rb", "php", "c", "h",
    "cpp", "cs", "json", "yml", "yaml", "toml", "xml", "md", "sql", "sh", "css", "scss", "html", "txt", "diff",
    "patch", "log", "csv",
}  # fmt: skip
TEXT_EXT = {"txt", "md", "diff", "log"}
MAGIC = {
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    "image/webp": (b"RIFF",),
}
_UNSAFE_NAME = re.compile(r"[\x00-\x1f\x7f/\\]+")


def extension(name: str) -> str:
    match = re.search(r"\.([A-Za-z0-9]+)$", name or "")
    return match.group(1).lower() if match else ""


def clean_file_name(name: Any) -> str:
    base = str(name or "").replace("\\", "/").split("/")[-1]
    return _UNSAFE_NAME.sub("", base).strip()[:120]


def classify(file_name: str, mime: str, size: Any) -> tuple[str, str]:
    """Returns (kind, stored content type) or raises 422 with the client's copy."""
    ext = extension(file_name)
    mime = (mime or "").split(";")[0].strip().lower()
    if not file_name or ext not in RASTER_EXT and ext not in SVG_EXT and ext not in CODE_EXT:
        raise invalid({"file": "Images or code files only"})
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        raise invalid({"file": "The file is empty"})
    if size > settings.MAX_UPLOAD_BYTES:
        raise invalid({"file": f"Too large · {size / (1024 * 1024):.1f} MB (max 10)"})
    if ext in RASTER_EXT:
        if mime and mime != RASTER_EXT[ext]:
            raise invalid({"file": "Images or code files only"})
        return "image", RASTER_EXT[ext]
    if ext in SVG_EXT:
        if mime and mime != "image/svg+xml":
            raise invalid({"file": "Images or code files only"})
        return "code", "image/svg+xml"
    if mime.startswith(("image/", "audio/", "video/")) or ("html" in mime and ext != "html"):
        raise invalid({"file": "Images or code files only"})
    allowed_mime = (
        not mime
        or mime.startswith("text/")
        or mime == "application/octet-stream"
        or mime
        in {"application/json", "application/xml", "application/javascript", "application/sql", "application/yaml"}
        or mime.startswith("application/x-")
        or mime.startswith("application/toml")
    )
    if not allowed_mime:
        raise invalid({"file": "Images or code files only"})
    return ("text" if ext in TEXT_EXT else "code"), mime or "application/octet-stream"


# ───────────────────────── comments ─────────────────────────


def _project_mentions(task: Any, doc: dict | None) -> list[str]:
    """Only project members can be mentioned (and therefore notified)."""
    ids = [i for i in mention_ids(doc) if _is_uuid(i)]
    members = set(
        map(
            str,
            ProjectMember.objects.filter(project_id=task.project_id, user_id__in=ids).values_list("user_id", flat=True),
        )
    )
    return [i for i in ids if i in members]


def _is_uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def _comment_body(raw: Any) -> tuple[dict, str]:
    body = sanitize_doc(raw, field="body", allow_null=False)
    text = doc_text(body)
    if not text:
        raise invalid({"body": "Write something first"})
    if len(text) > MAX_COMMENT_CHARS:
        raise invalid({"body": "Keep comments under 2,000 characters"})
    return body or {"type": "doc"}, text


def _set_mentions(comment: Comment, ids: list[str]) -> None:
    CommentMention.objects.filter(comment=comment).delete()
    CommentMention.objects.bulk_create([CommentMention(comment=comment, user_id=i) for i in ids])


def _refresh_comment_search(comment: Comment) -> None:
    Comment.all_objects.filter(pk=comment.pk).update(search_vector=SearchVector("body_text", config="english"))


def _audit_comment(comment: Comment, actor: Any, action: str, changes: list | None = None) -> None:
    task = comment.task
    record(
        workspace=task.project.workspace_id,
        project=task.project_id,
        task=task,
        actor=actor,
        action=action,
        target=task.title,
        entity_id=comment.pk,
        entity_key=task.key,
        changes=changes,
    )


@transaction.atomic
def create_comment(actor: Any, task: Any, raw: Any) -> Comment:
    if not access.can(actor, "comment.create", task.project):
        raise forbidden(details={"permission": "comment.create"})
    body, text = _comment_body(raw)
    comment = Comment.objects.create(task=task, author=actor, body=body, body_text=text)
    mentioned = _project_mentions(task, body)
    _set_mentions(comment, mentioned)
    _refresh_comment_search(comment)
    _audit_comment(comment, actor, "comment.created", [change("Comment", None, text[:200], "text")])
    quote = text[:140]
    if mentioned:
        emit(
            "mentioned",
            workspace=task.project.workspace_id,
            project=task.project_id,
            actor=actor,
            payload={"taskId": str(task.pk), "userIds": mentioned, "quote": quote, "commentId": str(comment.pk)},
        )
    watchers = [str(u) for u in {task.reporter_id, task.assignee_id} if u and str(u) not in mentioned]
    if watchers:
        emit(
            "comment",
            workspace=task.project.workspace_id,
            project=task.project_id,
            actor=actor,
            payload={"taskId": str(task.pk), "userIds": watchers, "quote": quote, "commentId": str(comment.pk)},
        )
    return comment


def get_comment(user: Any, comment_id: Any) -> Comment:
    from apps.tasks.selectors import task_for

    comment = (
        Comment.objects.select_related("task", "task__project").filter(pk=comment_id).first()
        if _is_uuid(comment_id)
        else None
    )
    if comment is None or comment.task.deleted_at is not None:
        raise not_found("Comment not found.")
    task_for(user, comment.task_id)
    return comment


@transaction.atomic
def update_comment(actor: Any, comment: Comment, raw: Any) -> Comment:
    if comment.author_id != actor.pk or not access.can(actor, "comment.edit_own", comment.task.project):
        raise forbidden("You can only edit your own comments.", {"permission": "comment.edit_own"})
    before_mentions = set(map(str, CommentMention.objects.filter(comment=comment).values_list("user_id", flat=True)))
    body, text = _comment_body(raw)
    before = comment.body_text
    comment.body = body
    comment.body_text = text
    comment.edited_at = timezone.now()
    comment.save()
    mentioned = _project_mentions(comment.task, body)
    _set_mentions(comment, mentioned)
    _refresh_comment_search(comment)
    _audit_comment(comment, actor, "comment.updated", [change("Comment", before[:200], text[:200], "text")])
    new = [m for m in mentioned if m not in before_mentions]
    if new:
        task = comment.task
        emit(
            "mentioned",
            workspace=task.project.workspace_id,
            project=task.project_id,
            actor=actor,
            payload={"taskId": str(task.pk), "userIds": new, "quote": text[:140], "commentId": str(comment.pk)},
        )
    return comment


@transaction.atomic
def delete_comment(actor: Any, comment: Comment) -> None:
    project = comment.task.project
    own = comment.author_id == actor.pk and access.can(actor, "comment.edit_own", project)
    if not own and not access.can(actor, "comment.delete_any", project):
        raise forbidden("You can’t delete this comment.", {"permission": "comment.delete_any"})
    comment.deleted_at = timezone.now()
    comment.deleted_by = actor
    comment.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    _audit_comment(comment, actor, "comment.deleted", [change("Comment", comment.body_text[:200], None)])


@transaction.atomic
def restore_comment(actor: Any, comment: Comment) -> Comment:
    comment.deleted_at = None
    comment.deleted_by = None
    comment.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    _audit_comment(comment, actor, "comment.restored")
    return comment


# ───────────────────────── attachments ─────────────────────────


def storage_key(task: Any) -> str:
    return f"ws/{task.project.workspace_id}/p/{task.project_id}/t/{task.pk}/{uuid.uuid4().hex}"


@transaction.atomic
def start_upload(actor: Any, task: Any, data: dict[str, Any]) -> tuple[Attachment, str, dict[str, str]]:
    if not access.can(actor, "attachment.upload", task.project):
        raise forbidden(details={"permission": "attachment.upload"})
    file_name = clean_file_name(data.get("fileName"))
    size = data.get("size")
    kind, content_type = classify(file_name, str(data.get("mimeType") or ""), size)
    attachment = Attachment.objects.create(
        task=task,
        uploader=actor,
        file_name=file_name,
        size=size,
        mime_type=content_type,
        kind=kind,
        storage_key=storage_key(task),
    )
    url, headers = get_storage().presigned_put(attachment.storage_key, content_type, settings.UPLOAD_URL_TTL_SECONDS)
    return attachment, url, headers


def pending_upload(actor: Any, task: Any, upload_id: Any) -> Attachment:
    attachment = (
        Attachment.objects.filter(pk=upload_id, task=task, uploader=actor, status="pending").first()
        if _is_uuid(upload_id)
        else None
    )
    if attachment is None:
        raise ApiError(400, "upload_missing", "Upload not found or incomplete. Try again.")
    return attachment


def _verification_problem(attachment: Attachment, info: Any) -> str | None:
    storage = get_storage()
    if info.size != attachment.size or info.size > settings.MAX_UPLOAD_BYTES:
        return "The uploaded file doesn’t match what was declared."
    if info.content_type.split(";")[0].strip().lower() != attachment.mime_type:
        return "The uploaded file type doesn’t match what was declared."
    if attachment.mime_type in MAGIC:
        head = storage.read_prefix(attachment.storage_key, 16)
        ok = any(head.startswith(sig) for sig in MAGIC[attachment.mime_type])
        if attachment.mime_type == "image/webp":
            ok = ok and head[8:12] == b"WEBP"
        if not ok:
            return "That file isn’t the image it claims to be."
    return None


def confirm_upload(actor: Any, attachment: Attachment) -> Attachment:
    """HEAD the object and check real size and type (plus magic bytes for raster images).
    A mismatch deletes the object and rejects the upload."""
    if not access.can(actor, "attachment.upload", attachment.task.project):
        raise forbidden(details={"permission": "attachment.upload"})
    storage = get_storage()
    info = storage.head(attachment.storage_key)
    if info is None:
        raise ApiError(400, "upload_missing", "Upload not found or incomplete. Try again.")
    problem = _verification_problem(attachment, info)
    if problem:
        storage.delete(attachment.storage_key)
        attachment.deleted_at = timezone.now()
        attachment.save(update_fields=["deleted_at", "updated_at"])
        raise ApiError(422, "upload_rejected", problem, {"fields": {"file": problem}})
    with transaction.atomic():
        attachment.status = "ready"
        attachment.save(update_fields=["status", "updated_at"])
        task = attachment.task
        record(
            workspace=task.project.workspace_id,
            project=task.project_id,
            task=task,
            actor=actor,
            action="attachment.created",
            target=task.title,
            entity_id=attachment.pk,
            entity_key=task.key,
            changes=[change("File", None, attachment.file_name)],
            data={"file": attachment.file_name},
        )
    return attachment


def get_attachment(user: Any, attachment_id: Any) -> Attachment:
    from apps.tasks.selectors import task_for

    attachment = (
        Attachment.objects.select_related("task", "task__project").filter(pk=attachment_id).first()
        if _is_uuid(attachment_id)
        else None
    )
    if attachment is None or attachment.task.deleted_at is not None:
        raise not_found("File not found.")
    task_for(user, attachment.task_id)
    return attachment


@transaction.atomic
def delete_attachment(actor: Any, attachment: Attachment) -> None:
    project = attachment.task.project
    own = attachment.uploader_id == actor.pk and access.can(actor, "attachment.upload", project)
    if not own and not access.can(actor, "attachment.delete_any", project):
        raise forbidden("You can’t delete this file.", {"permission": "attachment.delete_any"})
    attachment.deleted_at = timezone.now()
    attachment.deleted_by = actor
    attachment.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    task = attachment.task
    record(
        workspace=project.workspace_id,
        project=project,
        task=task,
        actor=actor,
        action="attachment.deleted",
        target=task.title,
        entity_id=attachment.pk,
        entity_key=task.key,
        changes=[change("File", attachment.file_name, None)],
    )


def download_urls(attachment: Attachment) -> dict[str, str | None]:
    """Short-lived signed URLs. Only raster images may be shown inline (previewUrl); everything
    else, including SVG and HTML, downloads as an opaque attachment."""
    storage = get_storage()
    ttl = settings.DOWNLOAD_URL_TTL_SECONDS
    raster = attachment.kind == "image" and attachment.mime_type in MAGIC
    download = storage.presigned_get(
        attachment.storage_key,
        file_name=attachment.file_name,
        content_type=attachment.mime_type if raster else "application/octet-stream",
        inline=False,
        expires=ttl,
    )
    preview = (
        storage.presigned_get(
            attachment.storage_key,
            file_name=attachment.file_name,
            content_type=attachment.mime_type,
            inline=True,
            expires=ttl,
        )
        if raster
        else None
    )
    return {"downloadUrl": download, "previewUrl": preview}
