"""OpenAPI shapes for board 40 (the payloads themselves are built in selectors.py)."""

from drf_spectacular.utils import inline_serializer
from rest_framework import serializers

STATUSES = ["draft", "ready", "queued", "running", "completed", "failed", "canceled"]


def _error_out():
    return inline_serializer(
        "ImportFailure", {"code": serializers.CharField(), "message": serializers.CharField()}, allow_null=True
    )


ImportFileOut = inline_serializer(
    "ImportFileInfo",
    {
        "name": serializers.CharField(),
        "size": serializers.IntegerField(),
        "encoding": serializers.ChoiceField(choices=["", "utf-8", "utf-16", "windows-1252"]),
        "delimiter": serializers.ChoiceField(choices=["", ",", ";", "\t", "|"]),
        "rowCount": serializers.IntegerField(),
        "columnCount": serializers.IntegerField(),
    },
)

ImportJobOut = inline_serializer(
    "ImportJob",
    {
        "id": serializers.UUIDField(),
        "projectId": serializers.UUIDField(),
        "source": serializers.ChoiceField(choices=["csv", "jira"]),
        "preset": serializers.ChoiceField(choices=["generic", "jira", "linear", "asana"]),
        "status": serializers.ChoiceField(choices=STATUSES),
        "cancelRequested": serializers.BooleanField(),
        "file": ImportFileOut,
        "analysis": serializers.JSONField(allow_null=True, help_text="{ columns: ImportColumn[] } (§4.3)"),
        "mapping": serializers.JSONField(allow_null=True, help_text="ImportMapping (§4.5), normalised"),
        "validation": serializers.JSONField(allow_null=True, help_text="ImportValidation (§4.6)"),
        "progress": serializers.JSONField(allow_null=True, help_text="ImportProgress, from queued on (§4.4)"),
        "result": serializers.JSONField(allow_null=True, help_text="ImportResult, terminal states after a start"),
        "error": _error_out(),
        "createdById": serializers.UUIDField(allow_null=True),
        "createdAt": serializers.DateTimeField(),
        "startedAt": serializers.DateTimeField(allow_null=True),
        "finishedAt": serializers.DateTimeField(allow_null=True),
        "expiresAt": serializers.DateTimeField(allow_null=True),
    },
)

ImportJobSummariesOut = inline_serializer(
    "ImportJobSummary",
    many=True,
    fields={
        "id": serializers.UUIDField(),
        "projectId": serializers.UUIDField(),
        "source": serializers.ChoiceField(choices=["csv", "jira"]),
        "status": serializers.ChoiceField(choices=STATUSES),
        "fileName": serializers.CharField(),
        "imported": serializers.IntegerField(),
        "skipped": serializers.IntegerField(),
        "firstKey": serializers.CharField(allow_null=True),
        "lastKey": serializers.CharField(allow_null=True),
        "hasErrorReport": serializers.BooleanField(),
        "createdById": serializers.UUIDField(allow_null=True),
        "createdAt": serializers.DateTimeField(),
        "startedAt": serializers.DateTimeField(allow_null=True),
        "finishedAt": serializers.DateTimeField(allow_null=True),
        "expiresAt": serializers.DateTimeField(allow_null=True),
        "error": _error_out(),
    },
)

ImportCreateIn = inline_serializer(
    "ImportCreateIn",
    {
        "source": serializers.ChoiceField(choices=["csv", "jira"]),
        "fileName": serializers.CharField(),
        "size": serializers.IntegerField(),
    },
)

ImportUploadTicketOut = inline_serializer(
    "ImportUploadTicket",
    {
        "uploadId": serializers.UUIDField(),
        "url": serializers.URLField(),
        "method": serializers.CharField(),
        "headers": serializers.DictField(child=serializers.CharField()),
        "expiresAt": serializers.DateTimeField(),
    },
)

ImportCreateOut = inline_serializer("ImportCreated", {"job": ImportJobOut, "upload": ImportUploadTicketOut})

ImportColumnMappingsIn = inline_serializer(
    "ImportColumnMapping",
    many=True,
    fields={
        "field": serializers.ChoiceField(
            choices=[
                "title",
                "description",
                "status",
                "assignee",
                "priority",
                "estimate",
                "dueDate",
                "labels",
                "type",
                "timeEstimate",
                "startDate",
                "epic",
                "sprint",
                "parent",
                "sourceId",
                "blockedBy",
                "blocks",
                "customField",
                "skip",
            ]  # fmt: skip
        ),
        "customFieldId": serializers.UUIDField(required=False),
        "unit": serializers.ChoiceField(choices=["minutes", "hours", "seconds"], required=False),
    },
)

ImportMappingIn = inline_serializer(
    "ImportMappingIn",
    {
        "revision": serializers.IntegerField(),
        "columns": ImportColumnMappingsIn,
        "statuses": serializers.DictField(child=serializers.UUIDField(allow_null=True)),
        "types": serializers.DictField(child=serializers.CharField(allow_null=True)),
        "people": serializers.DictField(child=serializers.UUIDField(allow_null=True)),
    },
)

ImportRowPreviewsOut = inline_serializer(
    "ImportRowPreview",
    many=True,
    fields={
        "row": serializers.IntegerField(),
        "outcome": serializers.ChoiceField(choices=["task", "epic", "skipped"]),
        "key": serializers.CharField(allow_null=True),
        "issues": serializers.JSONField(help_text="ImportIssue[]"),
        "values": serializers.JSONField(help_text="Converted values (§4.8)"),
    },
)

ImportRowsPageOut = inline_serializer(
    "ImportRowsPage",
    {"data": ImportRowPreviewsOut, "nextCursor": serializers.CharField(allow_null=True)},
)

ImportReportOut = inline_serializer(
    "ImportErrorReport",
    {"url": serializers.URLField(), "fileName": serializers.CharField(), "expiresAt": serializers.DateTimeField()},
)
