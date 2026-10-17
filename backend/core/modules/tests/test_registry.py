"""Platform Stage 3 (docs/platform/stage3-contract.md §1, §2): the registry, the catalogue assembled from the module
definitions, `sync_permissions`, the per-request cache, the guard's URL wrapper and the tracking data migration."""

import importlib

import pytest
from django.apps import apps as django_apps
from django.core.exceptions import ImproperlyConfigured
from django.core.management import call_command
from django.urls import path
from rest_framework.views import APIView

from core.access import catalogue
from core.access.models import Permission
from core.access.services import sync_permission_catalogue
from core.common.testing import UserFactory, make_workspace
from core.events.registry import event_type
from core.modules import services
from core.modules.models import WorkspaceModule
from core.modules.registry import ModuleDefinition, definitions, get_module, register_module, unregister_module
from core.modules.urls_guard import module_urls

pytestmark = pytest.mark.django_db


def test_core_is_registered_first_and_always_on(ws):
    keys = [d.key for d in definitions()]
    assert keys[0] == "core"
    assert {"core", "tracking", "sales"} <= set(keys)
    core = get_module("core")
    assert core.is_core and not core.toggleable
    assert not WorkspaceModule.objects.filter(workspace=ws, module_key="core").exists()
    assert services.is_enabled(ws, "core")


def test_catalogue_is_assembled_from_the_definitions():
    from_defs = [p.code for d in definitions() for p in d.permissions]
    assert [p.code for p in catalogue.all_permissions()] == list(dict.fromkeys(from_defs))
    assert {p.code for p in catalogue.CORE_PERMISSIONS} == {p.code for p in get_module("core").permissions}
    # core/access/catalogue.py keeps only core's entries; every other code comes from a module definition.
    assert all(p.module == "core" for p in catalogue.CORE_PERMISSIONS)
    for d in definitions():
        assert all(p.module == d.key for p in d.permissions), d.key
    # The default roles combine core's grants with each module's default_role_grants.
    owner = catalogue.role_def("owner")
    for d in definitions():
        assert set(d.default_role_grants.get("owner", [])) <= set(owner.permissions)


def test_a_module_registered_later_joins_the_catalogue():
    register_module(
        ModuleDefinition(
            key="extra",
            name="Extra",
            permissions=(catalogue.workspace_permission("extra.thing.view", "Extra", "View", "View things"),),
        )
    )
    try:
        assert catalogue.get("extra.thing.view").module == "extra"
        assert catalogue.codes("workspace")[-1] == "extra.thing.view"
        assert sync_permission_catalogue() == (1, 0, 0)
        assert Permission.objects.get(code="extra.thing.view").module == "extra"
    finally:
        unregister_module("extra")
    assert catalogue.get("extra.thing.view") is None
    assert sync_permission_catalogue() == (0, 0, 1)


def test_a_definition_cannot_declare_another_modules_permission():
    with pytest.raises(ValueError):
        register_module(
            ModuleDefinition(
                key="bad", name="Bad", permissions=(catalogue.workspace_permission("core.x.y", "A", "B", "C"),)
            )
        )
    assert get_module("bad") is None


def test_sync_permissions_is_idempotent(capsys):
    assert sync_permission_catalogue() == (0, 0, 0)
    call_command("sync_permissions")
    assert "0 created, 0 updated, 0 removed" in capsys.readouterr().out
    assert Permission.objects.count() == len(catalogue.all_permissions())
    assert set(Permission.objects.values_list("module", flat=True)) >= {"core", "tracking", "sales"}


def test_event_types_come_from_the_definitions():
    assert event_type("core.comment.mentioned").module == "core"
    assigned = event_type("tracking.task.assigned")
    assert (assigned.module, assigned.channel_template, assigned.email_templates) == (
        "tracking",
        "assigned",
        ("task_assigned",),
    )
    assert assigned.channel_summary({"task_key": "WEB-1"}) == "WEB-1 assigned to you"


def test_module_templates_are_registered_with_the_renderers():
    from core.channels import render
    from core.notifications import emails

    assert {"assigned", "status_change", "due_soon", "sprint_started", "mentioned", "comment"} <= set(
        render.templates()
    )
    assert {"task_assigned", "sprint_completed", "invitation"} <= emails.templates()
    assert render.summary_line("sprint_started", {"sprint_name": "S1"}) == "S1 started"
    assert (
        render.summary_line("mentioned", {"task_key": "WEB-2", "actor_name": "Sam Rivera"})
        == "WEB-2 · Sam mentioned you"
    )


def test_enabled_modules_are_cached_per_request(ws, django_assert_num_queries):
    register_module(ModuleDefinition(key="cached", name="Cached"))
    try:
        with services.request_cache(), django_assert_num_queries(1):
            assert services.enabled_modules(ws) == ["core", "tracking"]
            assert not services.is_enabled(ws, "cached")
            assert not services.is_enabled(ws.pk, "cached")
        with django_assert_num_queries(2):  # outside a request every lookup reads the table
            services.is_enabled(ws, "cached")
            services.is_enabled(ws, "cached")
    finally:
        unregister_module("cached")


def test_prime_loads_many_workspaces_in_one_query(owner, ws, django_assert_num_queries):
    other = make_workspace(owner, name="Other team", slug="other")
    with services.request_cache():
        with django_assert_num_queries(1):
            services.prime([ws, other])
        with django_assert_num_queries(0):
            assert services.enabled_modules(ws) == services.enabled_modules(other) == ["core", "tracking"]
            services.is_enabled(other, "sales")


def test_unknown_module_keys_are_not_gated(ws):
    assert services.is_enabled(ws, "nope")
    assert services.code_enabled(ws, "nope.thing.view")


def test_module_urls_refuses_unscoped_views_of_a_toggleable_module():
    register_module(ModuleDefinition(key="loose", name="Loose"))
    try:
        with pytest.raises(ImproperlyConfigured):
            module_urls("loose", [path("x", APIView.as_view())])
    finally:
        unregister_module("loose")
    # A non-toggleable module (tracking) may keep unscoped routes (my tasks, timers).
    wrapped = module_urls("tracking", [path("x", APIView.as_view(), name="x")])
    assert wrapped[0].callback.cls is APIView
    assert wrapped[0].callback.lx_module == "tracking"


def test_data_migration_enables_tracking_for_existing_workspaces(db):
    ws = make_workspace(UserFactory(), slug="legacy")
    WorkspaceModule.objects.filter(workspace=ws).delete()
    migration = importlib.import_module("core.modules.migrations.0002_enable_tracking")
    migration.enable_tracking(django_apps, None)
    migration.enable_tracking(django_apps, None)  # idempotent
    row = WorkspaceModule.objects.get(workspace=ws)
    assert (row.module_key, row.enabled, row.enabled_by) == ("tracking", True, None)
