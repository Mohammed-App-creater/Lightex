# Lightex

Internal project-management app for software teams. This is a monorepo:

| Path | What |
|---|---|
| `frontend/` | Next.js 16 web client. It runs fully on an in-browser mock API. **Read `frontend/CLAUDE.md` before working there.** |
| `backend/` | Backend service (Django modular monolith; `manage.py`, `config/`, Docker). Its plan is `docs/backend-plan.md`. |
| `backend/core/` | Platform core: accounts, workspaces, access, teams, modules, collab, events, notifications, channels, realtime, audit, search, common. Must not import `backend/modules/` (import-linter). |
| `backend/modules/` | Toggleable modules: `tracking/` (projects, tasks, planning, reports, dashboards, imports, integrations, time) and `sales/` (skeleton). Modules never import each other. |
| `docs/` | Repo-level docs: `platform-architecture.md` (core + modules design, the source of truth), `platform/` (stage contracts, `adding-a-module.md`), `backend-plan.md` and `openapi.yaml` (the backend's API spec). |
| `.github/workflows/` | CI (`backend.yml`). |

- The frontend and backend are developed in parallel, often by separate sessions. Commit only the paths you changed
  (for example `git commit -- frontend`), and never stage the other side's in-progress work.
- **API contract:**
  - The frontend's expected contract is `frontend/docs/api-contract.md`.
  - The extra endpoints and fields it needs are listed under "Requested API additions" in
    `frontend/docs/final-report.md`.
  - The backend's spec is `docs/openapi.yaml`.
  - Reconcile them before pointing the frontend at the backend (`NEXT_PUBLIC_API_MODE=live`).
