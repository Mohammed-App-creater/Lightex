from django.urls import path

from . import views

# Task-scoped routes live in task_urls.py (mounted under tracking/).
urlpatterns = [
    path("comments/<uuid:comment_id>", views.CommentDetailView.as_view(), name="comment-detail"),
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
