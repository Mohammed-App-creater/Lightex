"""Board 39: database constraints behind the service rules."""

import pytest
from django.db import IntegrityError, transaction

from apps.common.testing import make_project
from apps.projects.models import CustomField, CustomFieldOption
from apps.tasks.models import Task, TaskDependency, TaskFieldValue
from apps.tasks.services import create_task
from apps.timetracking.models import RunningTimer, TimeEntry

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ")


@pytest.fixture
def task(owner, project):
    return create_task(owner, project, {"title": "T"})


def refused(fn):
    with pytest.raises(IntegrityError), transaction.atomic():
        fn()


def test_field_and_option_names_are_unique_case_insensitively(project):
    field = CustomField.objects.create(project=project, name="Browser", type="select")
    refused(lambda: CustomField.objects.create(project=project, name="BROWSER", type="text"))
    CustomFieldOption.objects.create(field=field, name="Chrome", color="var(--low)")
    refused(lambda: CustomFieldOption.objects.create(field=field, name="chrome", color="var(--low)"))


def test_value_columns(project, task, owner):
    text = CustomField.objects.create(project=project, name="Found in", type="text")
    number = CustomField.objects.create(project=project, name="Accounts", type="number")
    refused(lambda: TaskFieldValue.objects.create(task=task, field=text))  # no column set
    refused(lambda: TaskFieldValue.objects.create(task=task, field=text, text="x", number=1))  # two columns
    refused(lambda: TaskFieldValue.objects.create(task=task, field=number, number=-1))
    refused(lambda: TaskFieldValue.objects.create(task=task, field=number, number=1_000_000_001))
    TaskFieldValue.objects.create(task=task, field=text, text="x")
    refused(lambda: TaskFieldValue.objects.create(task=task, field=text, text="y"))  # one value per task+field
    TaskFieldValue.objects.create(task=task, field=number, number=1_000_000_000)


def test_dependency_constraints(project, task, owner):
    other = create_task(owner, project, {"title": "Other"})
    refused(lambda: TaskDependency.objects.create(blocker=task, blocked=task, project=project))
    TaskDependency.objects.create(blocker=task, blocked=other, project=project)
    refused(lambda: TaskDependency.objects.create(blocker=task, blocked=other, project=project))


def test_time_constraints(project, task, owner):
    refused(lambda: TimeEntry.objects.create(task=task, project=project, user=owner, minutes=0, date="2026-10-07"))
    refused(lambda: TimeEntry.objects.create(task=task, project=project, user=owner, minutes=1441, date="2026-10-07"))
    RunningTimer.objects.create(user=owner, task=task, started_at=task.created_at)
    refused(lambda: RunningTimer.objects.create(user=owner, task=task, started_at=task.created_at))


def test_time_estimate_range(task):
    refused(lambda: Task.objects.filter(pk=task.pk).update(time_estimate_minutes=60_001))
    Task.objects.filter(pk=task.pk).update(time_estimate_minutes=60_000)
