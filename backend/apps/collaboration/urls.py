from django.urls import path

from . import views

T = "tasks/<uuid:task_id>"

urlpatterns = [
    path(f"{T}/comments", views.TaskCommentsView.as_view(), name="task-comments"),
    path("comments/<uuid:comment_id>", views.CommentDetailView.as_view(), name="comment-detail"),
    path(f"{T}/attachments", views.TaskAttachmentsView.as_view(), name="task-attachments"),
    path(f"{T}/attachments/upload-url", views.UploadUrlView.as_view(), name="task-attachment-upload-url"),
    path("attachments/<uuid:attachment_id>", views.AttachmentDetailView.as_view(), name="attachment-detail"),
    path("attachments/<uuid:attachment_id>/confirm", views.AttachmentConfirmView.as_view(), name="attachment-confirm"),
    path(
        "attachments/<uuid:attachment_id>/download-url",
        views.AttachmentDownloadView.as_view(),
        name="attachment-download-url",
    ),
    # Development storage (STORAGE_BACKEND=local); 404 otherwise.
    path("storage/upload/<str:token>", views.local_upload, name="storage-local-upload"),
    path("storage/download/<str:token>", views.local_download, name="storage-local-download"),
]
