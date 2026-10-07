from django.conf import settings
from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models

from apps.common.models import BaseModel, SoftDeleteModel


class Comment(SoftDeleteModel):
    task = models.ForeignKey("tasks.Task", on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="comments")
    body = models.JSONField()  # sanitised Tiptap JSON
    body_text = models.TextField(blank=True, default="")
    mentions = models.ManyToManyField(settings.AUTH_USER_MODEL, through="CommentMention", related_name="+", blank=True)
    edited_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    search_vector = SearchVectorField(null=True, editable=False)

    class Meta(SoftDeleteModel.Meta):
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["task", "created_at"], name="comment_task_created"),
            GinIndex(fields=["search_vector"], name="comment_search_gin"),
        ]


class CommentMention(BaseModel):
    comment = models.ForeignKey(Comment, on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["comment", "user"], name="comment_mention_unique")]


class Attachment(SoftDeleteModel):
    STATUS_CHOICES = [("pending", "Pending upload"), ("ready", "Ready")]
    KIND_CHOICES = [("image", "Image"), ("code", "Code"), ("text", "Text")]

    task = models.ForeignKey("tasks.Task", on_delete=models.CASCADE, related_name="attachments")
    uploader = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    file_name = models.CharField(max_length=120)
    size = models.PositiveIntegerField()
    mime_type = models.CharField(max_length=100)
    kind = models.CharField(max_length=8, choices=KIND_CHOICES)
    # Generated server-side (ws/<id>/p/<id>/t/<id>/<uuid>); never derived from the file name.
    storage_key = models.CharField(max_length=300, unique=True)
    status = models.CharField(max_length=8, choices=STATUS_CHOICES, default="pending")
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta(SoftDeleteModel.Meta):
        ordering = ["created_at"]
        indexes = [models.Index(fields=["task", "status"], name="attachment_task_status")]
