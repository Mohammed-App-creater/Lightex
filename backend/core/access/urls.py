from django.urls import path

from . import views

urlpatterns = [
    path("permissions", views.PermissionCatalogueView.as_view(), name="permission-catalogue"),
    path("workspaces/<str:slug>/roles", views.RoleListView.as_view(), name="workspace-roles"),
    path("roles/<uuid:role_id>", views.RoleDetailView.as_view(), name="role-detail"),
    path("roles/<uuid:role_id>/permissions", views.RolePermissionsView.as_view(), name="role-permissions"),
]
