"""Teams (platform Stage 4): flat groups of workspace members. A user may be in several teams. Data scope `team`
(core.access.visible_to) reaches the records owned by anyone who shares a team with the user."""

from django.conf import settings
from django.db import models
from django.db.models.functions import Lower

from core.common.models import BaseModel, SoftDeleteModel

NAME_MAX = 60
DESCRIPTION_MAX = 280


class Team(SoftDeleteModel):
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="teams")
    name = models.CharField(max_length=NAME_MAX)
    description = models.CharField(max_length=DESCRIPTION_MAX, blank=True, default="")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                "workspace",
                Lower("name"),
                condition=models.Q(deleted_at__isnull=True),
                name="team_name_unique_per_workspace",
            )
        ]

    def __str__(self) -> str:
        return self.name


class TeamMember(BaseModel):
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="team_memberships")
    is_lead = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["team", "user"], name="team_member_unique")]
        indexes = [models.Index(fields=["workspace", "user"], name="team_member_ws_user")]
