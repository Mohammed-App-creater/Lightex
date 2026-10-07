from django.urls import path

from apps.tasks.board_views import SprintBoardView

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
    path(f"{P}/sprints", views.SprintsView.as_view(), name="project-sprints"),
    path(f"{P}/active-sprint", views.ActiveSprintView.as_view(), name="project-active-sprint"),
    path("sprints/<uuid:item_id>", views.SprintDetailView.as_view(), name="sprint-detail"),
    path("sprints/<uuid:item_id>/start", views.SprintStartView.as_view(), name="sprint-start"),
    path("sprints/<uuid:item_id>/complete", views.SprintCompleteView.as_view(), name="sprint-complete"),
    path("sprints/<uuid:sprint_id>/board", SprintBoardView.as_view(), name="sprint-board"),
]
