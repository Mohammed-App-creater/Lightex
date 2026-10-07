#!/usr/bin/env sh
# Everything CI runs, in order; stops at the first failure.
set -e
PY="${PY:-python}"
$PY -m ruff check .
$PY -m ruff format --check .
$PY -m mypy apps config
$PY manage.py makemigrations --check --dry-run --settings=config.settings.test
$PY -m pytest --cov --cov-report=term:skip-covered --cov-fail-under=85 -q
$PY -m coverage report --include="apps/access/*" --fail-under=95
$PY manage.py spectacular --file ../docs/openapi.yaml --validate --settings=config.settings.test
echo "All checks passed."
