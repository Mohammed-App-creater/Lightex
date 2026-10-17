"""Task-scoped comment and attachment routes, mounted under /api/v1/tracking/ (docs/platform/stage1-contract.md §2)."""

from django.urls import path

from . import views

T = "tasks/<uuid:task_id>"

urlpatterns = [
    path(f"{T}/comments", views.TaskCommentsView.as_view(), name="task-comments"),
    path(f"{T}/attachments", views.TaskAttachmentsView.as_view(), name="task-attachments"),
    path(f"{T}/attachments/upload-url", views.UploadUrlView.as_view(), name="task-attachment-upload-url"),
]
