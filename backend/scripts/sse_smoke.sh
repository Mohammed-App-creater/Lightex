#!/usr/bin/env bash
# Board 33 gunicorn smoke test (docs/v2/33-dashboards-presence.md §8.1): the real image, gthread workers, the
# Postgres LISTEN broker and curl as the client. Self-contained: it starts its own throwaway Postgres container on a
# private Docker network, so it never touches your local or production database.
#
#   bash backend/scripts/sse_smoke.sh
#
# Checks, with one worker process, --threads 4 and SSE_MAX_STREAMS_PER_PROCESS=2:
#   1. two streams open and print `hello`;
#   2. a third gets 503 realtime_busy;
#   3. GET /health still answers in under a second;
#   4. a task PATCH reaches both streams (through LISTEN/NOTIFY) within a second;
#   5. a restart (SIGTERM) ends both streams with `reconnect` (`shutdown`);
#   6. after the restart, a stream with Last-Event-ID replays the missed event.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
tag="lightex-sse-smoke"
net="$tag-net"
port="${SMOKE_PORT:-8077}"
api="http://127.0.0.1:$port"
work="$(mktemp -d)"
pids=()

cleanup() {
  for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  docker rm -f "$tag-api" "$tag-db" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; docker logs --tail 40 "$tag-api" >&2 || true; exit 1; }

echo "Building the image…"
docker build -q -t "$tag" "$here" >/dev/null
docker network create "$net" >/dev/null
docker run -d --name "$tag-db" --network "$net" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=lightex postgres:16-alpine >/dev/null
for _ in $(seq 60); do docker exec "$tag-db" pg_isready -U postgres -d lightex >/dev/null 2>&1 && break; sleep 1; done

echo "Starting gunicorn (1 worker, gthread, 4 threads, 2 streams max)…"
docker run -d --name "$tag-api" --network "$net" -p "$port:8000" \
  -e PORT=8000 -e DJANGO_SETTINGS_MODULE=config.settings.prod -e DJANGO_SECRET_KEY=smoke-only \
  -e DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1 -e SECURE_SSL_REDIRECT=false \
  -e DATABASE_URL=postgres://postgres:postgres@$tag-db:5432/lightex \
  -e EMAIL_BACKEND=django.core.mail.backends.console.EmailBackend -e STORAGE_BACKEND=fake \
  -e WEB_CONCURRENCY=1 -e GUNICORN_THREADS=4 -e SSE_MAX_STREAMS_PER_PROCESS=2 -e SSE_HEARTBEAT_SECONDS=2 \
  "$tag" >/dev/null
for _ in $(seq 90); do curl -fs "$api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "$api/health" >/dev/null || fail "the API did not start"

read -r token task slug < <(docker exec "$tag-api" python manage.py shell -c "
from rest_framework_simplejwt.tokens import RefreshToken
from apps.accounts.models import User
from apps.projects.services import create_project
from apps.tasks.services import create_task
from apps.workspaces.services import create_workspace
user = User.objects.create_user(email='smoke@example.com', password='Smoke-pass-2026!', name='Smoke Test')
ws = create_workspace(user, name='Smoke', slug='smoke')
project = create_project(user, ws, {'name': 'Smoke', 'key': 'SMK', 'template': 'simple'})
task = create_task(user, project, {'title': 'Smoke task'})
print(RefreshToken.for_user(user).access_token, task.pk, ws.slug)
" | tail -1)
[[ -n "$token" ]] || fail "could not create the smoke user"
auth=(-H "Authorization: Bearer $token" -H "Accept: text/event-stream")
stream="$api/api/v1/workspaces/$slug/stream"

for i in 1 2; do
  curl -sN --max-time 30 "${auth[@]}" "$stream" >"$work/s$i" &
  pids+=($!)
done
sleep 2
for i in 1 2; do grep -q "event: hello" "$work/s$i" || fail "stream $i printed no hello"; done
echo "ok: two streams print hello"

code=$(curl -s -o "$work/busy" -w "%{http_code}" --max-time 5 "${auth[@]}" "$stream")
[[ "$code" == 503 ]] && grep -q realtime_busy "$work/busy" || fail "third stream: $code $(cat "$work/busy")"
echo "ok: the third stream gets 503 realtime_busy"

took=$(curl -s -o /dev/null -w "%{time_total}" --max-time 5 "$api/health")
awk -v t="$took" 'BEGIN { exit !(t < 1.0) }' || fail "/health took ${took}s"
echo "ok: /health answers in ${took}s while streams are open"

curl -sf -X PATCH -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d '{"title": "Smoke task, edited", "version": 1}' "$api/api/v1/tasks/$task" >/dev/null || fail "PATCH failed"
sleep 1
for i in 1 2; do grep -q "event: task.changed" "$work/s$i" || fail "stream $i did not get task.changed"; done
echo "ok: the PATCH reached both streams within a second"

id=$(grep -m1 -B1 "event: task.changed" "$work/s1" | sed -n 's/^id: //p')
# Restart the API (SIGTERM, as on a deploy): open streams must end with `reconnect` (shutdown) and the slots are
# fresh afterwards. (A client that just disappears frees its slot on the server's next failed write; some local port
# proxies keep the upstream connection open, so this smoke doesn't rely on that.)
docker restart -t 15 "$tag-api" >/dev/null
wait "${pids[@]}" 2>/dev/null || true
pids=()
for i in 1 2; do grep -q '"reason":"shutdown"' "$work/s$i" || fail "stream $i did not end with reconnect (shutdown)"; done
echo "ok: a restart ends both streams with reconnect (shutdown)"
for _ in $(seq 60); do curl -fs "$api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sN --max-time 3 "${auth[@]}" -H "Last-Event-ID: $((id - 1))" "$stream" >"$work/replay" || true
grep -q "\"replayed\":1" "$work/replay" && grep -q "id: $id" "$work/replay" || fail "replay after $((id - 1))"
echo "ok: Last-Event-ID replays the missed event"
echo "SSE smoke passed."
