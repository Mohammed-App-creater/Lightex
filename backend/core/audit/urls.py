from django.urls import path

from . import views

urlpatterns = [
    path("workspaces/<str:slug>/audit", views.AuditListView.as_view(), name="workspace-audit"),
    path("workspaces/<str:slug>/trash", views.TrashListView.as_view(), name="workspace-trash"),
    path("workspaces/<str:slug>/trash/restore", views.TrashRestoreView.as_view(), name="workspace-trash-restore"),
    path("workspaces/<str:slug>/trash/purge", views.TrashPurgeView.as_view(), name="workspace-trash-purge"),
    path("trash/<str:kind>/<uuid:item_id>/restore", views.TrashItemRestoreView.as_view(), name="trash-item-restore"),
]
