#!/usr/bin/env node
/*
 * Read-only load test for the Lightex API. Each virtual user repeatedly "opens a project page":
 * it fires the same GET requests the web client sends in parallel, waits a few seconds, and
 * repeats. Nothing is created or changed, so it is safe to point at real data.
 *
 *   node scripts/load-test.mjs --url https://api.example.com --email you@team.dev --password '…' \
 *     [--users 20] [--duration 60] [--think 3] [--workspace platform] [--project PRJ]
 *
 * One sign-in is shared by every virtual user (the login endpoint is throttled per IP). The API's
 * per-user throttle then applies to all of them together, so 429s are reported separately.
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const base = (args.url ?? "http://localhost:8000").replace(/\/$/, "") + "/api/v1";
const users = Number(args.users ?? 20);
const durationMs = Number(args.duration ?? 60) * 1000;
const thinkMs = Number(args.think ?? 3) * 1000;
const slug = args.workspace ?? "platform";
const key = args.project ?? "PRJ";
if (!args.email || !args.password) {
  console.error("Missing --email and --password (an account that can see the project).");
  process.exit(1);
}

const samples = []; // { name, ms, status }
const pages = []; // ms for a whole page (all parallel requests)

async function timed(name, path, token) {
  const t = performance.now();
  let status = 0;
  try {
    const res = await fetch(base + path, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
    status = res.status;
    await res.arrayBuffer();
  } catch {
    status = 0; // network error / timeout
  }
  samples.push({ name, ms: performance.now() - t, status });
  return status;
}

async function signIn() {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: args.email, password: args.password }),
  });
  if (!res.ok) throw new Error(`Sign-in failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

async function getJson(path, token) {
  const res = await fetch(base + path, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

async function main() {
  console.log(`Target ${base}  users=${users}  duration=${durationMs / 1000}s  think=${thinkMs / 1000}s`);
  const token = await signIn();
  const project = await getJson(`/workspaces/${slug}/projects/${key}`, token);
  const ws = await getJson(`/workspaces/${slug}`, token);
  const pid = project.id;
  const page = [
    ["auth/me", "/auth/me"],
    ["workspace", `/workspaces/${slug}`],
    ["projects", `/workspaces/${slug}/projects`],
    ["project", `/workspaces/${slug}/projects/${key}`],
    ["unread-count", `/notifications/unread-count?filter[workspace]=${ws.id}`],
    ["my-tasks", `/workspaces/${slug}/tasks?filter[assignee]=me&limit=200`],
    ["tasks", `/projects/${pid}/tasks?limit=500`],
    ["statuses", `/projects/${pid}/statuses`],
    ["members", `/projects/${pid}/members`],
    ["objectives", `/projects/${pid}/objectives`],
    ["milestones", `/projects/${pid}/milestones`],
    ["epics", `/projects/${pid}/epics`],
    ["sprints", `/projects/${pid}/sprints`],
    ["active-sprint", `/projects/${pid}/active-sprint`],
    ["activity", `/projects/${pid}/activity?limit=20`],
    ["board", `/projects/${pid}/board?filter[sprint]=active`],
  ];

  const end = Date.now() + durationMs;
  const started = Date.now();
  const user = async (i) => {
    await new Promise((r) => setTimeout(r, (i * 1000) / users)); // ramp up over the first second
    while (Date.now() < end) {
      const t = performance.now();
      await Promise.all(page.map(([name, path]) => timed(name, path, token)));
      pages.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, thinkMs * (0.5 + Math.random())));
    }
  };
  const ticker = setInterval(() => console.log(`  ${Math.round((Date.now() - started) / 1000)}s: ${samples.length} requests, ${pages.length} pages`), 15000);
  await Promise.all(Array.from({ length: users }, (_, i) => user(i)));
  clearInterval(ticker);
  const elapsed = (Date.now() - started) / 1000;

  const all = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus = samples.reduce((m, s) => ((m[s.status || "network error"] = (m[s.status || "network error"] ?? 0) + 1), m), {});
  const pageSorted = [...pages].sort((a, b) => a - b);
  console.log(`\n\nRequests: ${samples.length} in ${elapsed.toFixed(0)}s (${(samples.length / elapsed).toFixed(1)} req/s)`);
  console.log(`Status codes: ${JSON.stringify(byStatus)}`);
  console.log(`Request latency  p50 ${fmt(pct(all, 50))}  p95 ${fmt(pct(all, 95))}  p99 ${fmt(pct(all, 99))}  max ${fmt(all.at(-1) ?? 0)}`);
  console.log(`Full page load   p50 ${fmt(pct(pageSorted, 50))}  p95 ${fmt(pct(pageSorted, 95))}  max ${fmt(pageSorted.at(-1) ?? 0)}  (${pages.length} pages)\n`);
  console.log("endpoint".padEnd(16), "p50".padStart(8), "p95".padStart(8), "max".padStart(8), "errors".padStart(7));
  for (const [name] of page) {
    const s = samples.filter((x) => x.name === name);
    const ms = s.map((x) => x.ms).sort((a, b) => a - b);
    const errors = s.filter((x) => x.status !== 200).length;
    console.log(name.padEnd(16), fmt(pct(ms, 50)).padStart(8), fmt(pct(ms, 95)).padStart(8), fmt(ms.at(-1) ?? 0).padStart(8), String(errors).padStart(7));
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
