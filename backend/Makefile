PY ?= python
MANAGE = $(PY) manage.py

.PHONY: install run migrate seed test cov lint fmt typecheck schema check up down

install:
	$(PY) -m pip install -r requirements-dev.txt

run:
	$(MANAGE) runserver 0.0.0.0:8000

migrate:
	$(MANAGE) migrate

seed:
	$(MANAGE) seed_demo

test:
	$(PY) -m pytest

cov:
	$(PY) -m pytest --cov --cov-report=term --cov-fail-under=85
	$(PY) -m coverage report --include="apps/access/*" --fail-under=95

lint:
	$(PY) -m ruff check .
	$(PY) -m ruff format --check .

fmt:
	$(PY) -m ruff format .
	$(PY) -m ruff check --fix .

typecheck:
	$(PY) -m mypy apps config

schema:
	$(MANAGE) spectacular --file ../docs/openapi.yaml --validate

check:
	PY=$(PY) sh scripts/check.sh

up:
	docker compose up --build

down:
	docker compose down
