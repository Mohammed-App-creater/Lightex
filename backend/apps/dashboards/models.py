"""Board 33: project dashboards (shared or personal) and their widgets.

A layout is an ordered list of widgets with a width and a height; positions on the 12-column grid are computed by
the client's first-fit packing (docs/v2/33-dashboards-presence.md §1.4), never stored.
"""

from django.conf import settings
from django.db import models
from django.db.models import Deferrable
from django.db.models.functions import Lower

from apps.common.models import BaseModel

VISIBILITY = [("shared", "Shared"), ("personal", "Personal")]
WIDGET_TYPES = [
    ("burndown", "Burndown"),
    ("my_tasks", "My tasks"),
    ("objectives", "Objective progress"),
    ("workload", "Workload by person"),
    ("velocity", "Velocity"),
    ("activity", "Recent activity"),
]


class Dashboard(BaseModel):
    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="dashboards")
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="dashboards")
    name = models.CharField(max_length=60)
    visibility = models.CharField(max_length=8, choices=VISIBILITY)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        indexes = [
            models.Index(fields=["project", "visibility"], name="dashboard_project_vis"),
            models.Index(fields=["project", "owner"], name="dashboard_project_owner"),
        ]
        constraints = [
            models.UniqueConstraint("project", "owner", Lower("name"), name="dashboard_name_unique_per_owner"),
        ]


class DashboardWidget(BaseModel):
    dashboard = models.ForeignKey(Dashboard, on_delete=models.CASCADE, related_name="widgets")
    type = models.CharField(max_length=16, choices=WIDGET_TYPES)
    position = models.PositiveSmallIntegerField()
    w = models.PositiveSmallIntegerField()
    h = models.PositiveSmallIntegerField()
    config = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["position"]
        constraints = [
            models.UniqueConstraint(fields=["dashboard", "type"], name="dashboard_widget_type_unique"),
            models.UniqueConstraint(
                fields=["dashboard", "position"],
                name="dashboard_widget_position_unique",
                deferrable=Deferrable.DEFERRED,
            ),
            models.CheckConstraint(condition=models.Q(w__gte=3, w__lte=12), name="dashboard_widget_w_range"),
            models.CheckConstraint(condition=models.Q(h__gte=1, h__lte=4), name="dashboard_widget_h_range"),
        ]
