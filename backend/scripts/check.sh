#!/usr/bin/env sh
# Everything CI runs, in order; stops at the first failure.
set -e
PY="${PY:-python}"
$PY -m ruff check .
$PY -m ruff format --check .
$PY -m mypy core modules config
$PY -c "from importlinter.cli import lint_imports_command; lint_imports_command()"  # lint-imports
$PY manage.py makemigrations --check --dry-run --settings=config.settings.test
$PY -m pytest --cov --cov-report=term:skip-covered --cov-fail-under=85 -q
$PY -m coverage report --include="core/access/*" --fail-under=95
$PY manage.py spectacular --file ../docs/openapi.yaml --validate --fail-on-warn --settings=config.settings.test
echo "All checks passed."
