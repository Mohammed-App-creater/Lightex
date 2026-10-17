from django.urls import path

from . import views

T = "targets/<str:target_type>/<uuid:target_id>"

urlpatterns = [
    path(f"{T}/comments", views.TargetCommentsView.as_view(), name="target-comments"),
    path(f"{T}/attachments", views.TargetAttachmentsView.as_view(), name="target-attachments"),
    path(f"{T}/attachments/upload-url", views.UploadUrlView.as_view(), name="target-attachment-upload-url"),
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
