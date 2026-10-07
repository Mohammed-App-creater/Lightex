from django.urls import path

from . import views

P = "projects/<uuid:project_id>"

urlpatterns = [
    path(f"{P}/objectives", views.ObjectivesView.as_view(), name="project-objectives"),
    path("objectives/<uuid:item_id>", views.ObjectiveDetailView.as_view(), name="objective-detail"),
    path("objectives/<uuid:item_id>/tasks", views.ObjectiveTasksView.as_view(), name="objective-tasks"),
    path(
        "objectives/<uuid:item_id>/tasks/<uuid:task_id>",
        views.ObjectiveTaskDetailView.as_view(),
        name="objective-task-detail",
    ),
    path(f"{P}/milestones", views.MilestonesView.as_view(), name="project-milestones"),
    path("milestones/<uuid:item_id>", views.MilestoneDetailView.as_view(), name="milestone-detail"),
    path(f"{P}/epics", views.EpicsView.as_view(), name="project-epics"),
    path("epics/<uuid:item_id>", views.EpicDetailView.as_view(), name="epic-detail"),
]
