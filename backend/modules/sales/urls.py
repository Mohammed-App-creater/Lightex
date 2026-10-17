from django.urls import path

from . import views

urlpatterns = [
    path("workspaces/<str:slug>/health", views.SalesHealthView.as_view(), name="sales-health"),
]
