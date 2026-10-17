#!/usr/bin/env python
import os
import sys


def main() -> None:
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")
    from django.core.management import execute_from_command_line

    from core.common.scoping import unscoped

    # Management commands are an explicit escape hatch of workspace scoping (requests served by runserver still run
    # strict: each starts in its own context).
    with unscoped():
        execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
