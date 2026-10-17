from django.db import models

from core.common.models import WorkspaceScopedModel


class JobMark(WorkspaceScopedModel):
    """An idempotency mark (sales S0): a job claims a key once per workspace (`core.jobs.services.claim`), so running
    it twice does the work once. The rows double as a record of what ran."""

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    job = models.CharField(max_length=64)
    key = models.CharField(max_length=200)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["workspace", "job", "key"], name="job_mark_unique")]
