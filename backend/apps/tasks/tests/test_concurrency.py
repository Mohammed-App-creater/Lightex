"""Real concurrent transactions (separate DB connections per thread)."""

import threading

import pytest
from django.db import connection

from apps.common.exceptions import ApiError
from apps.common.testing import UserFactory, make_project, make_workspace
from apps.tasks.models import Task
from apps.tasks.services import create_task, update_task


def _run_parallel(n, fn):
    errors: list[BaseException] = []
    barrier = threading.Barrier(n)

    def worker(i):
        try:
            barrier.wait()
            fn(i)
        except BaseException as exc:
            errors.append(exc)
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return errors


@pytest.mark.django_db(transaction=True)
def test_concurrent_creates_get_unique_keys():
    owner = UserFactory()
    ws = make_workspace(owner, slug="race")
    project = make_project(ws, owner, key="RACE")

    def create(i):
        for j in range(5):
            create_task(owner, project, {"title": f"T{i}-{j}"})

    errors = _run_parallel(8, create)
    assert not errors, errors
    numbers = list(Task.objects.filter(project=project).values_list("number", flat=True))
    keys = list(Task.objects.filter(project=project).values_list("key", flat=True))
    assert sorted(numbers) == list(range(1, 41))
    assert len(set(keys)) == 40
    project.refresh_from_db()
    assert project.task_seq == 40


@pytest.mark.django_db(transaction=True)
def test_concurrent_edits_with_same_version_conflict():
    owner = UserFactory()
    ws = make_workspace(owner, slug="race2")
    project = make_project(ws, owner, key="EDIT")
    task = create_task(owner, project, {"title": "Shared"})
    outcomes: list[str] = []
    lock = threading.Lock()

    def edit(i):
        try:
            update_task(owner, Task.objects.get(pk=task.pk), {"title": f"Edit {i}", "version": 1})
            result = "ok"
        except ApiError as exc:
            result = exc.code
        with lock:
            outcomes.append(result)

    errors = _run_parallel(6, edit)
    assert not errors, errors
    assert outcomes.count("ok") == 1
    assert outcomes.count("version_conflict") == 5
    assert Task.objects.get(pk=task.pk).version == 2
