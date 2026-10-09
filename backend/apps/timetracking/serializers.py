from rest_framework import serializers

from apps.common.utils import iso

from .models import RunningTimer, TimeEntry


def entry_data(e: TimeEntry) -> dict:
    """The client's `TimeEntry` shape."""
    return {
        "id": str(e.pk),
        "taskId": str(e.task_id),
        "projectId": str(e.project_id),
        "userId": str(e.user_id),
        "minutes": e.minutes,
        "date": e.date.isoformat(),
        "note": e.note,
        "source": e.source,
        "createdAt": iso(e.created_at),
    }


def timer_data(t: RunningTimer | None) -> dict | None:
    """The client's `RunningTimer` shape (expects `task` loaded)."""
    if t is None:
        return None
    return {
        "taskId": str(t.task_id),
        "taskKey": t.task.key,
        "taskTitle": t.task.title,
        "projectId": str(t.task.project_id),
        "startedAt": iso(t.started_at),
    }


class TimeEntryOut(serializers.Serializer):
    id = serializers.UUIDField()
    taskId = serializers.UUIDField()
    projectId = serializers.UUIDField()
    userId = serializers.UUIDField()
    minutes = serializers.IntegerField(min_value=1, max_value=1440)
    date = serializers.DateField()
    note = serializers.CharField(allow_blank=True)
    source = serializers.ChoiceField(choices=["manual", "timer"])  # type: ignore[assignment]
    createdAt = serializers.DateTimeField()


class TimeEntryIn(serializers.Serializer):
    minutes = serializers.IntegerField(min_value=1, max_value=1440)
    date = serializers.DateField()
    note = serializers.CharField(required=False, allow_blank=True, max_length=140)


class RunningTimerOut(serializers.Serializer):
    taskId = serializers.UUIDField()
    taskKey = serializers.CharField()
    taskTitle = serializers.CharField()
    projectId = serializers.UUIDField()
    startedAt = serializers.DateTimeField()


class TimerStateOut(serializers.Serializer):
    timer = RunningTimerOut(allow_null=True)


class TimerStartIn(serializers.Serializer):
    date = serializers.DateField(required=False, help_text="Local work date, used if another timer is stopped")


class TimerStartOut(serializers.Serializer):
    timer = RunningTimerOut()
    stopped = TimeEntryOut(allow_null=True)


class TimerStopIn(serializers.Serializer):
    date = serializers.DateField(required=False)
    note = serializers.CharField(required=False, allow_blank=True)


class TimerStopOut(serializers.Serializer):
    entry = TimeEntryOut()


class TimesheetSliceOut(serializers.Serializer):
    projectId = serializers.UUIDField()
    taskId = serializers.UUIDField(allow_null=True)
    key = serializers.CharField()
    name = serializers.CharField()
    hue = serializers.IntegerField()
    minutes = serializers.IntegerField()


class TimesheetCellOut(serializers.Serializer):
    date = serializers.DateField()
    minutes = serializers.IntegerField()
    breakdown = TimesheetSliceOut(many=True)


class TimesheetUserOut(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()
    hue = serializers.IntegerField()
    avatarUrl = serializers.CharField(allow_null=True)


class TimesheetRowOut(serializers.Serializer):
    user = TimesheetUserOut()
    cells = TimesheetCellOut(many=True)
    totalMinutes = serializers.IntegerField()


class TimesheetProjectOut(serializers.Serializer):
    id = serializers.UUIDField()
    key = serializers.CharField()
    name = serializers.CharField()
    hue = serializers.IntegerField()
    my_permissions = serializers.ListField(child=serializers.CharField())


class TimesheetOut(serializers.Serializer):
    weekStart = serializers.DateField()
    days = serializers.ListField(child=serializers.DateField())
    projects = TimesheetProjectOut(many=True)
    rows = TimesheetRowOut(many=True)
    dayTotals = serializers.ListField(child=serializers.IntegerField())
    totalMinutes = serializers.IntegerField()
