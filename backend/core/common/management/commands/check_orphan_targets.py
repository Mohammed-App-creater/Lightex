"""Reports generic references whose target no longer exists (core/common/targets.py).

Comments, attachments, notifications and domain events refer to module records by `(target_type, target_id)` with no
foreign key, so nothing in the database stops a target from disappearing. Run it after purges or imports:

    python manage.py check_orphan_targets            # report; exit code 1 when orphans are found
    python manage.py check_orphan_targets --verbose  # also list each orphaned reference
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from core.common.targets import get_resolver


def _sources() -> list[tuple[str, Any]]:
    from core.collab.models import Attachment, Comment
    from core.events.models import DomainEvent
    from core.notifications.models import Notification

    return [
        ("comments", Comment.all_objects.all()),
        ("attachments", Attachment.all_objects.all()),
        ("notifications", Notification.objects.exclude(target_type="")),
        ("events", DomainEvent.objects.exclude(target_type="").filter(target_id__isnull=False)),
    ]


def find_orphans() -> dict[str, list[tuple[str, str]]]:
    """{source: [(target_type, target_id), …]} for references to unknown types or missing records."""
    found: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for source, qs in _sources():
        pairs = qs.values_list("target_type", "target_id").distinct()
        for target_type, target_id in pairs:
            resolver = get_resolver(target_type)
            if resolver is None or not resolver.record_exists(target_id):
                found[source].append((target_type, str(target_id)))
    return dict(found)


class Command(BaseCommand):
    help = "Report comments, attachments, notifications and events whose target no longer exists."

    def add_arguments(self, parser):
        parser.add_argument("--verbose", action="store_true", help="List every orphaned reference")

    def handle(self, *args, **options):
        orphans = find_orphans()
        if not orphans:
            self.stdout.write(self.style.SUCCESS("No orphaned target references."))
            return
        for source, refs in orphans.items():
            self.stdout.write(f"{source}: {len(refs)} orphaned target(s)")
            if options["verbose"]:
                for target_type, target_id in refs:
                    self.stdout.write(f"  {target_type} {target_id}")
        raise CommandError("Orphaned target references found.", returncode=1)
