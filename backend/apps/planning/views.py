from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response

from apps.access.permissions import ScopedView
from apps.common.params import body
from apps.projects.views import ProjectScopedView

from . import selectors, services
from .serializers import (
    EpicIn,
    EpicOut,
    MilestoneIn,
    MilestoneOut,
    ObjectiveIn,
    ObjectiveOut,
    TaskIdsIn,
    epic_data,
    milestone_data,
    objective_data,
)


class _ItemView(ScopedView):
    """Scope = the project of the planning item in the URL."""

    lookup: str = ""

    def get_scope(self):
        finder = getattr(selectors, f"{self.lookup}_for")
        self.item = finder(self.request.user, self.kwargs["item_id"])
        return self.item.project


# ───────────────────────── objectives ─────────────────────────


class ObjectivesView(ProjectScopedView):
    required = {"GET": "project.view", "POST": "objective.manage"}

    @extend_schema(tags=["objectives"], responses={200: ObjectiveOut(many=True)})
    def get(self, request, project_id):
        return Response([objective_data(o) for o in selectors.objectives_of(self.scope)])

    @extend_schema(tags=["objectives"], request=ObjectiveIn, responses={201: ObjectiveOut})
    def post(self, request, project_id):
        objective = services.create_objective(request.user, self.scope, body(request))
        return Response(objective_data(selectors.with_progress(objective)), status=status.HTTP_201_CREATED)


class ObjectiveDetailView(_ItemView):
    lookup = "objective"
    required = {"GET": "project.view", "PATCH": "objective.manage", "DELETE": "objective.manage"}

    @extend_schema(tags=["objectives"], responses={200: ObjectiveOut})
    def get(self, request, item_id):
        return Response(objective_data(selectors.with_progress(self.item)))

    @extend_schema(tags=["objectives"], request=ObjectiveIn, responses={200: ObjectiveOut})
    def patch(self, request, item_id):
        objective = services.update_objective(request.user, self.item, body(request))
        return Response(objective_data(selectors.with_progress(objective)))

    @extend_schema(tags=["objectives"], responses={204: None})
    def delete(self, request, item_id):
        services.delete_objective(request.user, self.item)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ObjectiveTasksView(_ItemView):
    lookup = "objective"
    required = {"POST": "objective.manage"}

    @extend_schema(tags=["objectives"], request=TaskIdsIn, responses={200: ObjectiveOut})
    def post(self, request, item_id):
        objective = services.link_tasks(request.user, self.item, body(request).get("taskIds"))
        return Response(objective_data(selectors.with_progress(objective)))


class ObjectiveTaskDetailView(_ItemView):
    lookup = "objective"
    required = {"DELETE": "objective.manage"}

    @extend_schema(tags=["objectives"], responses={200: ObjectiveOut})
    def delete(self, request, item_id, task_id):
        objective = services.unlink_task(request.user, self.item, task_id)
        return Response(objective_data(selectors.with_progress(objective)))


# ───────────────────────── milestones ─────────────────────────


class MilestonesView(ProjectScopedView):
    required = {"GET": "project.view", "POST": "milestone.manage"}

    @extend_schema(tags=["milestones"], responses={200: MilestoneOut(many=True)})
    def get(self, request, project_id):
        return Response([milestone_data(m) for m in selectors.milestones_of(self.scope)])

    @extend_schema(tags=["milestones"], request=MilestoneIn, responses={201: MilestoneOut})
    def post(self, request, project_id):
        milestone = services.create_milestone(request.user, self.scope, body(request))
        return Response(milestone_data(selectors.with_progress(milestone)), status=status.HTTP_201_CREATED)


class MilestoneDetailView(_ItemView):
    lookup = "milestone"
    required = {"GET": "project.view", "PATCH": "milestone.manage", "DELETE": "milestone.manage"}

    @extend_schema(tags=["milestones"], responses={200: MilestoneOut})
    def get(self, request, item_id):
        return Response(milestone_data(selectors.with_progress(self.item)))

    @extend_schema(tags=["milestones"], request=MilestoneIn, responses={200: MilestoneOut})
    def patch(self, request, item_id):
        milestone = services.update_milestone(request.user, self.item, body(request))
        return Response(milestone_data(selectors.with_progress(milestone)))

    @extend_schema(tags=["milestones"], responses={204: None})
    def delete(self, request, item_id):
        services.delete_milestone(request.user, self.item)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ───────────────────────── epics ─────────────────────────


class EpicsView(ProjectScopedView):
    required = {"GET": "project.view", "POST": "epic.manage"}

    @extend_schema(tags=["epics"], responses={200: EpicOut(many=True)})
    def get(self, request, project_id):
        return Response([epic_data(e) for e in selectors.epics_of(self.scope)])

    @extend_schema(tags=["epics"], request=EpicIn, responses={201: EpicOut})
    def post(self, request, project_id):
        epic = services.create_epic(request.user, self.scope, body(request))
        return Response(epic_data(selectors.with_progress(epic)), status=status.HTTP_201_CREATED)


class EpicDetailView(_ItemView):
    lookup = "epic"
    required = {"GET": "project.view", "PATCH": "epic.manage", "DELETE": "epic.manage"}

    @extend_schema(tags=["epics"], responses={200: EpicOut})
    def get(self, request, item_id):
        return Response(epic_data(selectors.with_progress(self.item)))

    @extend_schema(tags=["epics"], request=EpicIn, responses={200: EpicOut})
    def patch(self, request, item_id):
        epic = services.update_epic(request.user, self.item, body(request))
        return Response(epic_data(selectors.with_progress(epic)))

    @extend_schema(tags=["epics"], responses={204: None})
    def delete(self, request, item_id):
        services.delete_epic(request.user, self.item)
        return Response(status=status.HTTP_204_NO_CONTENT)
