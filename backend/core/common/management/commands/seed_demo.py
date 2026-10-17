"""Demo data equivalent to the web client's mock seed (development only).

Loads core/common/fixtures/demo_seed.json, which is exported from frontend/src/lib/mock/seed.ts (see
scripts/frontend-seed/). IDs become UUIDs and every date is shifted so the data looks current.
Status history is synthesised from each task's started/completed timestamps so reports have data.

    python manage.py seed_demo            # refuses if the demo workspace already exists
    python manage.py seed_demo --flush    # deletes the demo workspaces and users first

Core creates users, workspaces, roles, members and invitations; every registered seeder (core/common/seeding.py)
then loads its module's part of the fixture (tracking: modules/tracking/hooks/seed.py).

Every demo account uses DEMO_PASSWORD. The command refuses to run when DEBUG is off.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from core.access.models import Permission, Role, RolePermission
from core.access.services import seed_default_roles
from core.accounts.models import User
from core.common.seeding import SeedContext, seeders
from core.common.tokens import new_token
from core.workspaces.models import Invitation, Workspace, WorkspaceMember

DEMO_PASSWORD = "Lightex-demo-2026"
FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "demo_seed.json"
ANCHOR = dt.date(2026, 10, 7)


class Command(BaseCommand, SeedContext):
    help = "Create demo data matching the web client's mock data (DEBUG only)."

    def add_arguments(self, parser):
        parser.add_argument("--flush", action="store_true", help="Delete existing demo workspaces and users first")

    def handle(self, *args, **options):
        if not settings.DEBUG:
            raise CommandError("seed_demo only runs with DEBUG=True (it creates accounts with a known password).")
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.shift = timezone.now().date() - ANCHOR
        slugs = [w["slug"] for w in data["workspaces"]]
        emails = [u["email"] for u in data["users"]]
        with transaction.atomic():
            if options["flush"]:
                from core.audit.trash import purge_workspace

                for ws in Workspace.all_objects.filter(slug__in=slugs):
                    purge_workspace(ws)
                User.objects.filter(email__in=emails).delete()
            elif Workspace.all_objects.filter(slug__in=slugs).exists():
                raise CommandError("Demo data already exists. Run with --flush to recreate it.")
            self.load(data)
        self.report(data)

    # ── loading ──

    def load(self, data: dict[str, Any]) -> None:
        self.users = {}
        for u in data["users"]:
            user = User(email=u["email"], name=u["name"], hue=u["hue"])
            user.set_password(DEMO_PASSWORD)
            user.created_at = self.ts(u["createdAt"]) or timezone.now()
            user.save()
            self.users[u["id"]] = user
        perms = {p.code: p for p in Permission.objects.all()}
        self.workspaces, self.roles = {}, {}
        for w in data["workspaces"]:
            ws = Workspace.objects.create(
                slug=w["slug"], name=w["name"], hue=w["hue"], created_at=self.ts(w["createdAt"])
            )
            self.workspaces[w["id"]] = ws
            for key, role in seed_default_roles(ws).items():
                self.roles[f"{w['id']}-role-{key}"] = role
        for r in data["roles"]:
            if r["isSystem"]:
                continue
            role = Role.objects.create(
                workspace=self.workspaces[r["workspaceId"]],
                name=r["name"],
                description=r["description"],
                scope=r["scope"],
            )
            RolePermission.objects.bulk_create(
                [RolePermission(role=role, permission=perms[c]) for c in r["permissions"]]
            )
            self.roles[r["id"]] = role
        for m in data["wsMembers"]:
            WorkspaceMember.objects.create(
                workspace=self.workspaces[m["workspaceId"]],
                user=self.users[m["userId"]],
                role=self.roles[m["roleId"]],
                status=m["status"],
                joined_at=self.moment(m["joinedAt"]),
                last_active_at=self.ts(m["lastActiveAt"]),
            )
        for seeder in seeders():  # modules (tracking) load their part of the fixture
            seeder.bound(self).load(data)
        self.invite_links = []
        for inv in data["invites"]:
            raw, digest = new_token()
            Invitation.objects.create(
                workspace=self.workspaces[inv["workspaceId"]],
                email=inv["email"],
                role=self.roles[inv["roleId"]],
                invited_by=self.users.get(inv["invitedById"]),
                token_hash=digest,
                expires_at=timezone.now() + dt.timedelta(days=7),
            )
            self.invite_links.append((inv["email"], f"{settings.FRONTEND_URL}/invite/{raw}"))

    def report(self, data: dict[str, Any]) -> None:
        out = self.stdout
        out.write(self.style.SUCCESS("Demo data created."))
        counts = {"workspaces": len(data["workspaces"])}
        for seeder in seeders():
            counts.update(seeder.bound(self).counts(data))
        out.write("  " + ", ".join(f"{v} {k}" for k, v in counts.items()))
        out.write(f"  Password for every account: {DEMO_PASSWORD}")
        for email in ("alex@team.dev", "jordan@team.dev", "sam@team.dev", "taylor@team.dev", "casey@team.dev"):
            out.write(f"    {email}")
        for email, link in getattr(self, "invite_links", []):
            out.write(f"  Pending invite for {email}: {link}")
