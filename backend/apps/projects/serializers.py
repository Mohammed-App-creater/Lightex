from rest_framework import serializers

from apps.access import services as access
from apps.access.catalogue import ordered
from apps.accounts.serializers import UserSerializer
from apps.common.utils import iso

from .models import Label, Project, ProjectMember, Status


class ProjectSerializer(serializers.ModelSerializer):
    workspaceId = serializers.UUIDField(source="workspace_id")
    leadId = serializers.UUIDField(source="lead_id", allow_null=True)
    createdAt = serializers.SerializerMethodField()
    memberCount = serializers.SerializerMethodField()
    openTaskCount = serializers.SerializerMethodField()
    doneTaskCount = serializers.SerializerMethodField()
    activeSprintId = serializers.SerializerMethodField()
    myRoleId = serializers.SerializerMethodField()
    my_permissions = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = [
            "id", "workspaceId", "key", "name", "description", "hue", "leadId", "status", "template", "createdAt",
            "memberCount", "openTaskCount", "doneTaskCount", "activeSprintId", "myRoleId", "my_permissions",
        ]  # fmt: skip

    def get_createdAt(self, obj) -> str | None:
        return iso(obj.created_at)

    def get_memberCount(self, obj) -> int:
        return getattr(obj, "member_count", None) or obj.members.count()

    def get_openTaskCount(self, obj) -> int:
        value = getattr(obj, "open_task_count", None)
        return value if value is not None else obj.tasks.exclude(status__category="done").count()

    def get_doneTaskCount(self, obj) -> int:
        value = getattr(obj, "done_task_count", None)
        return value if value is not None else obj.tasks.filter(status__category="done").count()

    def get_activeSprintId(self, obj) -> str | None:
        if hasattr(obj, "active_sprint_id"):
            return str(obj.active_sprint_id) if obj.active_sprint_id else None
        sid = obj.sprints.filter(state="active").values_list("id", flat=True).first()
        return str(sid) if sid else None

    def get_myRoleId(self, obj) -> str | None:
        roles = self.context.get("my_roles")
        if roles is not None:
            rid = roles.get(obj.pk)
        else:
            rid = obj.members.filter(user_id=self.context["user"].pk).values_list("role_id", flat=True).first()
        return str(rid) if rid else None

    def get_my_permissions(self, obj) -> list[str]:
        return ordered(access.project_permissions(self.context["user"], obj))


def project_context(user, projects) -> dict:
    projects = list(projects)
    access.prefetch_project_permissions(user, projects)
    roles = dict(
        ProjectMember.objects.filter(user_id=user.pk, project__in=projects).values_list("project_id", "role_id")
    )
    return {"user": user, "my_roles": roles}


class ProjectBriefSerializer(serializers.Serializer):
    """Pick<Project, "id" | "key" | "name" | "hue">"""

    id = serializers.UUIDField()
    key = serializers.CharField()
    name = serializers.CharField()
    hue = serializers.IntegerField()


class StatusSerializer(serializers.ModelSerializer):
    projectId = serializers.UUIDField(source="project_id")
    taskCount = serializers.SerializerMethodField()

    class Meta:
        model = Status
        fields = ["id", "projectId", "name", "category", "glyph", "position", "color", "taskCount"]

    def get_taskCount(self, obj) -> int:
        value = getattr(obj, "task_count", None)
        return value if value is not None else obj.tasks.count()


class LabelSerializer(serializers.ModelSerializer):
    projectId = serializers.UUIDField(source="project_id")
    taskCount = serializers.SerializerMethodField()

    class Meta:
        model = Label
        fields = ["id", "projectId", "name", "color", "taskCount"]

    def get_taskCount(self, obj) -> int:
        value = getattr(obj, "task_count", None)
        return value if value is not None else obj.tasks.count()


class ProjectMemberSerializer(serializers.ModelSerializer):
    projectId = serializers.UUIDField(source="project_id")
    userId = serializers.UUIDField(source="user_id")
    roleId = serializers.UUIDField(source="role_id")
    user = UserSerializer()
    addedAt = serializers.SerializerMethodField()

    class Meta:
        model = ProjectMember
        fields = ["projectId", "userId", "roleId", "user", "addedAt"]

    def get_addedAt(self, obj) -> str | None:
        return iso(obj.added_at)


class AccessRequestSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    projectId = serializers.UUIDField(source="project_id")
    userId = serializers.UUIDField(source="user_id")
    message = serializers.CharField()
    createdAt = serializers.SerializerMethodField()
    status = serializers.CharField()

    def get_createdAt(self, obj) -> str | None:
        return iso(obj.created_at)


class AccessRequestWithUserSerializer(AccessRequestSerializer):
    user = UserSerializer()


class ProjectIn(serializers.Serializer):
    name = serializers.CharField(required=False)
    key = serializers.CharField(required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    template = serializers.ChoiceField(choices=["simple", "scrum", "kanban", "bugs"], required=False)
    hue = serializers.IntegerField(required=False)


class MemberIn(serializers.Serializer):
    userId = serializers.UUIDField()
    roleId = serializers.UUIDField()


class StatusIn(serializers.Serializer):
    name = serializers.CharField(required=False)
    category = serializers.ChoiceField(choices=["todo", "in_progress", "done"], required=False)
    position = serializers.IntegerField(required=False)
    color = serializers.CharField(required=False, allow_null=True)


class LabelIn(serializers.Serializer):
    name = serializers.CharField(required=False)
    color = serializers.CharField(required=False)


class IdsIn(serializers.Serializer):
    ids = serializers.ListField(child=serializers.UUIDField())
