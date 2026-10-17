"""Comments (with mentions) and attachments (signed upload → verify → ready) on any registered target.

Every permission decision goes through the target's resolver (core/common/targets.py); core holds no module
rules.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from django.conf import settings
from django.contrib.postgres.search import SearchVector
from django.db import transaction
from django.utils import timezone

from core.audit.services import change, record
from core.common.exceptions import ApiError, forbidden, invalid, not_found
from core.common.richtext import doc_text, mention_ids, sanitize_doc
from core.common.targets import TargetResolver, parse_id, resolver_for
from core.events.services import emit

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


# ───────────────────────── targets ─────────────────────────


def _deny(resolver: TargetResolver, action: str, message: str | None = None) -> ApiError:
    code = resolver.permission_codes.get(action)
    details = {"permission": code} if code else None
    return forbidden(message, details) if message else forbidden(details=details)


def target(user: Any, target_type: Any, target_id: Any) -> tuple[TargetResolver, uuid.UUID]:
    """The resolver and id of a target the user may see (404 for unknown types or ids, else the module's errors)."""
    resolver = resolver_for(target_type)
    pk = parse_id(target_id)
    if pk is None:
        raise not_found(resolver.not_found_message)
    resolver.require_view(user, pk)
    return resolver, pk


def _resolver(obj: Comment | Attachment) -> TargetResolver:
    return resolver_for(obj.target_type)


def _audit(obj: Comment | Attachment, actor: Any, action: str, **kwargs: Any) -> None:
    """One audit row; the target's describe() supplies the title and the scope hints (key, project, task)."""
    info = _resolver(obj).describe(obj.target_id)
    record(
        workspace=obj.workspace_id,
        project=info.get("projectId"),
        task=info.get("taskId"),
        task_key=info.get("key") if info.get("taskId") else None,
        task_title=info.get("title") if info.get("taskId") else None,
        actor=actor,
        action=action,
        target=info.get("title", ""),
        entity_id=obj.pk,
        entity_key=info.get("key"),
        **kwargs,
    )


def _publish(obj: Comment | Attachment, actor: Any, event_type: str) -> None:
    """`core.comment.*` / `core.attachment.*` realtime hints: `{targetType, targetId, commentId | attachmentId}`."""
    from core.realtime.services import publish

    info = _resolver(obj).describe(obj.target_id)
    id_key = "commentId" if isinstance(obj, Comment) else "attachmentId"
    publish(
        event_type,
        workspace=obj.workspace_id,
        project=info.get("projectId"),
        actor=actor,
        data={"targetType": obj.target_type, "targetId": str(obj.target_id), id_key: str(obj.pk)},
    )


# ───────────────────────── comments ─────────────────────────


def _mentions(resolver: TargetResolver, target_id: Any, doc: dict | None) -> list[str]:
    """Only people the resolver allows can be mentioned (and therefore notified)."""
    ids = [i for i in mention_ids(doc) if _is_uuid(i)]
    allowed = resolver.mentionable(target_id, ids) if ids else set()
    return [i for i in ids if i in allowed]


def _is_uuid(value: Any) -> bool:
    return parse_id(value) is not None


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


def _emit(comment: Comment, actor: Any, event_type: str, user_ids: list[str], quote: str) -> None:
    info = _resolver(comment).describe(comment.target_id)
    hints = {k: info[k] for k in ("projectId", "taskId") if info.get(k)}
    emit(
        event_type,
        workspace=comment.workspace_id,
        target_type=comment.target_type,
        target_id=comment.target_id,
        actor=actor,
        payload={"userIds": user_ids, "quote": quote, "commentId": str(comment.pk), **hints},
    )


def list_comments(resolver: TargetResolver, target_id: Any) -> Any:
    return (
        Comment.objects.filter(target_type=resolver.key, target_id=target_id)
        .prefetch_related("mentions")
        .order_by("created_at")
    )


@transaction.atomic
def create_comment(actor: Any, target_type: str, target_id: Any, raw: Any) -> Comment:
    resolver = resolver_for(target_type)
    if not resolver.can_comment(actor, target_id):
        raise _deny(resolver, "comment")
    body, text = _comment_body(raw)
    comment = Comment.objects.create(
        workspace_id=resolver.workspace_of(target_id),
        target_type=resolver.key,
        target_id=target_id,
        author=actor,
        body=body,
        body_text=text,
    )
    mentioned = _mentions(resolver, target_id, body)
    _set_mentions(comment, mentioned)
    _refresh_comment_search(comment)
    _audit(comment, actor, "core.comment.created", changes=[change("Comment", None, text[:200], "text")])
    _publish(comment, actor, "core.comment.created")
    quote = text[:140]
    if mentioned:
        _emit(comment, actor, "core.comment.mentioned", mentioned, quote)
    watchers = [str(u) for u in resolver.subscribers(target_id) if u and str(u) not in mentioned]
    if watchers:
        _emit(comment, actor, "core.comment.created", watchers, quote)
    return comment


def get_comment(user: Any, comment_id: Any) -> Comment:
    comment = Comment.objects.filter(pk=comment_id).first() if _is_uuid(comment_id) else None
    if comment is None or _resolver(comment).workspace_of(comment.target_id) is None:
        raise not_found("Comment not found.")
    _resolver(comment).require_view(user, comment.target_id)
    return comment


@transaction.atomic
def update_comment(actor: Any, comment: Comment, raw: Any) -> Comment:
    resolver = _resolver(comment)
    if comment.author_id != actor.pk or not resolver.can_edit_own_comment(actor, comment.target_id):
        raise _deny(resolver, "edit_own_comment", "You can only edit your own comments.")
    before_mentions = set(map(str, CommentMention.objects.filter(comment=comment).values_list("user_id", flat=True)))
    body, text = _comment_body(raw)
    before = comment.body_text
    comment.body = body
    comment.body_text = text
    comment.edited_at = timezone.now()
    comment.save()
    mentioned = _mentions(resolver, comment.target_id, body)
    _set_mentions(comment, mentioned)
    _refresh_comment_search(comment)
    _audit(comment, actor, "core.comment.updated", changes=[change("Comment", before[:200], text[:200], "text")])
    _publish(comment, actor, "core.comment.updated")
    new = [m for m in mentioned if m not in before_mentions]
    if new:
        _emit(comment, actor, "core.comment.mentioned", new, text[:140])
    return comment


def can_delete_comment(user: Any, comment: Comment) -> bool:
    resolver = _resolver(comment)
    own = comment.author_id == user.pk and resolver.can_edit_own_comment(user, comment.target_id)
    return own or resolver.can_delete_any_comment(user, comment.target_id)


@transaction.atomic
def delete_comment(actor: Any, comment: Comment) -> None:
    if not can_delete_comment(actor, comment):
        raise _deny(_resolver(comment), "delete_any_comment", "You can’t delete this comment.")
    comment.deleted_at = timezone.now()
    comment.deleted_by = actor
    comment.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    _audit(comment, actor, "core.comment.deleted", changes=[change("Comment", comment.body_text[:200], None)])
    _publish(comment, actor, "core.comment.deleted")


@transaction.atomic
def restore_comment(actor: Any, comment: Comment) -> Comment:
    comment.deleted_at = None
    comment.deleted_by = None
    comment.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    _audit(comment, actor, "core.comment.restored")
    _publish(comment, actor, "core.comment.restored")
    return comment


@transaction.atomic
def purge_comment(actor: Any, comment: Comment) -> None:
    _audit(comment, actor, "core.comment.purged")
    _publish(comment, actor, "core.comment.purged")
    comment.delete()


# ───────────────────────── attachments ─────────────────────────


def storage_key(resolver: TargetResolver, target_id: Any) -> str:
    return f"{resolver.storage_prefix(target_id)}/{uuid.uuid4().hex}"


def list_attachments(resolver: TargetResolver, target_id: Any) -> Any:
    return Attachment.objects.filter(target_type=resolver.key, target_id=target_id, status="ready").order_by(
        "created_at"
    )


@transaction.atomic
def start_upload(
    actor: Any, target_type: str, target_id: Any, data: dict[str, Any]
) -> tuple[Attachment, str, dict[str, str]]:
    resolver = resolver_for(target_type)
    if not resolver.can_attach(actor, target_id):
        raise _deny(resolver, "attach")
    file_name = clean_file_name(data.get("fileName"))
    size = data.get("size")
    kind, content_type = classify(file_name, str(data.get("mimeType") or ""), size)
    attachment = Attachment.objects.create(
        workspace_id=resolver.workspace_of(target_id),
        target_type=resolver.key,
        target_id=target_id,
        uploader=actor,
        file_name=file_name,
        size=size,
        mime_type=content_type,
        kind=kind,
        storage_key=storage_key(resolver, target_id),
    )
    url, headers = get_storage().presigned_put(attachment.storage_key, content_type, settings.UPLOAD_URL_TTL_SECONDS)
    return attachment, url, headers


def require_attach(actor: Any, attachment: Attachment) -> None:
    resolver = _resolver(attachment)
    if not resolver.can_attach(actor, attachment.target_id):
        raise _deny(resolver, "attach")


def pending_upload(actor: Any, attachment: Attachment) -> Attachment:
    """The caller's own upload that hasn't been confirmed yet (400 `upload_missing` otherwise)."""
    pending = Attachment.objects.filter(pk=attachment.pk, uploader=actor, status="pending").first()
    if pending is None:
        raise ApiError(400, "upload_missing", "Upload not found or incomplete. Try again.")
    return pending


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
    resolver = _resolver(attachment)
    if not resolver.can_attach(actor, attachment.target_id):
        raise _deny(resolver, "attach")
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
        _audit(
            attachment,
            actor,
            "core.attachment.created",
            changes=[change("File", None, attachment.file_name)],
            data={"file": attachment.file_name},
        )
        _publish(attachment, actor, "core.attachment.created")
    return attachment


def get_attachment(user: Any, attachment_id: Any) -> Attachment:
    attachment = Attachment.objects.filter(pk=attachment_id).first() if _is_uuid(attachment_id) else None
    if attachment is None or _resolver(attachment).workspace_of(attachment.target_id) is None:
        raise not_found("File not found.")
    _resolver(attachment).require_view(user, attachment.target_id)
    return attachment


@transaction.atomic
def delete_attachment(actor: Any, attachment: Attachment) -> None:
    resolver = _resolver(attachment)
    own = attachment.uploader_id == actor.pk and resolver.can_attach(actor, attachment.target_id)
    if not own and not resolver.can_delete_any_attachment(actor, attachment.target_id):
        raise _deny(resolver, "delete_any_attachment", "You can’t delete this file.")
    attachment.deleted_at = timezone.now()
    attachment.deleted_by = actor
    attachment.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    _audit(attachment, actor, "core.attachment.deleted", changes=[change("File", attachment.file_name, None)])
    _publish(attachment, actor, "core.attachment.deleted")


def delete_target_records(target_type: str, target_ids: list[Any]) -> None:
    """Hard-deletes the comments and attachments of purged targets; stored objects go after commit."""
    attachments = Attachment.all_objects.filter(target_type=target_type, target_id__in=target_ids)
    delete_files(attachments)
    attachments.delete()
    Comment.all_objects.filter(target_type=target_type, target_id__in=target_ids).delete()


def delete_files(attachments: Any) -> None:
    storage = get_storage()
    keys = list(attachments.values_list("storage_key", flat=True))

    def remove() -> None:
        for key in keys:
            storage.delete(key)

    transaction.on_commit(remove)


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
