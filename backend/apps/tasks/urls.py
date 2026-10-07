from django.urls import path

from . import board_views, views

T = "tasks/<uuid:task_id>"

urlpatterns = [
    path("projects/<uuid:project_id>/tasks", views.ProjectTasksView.as_view(), name="project-tasks"),
    path("projects/<uuid:project_id>/tasks/bulk", views.BulkView.as_view(), name="project-tasks-bulk"),
    path("projects/<uuid:project_id>/activity", views.ProjectActivityView.as_view(), name="project-activity"),
    path("workspaces/<str:slug>/tasks", views.WorkspaceTasksView.as_view(), name="workspace-tasks"),
    path("workspaces/<str:slug>/tasks/<str:key>", views.WorkspaceTaskByKeyView.as_view(), name="workspace-task-by-key"),
    path("workspaces/<str:slug>/activity", views.WorkspaceActivityView.as_view(), name="workspace-activity"),
    path("projects/<uuid:project_id>/board", board_views.BoardView.as_view(), name="project-board"),
    path("projects/<uuid:project_id>/backlog", board_views.BacklogView.as_view(), name="project-backlog"),
    path(f"{T}/move", board_views.MoveView.as_view(), name="task-move"),
    path(f"{T}/restore", views.TaskRestoreView.as_view(), name="task-restore"),
    path(f"{T}/subtasks", views.SubtasksView.as_view(), name="task-subtasks"),
    path(f"{T}/objectives", views.TaskObjectivesView.as_view(), name="task-objectives"),
    path(f"{T}/labels", views.TaskLabelsView.as_view(), name="task-labels"),
    path(f"{T}/activity", views.TaskActivityView.as_view(), name="task-activity"),
    path("tasks/<str:task_ref>", views.TaskDetailView.as_view(), name="task-detail"),
    path("me/tasks", views.MyTasksView.as_view(), name="my-tasks"),
    path("me/recents", views.RecentsView.as_view(), name="my-recents"),
]
