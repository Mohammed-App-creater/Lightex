"""Sales demo data (development only; modules/sales/seed.py lists what it creates).

    python manage.py seed_demo_sales                       # workspace `sales-demo` (created when missing)
    python manage.py seed_demo_sales --workspace platform  # an existing workspace (sales is turned on)
    python manage.py seed_demo_sales --reset               # delete the workspace's sales records first

Idempotent: does nothing when the workspace already has the demo data (use --reset to rebuild it). The demo people
(`*@sales.demo`) use the core demo password. Refuses to run with DEBUG off unless --force.
"""

from __future__ import annotations

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.accounts.models import User
from core.common.management.commands.seed_demo import DEMO_PASSWORD
from core.modules.services import is_enabled, set_module_enabled
from core.workspaces.models import Workspace, WorkspaceMember
from core.workspaces.services import create_workspace
from modules.sales import seed

DEFAULT_SLUG = "sales-demo"
OWNER_EMAIL = f"owner@{seed.EMAIL_DOMAIN}"


class Command(BaseCommand):
    help = "Create sales demo data in one workspace (DEBUG only)."

    def add_arguments(self, parser):
        parser.add_argument("--workspace", default=DEFAULT_SLUG, help="Workspace slug (created when missing)")
        parser.add_argument("--reset", action="store_true", help="Delete the workspace's sales records first")
        parser.add_argument("--force", action="store_true", help="Run even with DEBUG off")

    def handle(self, *args, **options):
        if not settings.DEBUG and not options["force"]:
            raise CommandError("seed_demo_sales only runs with DEBUG=True (or --force); it creates demo accounts.")
        ws = Workspace.objects.filter(slug=options["workspace"]).first()
        if ws is None:
            owner = User.objects.filter(email=OWNER_EMAIL).first()
            if owner is None:
                owner = User(email=OWNER_EMAIL, name="Sales Demo Owner")
                owner.set_password(DEMO_PASSWORD)
                owner.save()
            ws = create_workspace(owner, name="Sales demo", slug=options["workspace"], modules=["sales"])
            ws.timezone = "Africa/Addis_Ababa"
            ws.save(update_fields=["timezone"])
        else:
            member = (
                WorkspaceMember.objects.for_workspace(ws)
                .filter(roles__system_key="owner", status="active")
                .select_related("user")
                .first()
            )
            if member is None:
                raise CommandError(f"Workspace {ws.slug} has no active owner.")
            owner = member.user
            if not is_enabled(ws, "sales"):
                set_module_enabled(owner, ws, "sales", True)
        if options["reset"]:
            seed.reset(ws)
        elif seed.is_seeded(ws):
            self.stdout.write(f"{ws.slug} already has the sales demo data; nothing to do (use --reset to rebuild).")
            return
        counts = seed.seed(ws, owner, password=DEMO_PASSWORD)
        summary = ", ".join(f"{v} {k}" for k, v in counts.items())
        self.stdout.write(self.style.SUCCESS(f"Sales demo data in {ws.slug}: {summary}."))
        self.stdout.write(f"Sign in as ceo@{seed.EMAIL_DOMAIN}, north.manager@… or abel@… with {DEMO_PASSWORD!r}.")
