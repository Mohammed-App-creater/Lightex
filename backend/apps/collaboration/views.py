from django.conf import settings
from django.core import signing
from django.http import FileResponse, HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.response import Response

from apps.access.permissions import MEMBER, ScopedView
from apps.common.params import body
from apps.common.throttles import UploadThrottle
from apps.common.utils import iso
from apps.tasks.views import TaskScopedView

from . import services
from .models import Attachment, Comment
from .storage import LocalStorage, expires_at, get_storage


def comment_data(c: Comment) -> dict:
    return {
        "id": str(c.pk),
        "taskId": str(c.task_id),
        "authorId": str(c.author_id) if c.author_id else None,
        "body": c.body,
        "mentions": [str(u) for u in c.mentions.values_list("id", flat=True)],
        "createdAt": iso(c.created_at),
        "editedAt": iso(c.edited_at),
    }


def attachment_data(a: Attachment) -> dict:
    return {
        "id": str(a.pk),
        "taskId": str(a.task_id),
        "uploaderId": str(a.uploader_id) if a.uploader_id else None,
        "fileName": a.file_name,
        "size": a.size,
        "mimeType": a.mime_type,
        "kind": a.kind,
        **services.download_urls(a),
        "createdAt": iso(a.created_at),
    }


CommentOut = inline_serializer(
    "Comment",
    {
        "id": serializers.UUIDField(),
        "taskId": serializers.UUIDField(),
        "authorId": serializers.UUIDField(allow_null=True),
        "body": serializers.JSONField(),
        "mentions": serializers.ListField(child=serializers.UUIDField()),
        "createdAt": serializers.DateTimeField(),
        "editedAt": serializers.DateTimeField(allow_null=True),
    },
)
CommentIn = inline_serializer("CommentIn", {"body": serializers.JSONField()})
AttachmentOut = inline_serializer(
    "Attachment",
    {
        "id": serializers.UUIDField(),
        "taskId": serializers.UUIDField(),
        "uploaderId": serializers.UUIDField(allow_null=True),
        "fileName": serializers.CharField(),
        "size": serializers.IntegerField(),
        "mimeType": serializers.CharField(),
        "kind": serializers.ChoiceField(choices=["image", "code", "text"]),
        "downloadUrl": serializers.URLField(),
        "previewUrl": serializers.URLField(allow_null=True),
        "createdAt": serializers.DateTimeField(),
    },
)
UploadTicketOut = inline_serializer(
    "UploadTicket",
    {
        "uploadId": serializers.UUIDField(),
        "url": serializers.URLField(),
        "method": serializers.CharField(),
        "headers": serializers.DictField(child=serializers.CharField()),
        "expiresAt": serializers.DateTimeField(),
    },
)


class TaskCommentsView(TaskScopedView):
    required = {"GET": "project.view", "POST": "comment.create"}

    @extend_schema(tags=["comments"], responses={200: CommentOut})
    def get(self, request, task_id):
        comments = Comment.objects.filter(task=self.task).prefetch_related("mentions").order_by("created_at")
        return Response([comment_data(c) for c in comments])

    @extend_schema(tags=["comments"], request=CommentIn, responses={201: CommentOut})
    def post(self, request, task_id):
        comment = services.create_comment(request.user, self.task, body(request).get("body"))
        return Response(comment_data(comment), status=status.HTTP_201_CREATED)


class CommentDetailView(ScopedView):
    required = {"PATCH": MEMBER, "DELETE": MEMBER}

    def get_scope(self):
        self.comment = services.get_comment(self.request.user, self.kwargs["comment_id"])
        return self.comment.task.project

    @extend_schema(tags=["comments"], request=CommentIn, responses={200: CommentOut})
    def patch(self, request, comment_id):
        return Response(comment_data(services.update_comment(request.user, self.comment, body(request).get("body"))))

    @extend_schema(tags=["comments"], responses={204: None})
    def delete(self, request, comment_id):
        services.delete_comment(request.user, self.comment)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TaskAttachmentsView(TaskScopedView):
    """GET the task's files; POST {uploadId} confirms an upload (client contract)."""

    required = {"GET": "project.view", "POST": "attachment.upload"}

    @extend_schema(tags=["attachments"], responses={200: AttachmentOut})
    def get(self, request, task_id):
        files = Attachment.objects.filter(task=self.task, status="ready").order_by("created_at")
        return Response([attachment_data(a) for a in files])

    @extend_schema(
        tags=["attachments"],
        request=inline_serializer("ConfirmUpload", {"uploadId": serializers.UUIDField()}),
        responses={201: AttachmentOut},
    )
    def post(self, request, task_id):
        attachment = services.pending_upload(request.user, self.task, body(request).get("uploadId"))
        attachment = services.confirm_upload(request.user, attachment)
        return Response(attachment_data(attachment), status=status.HTTP_201_CREATED)


class UploadUrlView(TaskScopedView):
    required = {"POST": "attachment.upload"}
    throttle_classes = [UploadThrottle]

    @extend_schema(
        tags=["attachments"],
        request=inline_serializer(
            "UploadUrlIn",
            {
                "fileName": serializers.CharField(),
                "size": serializers.IntegerField(),
                "mimeType": serializers.CharField(),
            },
        ),
        responses={200: UploadTicketOut},
    )
    def post(self, request, task_id):
        attachment, url, headers = services.start_upload(request.user, self.task, body(request))
        return Response(
            {
                "uploadId": str(attachment.pk),
                "url": url,
                "method": "PUT",
                "headers": headers,
                "expiresAt": iso(expires_at(settings.UPLOAD_URL_TTL_SECONDS)),
            }
        )


class AttachmentScopedView(ScopedView):
    def get_scope(self):
        self.attachment = services.get_attachment(self.request.user, self.kwargs["attachment_id"])
        return self.attachment.task.project


class AttachmentConfirmView(AttachmentScopedView):
    """POST attachments/{id}/confirm (brief's form of the confirm step)."""

    required = {"POST": "attachment.upload"}

    @extend_schema(tags=["attachments"], request=None, responses={200: AttachmentOut})
    def post(self, request, attachment_id):
        attachment = services.pending_upload(request.user, self.attachment.task, self.attachment.pk)
        return Response(attachment_data(services.confirm_upload(request.user, attachment)))


class AttachmentDetailView(AttachmentScopedView):
    required = {"DELETE": MEMBER}

    @extend_schema(tags=["attachments"], responses={204: None})
    def delete(self, request, attachment_id):
        services.delete_attachment(request.user, self.attachment)
        return Response(status=status.HTTP_204_NO_CONTENT)


class AttachmentDownloadView(AttachmentScopedView):
    required = {"GET": "project.view"}

    @extend_schema(
        tags=["attachments"],
        responses=inline_serializer(
            "DownloadUrl",
            {
                "url": serializers.URLField(),
                "previewUrl": serializers.URLField(allow_null=True),
                "expiresAt": serializers.DateTimeField(),
            },
        ),
    )
    def get(self, request, attachment_id):
        if self.attachment.status != "ready":
            from apps.common.exceptions import not_found

            raise not_found("File not found.")
        urls = services.download_urls(self.attachment)
        return Response(
            {
                "url": urls["downloadUrl"],
                "previewUrl": urls["previewUrl"],
                "expiresAt": iso(expires_at(settings.DOWNLOAD_URL_TTL_SECONDS)),
            }
        )


# ───────────────────────── local storage (development only) ─────────────────────────


def _local() -> LocalStorage | None:
    storage = get_storage()
    return storage if isinstance(storage, LocalStorage) else None


def _error(status_code: int, code: str, message: str) -> JsonResponse:
    return JsonResponse({"code": code, "message": message, "details": {}}, status=status_code)


@csrf_exempt
@require_http_methods(["PUT", "OPTIONS"])
def local_upload(request, token: str):
    storage = _local()
    if storage is None:
        return _error(404, "not_found", "Not found.")
    if request.method == "OPTIONS":
        return HttpResponse(status=204)
    try:
        payload = LocalStorage.verify("upload", token, settings.UPLOAD_URL_TTL_SECONDS)
    except signing.BadSignature:
        return _error(403, "forbidden", "This upload link has expired.")
    if request.content_type.split(";")[0].strip().lower() != payload["t"]:
        return _error(400, "bad_request", "Content-Type doesn’t match the upload ticket.")
    data = request.body
    if len(data) > settings.MAX_UPLOAD_BYTES:
        return _error(413, "too_large", "Files up to 10 MB.")
    storage.write(payload["k"], data, payload["t"])
    return HttpResponse(status=200)


@require_http_methods(["GET"])
def local_download(request, token: str):
    storage = _local()
    if storage is None:
        return _error(404, "not_found", "Not found.")
    try:
        payload = LocalStorage.verify("download", token, settings.DOWNLOAD_URL_TTL_SECONDS)
    except signing.BadSignature:
        return _error(403, "forbidden", "This download link has expired.")
    path = storage.path(payload["k"])
    if not path.exists():
        return _error(404, "not_found", "Not found.")
    from .storage import content_disposition

    response = FileResponse(path.open("rb"), content_type=payload["t"])
    response["Content-Disposition"] = content_disposition(payload["n"], bool(payload["i"]))
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = "default-src 'none'; sandbox"
    response["Cache-Control"] = "private, max-age=60"
    return response
