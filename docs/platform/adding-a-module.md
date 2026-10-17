# Adding a module

A module is a Django package under `backend/modules/<key>/` that plugs into the core through registries. The core
never imports it, and it never imports another module (`lint-imports` fails CI otherwise). This walk-through uses
`sales` (`backend/modules/sales/`) as the example. The rules behind it are in `docs/platform-architecture.md`.

## 1. Create the package and its AppConfig

```
backend/modules/sales/
  __init__.py
  apps.py        # AppConfig: label "sales"; ready() registers the module and its hooks
  module.py      # the ModuleDefinition
  models.py  selectors.py  services.py  serializers.py  views.py  urls.py
  tests/
```

```python
# modules/sales/apps.py
class Config(AppConfig):
    name = "modules.sales"
    label = "sales"

    def ready(self) -> None:
        from core.modules.registry import register_module

        from .module import DEFINITION

        register_module(DEFINITION)
```

Add `"modules.sales"` to `INSTALLED_APPS` (`config/settings/base.py`). Then add the package to the
"Modules are independent" contract in `pyproject.toml` (`[tool.importlinter]`).

## 2. Declare the module

`module.py` holds one `ModuleDefinition` (`core/modules/registry.py`). Name every permission `sales.<resource>.<action>`.
Mark it `scopable=True` when roles should grant it with a data scope (`own`, `team` or `all`).

```python
LEAD_VIEW = "sales.lead.view"
PERMISSIONS = (workspace_permission(LEAD_VIEW, "Sales", "View leads", "See leads", scopable=True),)

DEFINITION = ModuleDefinition(
    key="sales",
    name="Sales",
    description="Leads, opportunities, targets and daily reports for sales teams.",
    permissions=PERMISSIONS,
    default_role_grants={"owner": [LEAD_VIEW], "admin": [LEAD_VIEW], "member": {LEAD_VIEW: "own"}},
    nav_items=(NavItem("sales", "Sales", "briefcase", "sales", LEAD_VIEW),),
    depends_on=(),
    toggleable=True,
)
```

The catalogue is assembled from the definitions and synced after every `migrate`, so no data migration is needed.
Default roles get the grants when a workspace is created with the module, or when the module is enabled later.

## 3. Write workspace-scoped models

Every table has a non-null `workspace` foreign key, even when a parent implies it. Subclass
`WorkspaceScopedModel` (or `WorkspaceScopedSoftDeleteModel` for trash support). Child rows name their parent in
`workspace_parent`, so `create()` and `bulk_create()` fill the workspace for you. A model read through data scope
names its owner field.

```python
class Lead(WorkspaceScopedSoftDeleteModel):
    data_scope_owner_field = "owner"

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    name = models.CharField(max_length=120)


class LeadNote(WorkspaceScopedModel):
    workspace_parent = "lead"

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    lead = models.ForeignKey(Lead, on_delete=models.CASCADE, related_name="notes")
```

Inside a scoped view the manager is already filtered to the request's workspace. Everywhere else, write
`Lead.objects.for_workspace(ws)`. Use `Lead.objects.unscoped()` only in commands, Celery tasks given ids, and code
that really spans workspaces. Never link a core table to a module table: core refers to your records as
`(target_type, target_id)`.

## 4. Generate the migration

```bash
python manage.py makemigrations sales
python manage.py makemigrations --check --dry-run
```

## 5. Reads in selectors, writes in services

List selectors for scopable data go through `visible_to()`, which is the only place a data scope is applied.
Single-record checks use `can()`. Every mutating service writes an audit row (`core.audit.services.record`, action
`sales.lead.created`). It emits domain events inside its transaction
(`core.events.services.emit("sales.lead.assigned", workspace=..., target_type="sales.lead", target_id=..., ...)`).

```python
def leads_for(user, workspace):
    return visible_to(Lead.objects.for_workspace(workspace), user, LEAD_VIEW, workspace)
```

## 6. Thin views on a scoped base

Subclass `WorkspaceScopedView` (core). It resolves `{slug}` (404 for non-members) and scopes the rest of the
request to that workspace. Declare one permission per method. A method without one is refused.

```python
class LeadListView(WorkspaceScopedView):
    required = {"GET": LEAD_VIEW, "POST": "sales.lead.create"}

    @extend_schema(tags=["sales"], operation_id="sales_leads_list", responses=LeadOut(many=True))
    def get(self, request, slug):
        return Response(LeadOut(selectors.leads_for(request.user, self.scope), many=True).data)
```

For a route keyed by a record id instead of a slug (`/sales/leads/{id}`), override `get_scope()` to load the record
(it runs unscoped) and return its workspace.

## 7. Mount the routes behind the module guard

```python
# config/api_urls.py
path("sales/", include(module_urls("sales", [path("", include("modules.sales.urls"))]))),
```

`module_urls` makes every route answer 403 `module_disabled` while the module is off in the workspace. The answer
comes after the membership check, so non-members still get 404. Give operation ids and serializer names that are
stable and prefixed (`sales_leads_list`, `SalesLead`), because the frontend generates its types from them.

## 8. Register with the platform services

Call these from `ready()`, all optional (see the backend README, "Platform services"):

| Hook | Gives you |
|---|---|
| `register_target_type("sales.lead", LeadTarget())` | comments, attachments, mentions, notification titles and links, orphan checks |
| `register_event_type("sales.lead.assigned", ...)` + `register_handler(...)` | notification preferences and delivery (in-app, email, Telegram, SMS, push) |
| `register_search_provider("sales", ...)` | results in `/search` and `/workspaces/{slug}/search` |
| `register_trash_kind(...)` | the workspace trash, restore, purge |
| `register_seeder(SalesSeeder)` | demo data in `manage.py seed_demo` |

Handlers, notifications, search and trash of a disabled module are skipped automatically, and its data is kept.

## 9. Test it

- The tenant-isolation test (`modules/tracking/tests/access/test_tenant_isolation.py`) finds every `sales/` route
  in the URL resolver and fails until it can build the route's kwargs. Add the new kwarg names there.
- Add permission tests per role, data-scope tests (`own`, `team`, `all`, users in several teams), and module tests
  (`module_disabled`, data kept across disable and enable). `modules/sales/tests/` and
  `core/access/tests/test_data_scope.py` show the patterns.
- Run `ruff check .`, `ruff format --check .`, `mypy core modules config`, `lint-imports` and the module's tests.

## 10. Publish the contract

Regenerate the schema (`make schema`, which runs `spectacular --validate`) and commit `docs/openapi.yaml`. Then run
`npm run gen:api` in `frontend/` so the client's generated types pick the module up. Add the module's navigation,
pages and permission checks on the frontend (`frontend/src/modules/<key>/`), and document the module in the backend
README.
