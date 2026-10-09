"use client";

import * as Popover from "@radix-ui/react-popover";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Segmented, Switch } from "@/components/ui/choice";
import { toast } from "@/components/ui/toast";
import { useSession } from "@/features/auth/session";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { apiMode, devToolsEnabled } from "@/lib/env";
import { mockControls } from "@/lib/mock/controls";
import { useRealtimeStatus } from "@/lib/realtime/status-store";
import { useRouteInfo } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";

/*
 * Dev-only panel. "Try as" signs in as a seeded user that holds the role, proving that
 * actions hide and show from my_permissions alone. Mock controls simulate failures,
 * offline mode and a teammate editing the open card (version conflict).
 */

const PRESETS = [
  { email: "alex@team.dev", name: "Alex Kim", hue: 285, role: "Owner", scope: "Workspace", note: "Project Admin on Platform Rebuild" },
  { email: "jordan@team.dev", name: "Jordan Lee", hue: 200, role: "Admin", scope: "Workspace", note: "Manager on Platform Rebuild" },
  { email: "sam@team.dev", name: "Sam Patel", hue: 20, role: "Member", scope: "Workspace", note: "Member on Platform Rebuild" },
  { email: "alex@team.dev", name: "Alex Kim", hue: 285, role: "Project Admin", scope: "PRJ", note: "Everything in the project" },
  { email: "jordan@team.dev", name: "Jordan Lee", hue: 200, role: "Manager", scope: "PRJ", note: "Plans sprints, edits any task" },
  { email: "sam@team.dev", name: "Sam Patel", hue: 20, role: "Member", scope: "PRJ", note: "Edits own tasks, no delete" },
  { email: "taylor@team.dev", name: "Taylor Ng", hue: 330, role: "Viewer", scope: "PRJ", note: "Read-only" },
  { email: "casey@team.dev", name: "Casey Brooks", hue: 100, role: "Admin, no projects", scope: "Workspace", note: "403 + request access on every project" },
];

export function DevTools() {
  if (!devToolsEnabled) return null;
  return <DevToolsInner />;
}

function DevToolsInner() {
  const { user, signedIn } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const route = useRouteInfo();
  const search = useSearchParams();
  const controls = useSyncExternalStore(mockControls.subscribe, mockControls.get, mockControls.get);
  const realtime = useRealtimeStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const isMock = apiMode === "mock";

  const tryAs = async (email: string, label: string) => {
    setBusy(label);
    try {
      const res = await api.auth.login(email, "password");
      signedIn(res);
      toast.info(`Signed in as ${res.user.name}`, { body: label });
      router.push(`/${route.workspace || "platform"}${route.projectKey ? `/projects/${route.projectKey}${route.view && route.view !== "overview" ? `/${route.view}` : ""}` : ""}`);
      setOpen(false);
    } catch (e) {
      toast.error("Couldn’t switch user", { body: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Developer tools"
          className="fixed bottom-4 right-4 z-[85] flex h-9 items-center gap-2 rounded-full border border-line-2 bg-raised px-3 text-[12px] font-medium text-fg-2 shadow-pop hover:text-fg"
        >
          <FlaskConical size={14} aria-hidden />
          Dev
          {user && <Avatar name={user.name} hue={user.hue} size={18} decorative ring={false} />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-[86] flex max-h-[80dvh] w-[360px] flex-col gap-4 overflow-auto rounded-lg border border-line-2 bg-raised p-4 shadow-modal outline-none data-[state=open]:animate-[menu-in_180ms_var(--ease)]"
        >
          <div>
            <h2 className="m-0 text-[14px] font-semibold">Developer tools</h2>
            <p className="m-0 text-meta text-fg-3">
              {isMock ? "Mock API · data lives in your browser" : "Live API"} · not shown in live production builds
            </p>
            {/* Board 33: the realtime mode is only visible here (polling is a working mode, not an error). */}
            <p className="m-0 mt-1 flex items-center gap-1.5 text-meta text-fg-2" role="status">
              <span aria-hidden className={cn("size-2 rounded-full", realtime === "live" ? "bg-ok" : realtime === "off" ? "bg-danger" : "bg-warn")} />
              Realtime: {realtime}
            </p>
          </div>

          {isMock && (
            <section className="flex flex-col gap-1.5">
              <h3 className="eyebrow m-0">Try as role</h3>
              {PRESETS.map((p) => {
                const label = `${p.role} · ${p.scope}`;
                const current = user?.email === p.email;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => void tryAs(p.email, label)}
                    disabled={busy !== null}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover disabled:opacity-60",
                      current && "bg-accent-s",
                    )}
                  >
                    <Avatar name={p.name} hue={p.hue} size={24} decorative />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[13px] font-medium">
                        {p.role} <span className="font-mono text-[11px] text-fg-3">{p.scope}</span>
                      </span>
                      <span className="truncate text-[11.5px] text-fg-3">
                        {p.name} · {p.note}
                      </span>
                    </span>
                    {busy === label && <span className="text-[11px] text-fg-3">…</span>}
                  </button>
                );
              })}
            </section>
          )}

          {isMock && (
            <section className="flex flex-col gap-3">
              <h3 className="eyebrow m-0">Mock backend</h3>
              <div className="flex items-center justify-between gap-2 text-[13px]">
                <span>Random failures</span>
                <Segmented
                  label="Failure rate"
                  value={String(controls.errorRate) as "0" | "0.03" | "0.25"}
                  onChange={(v) => mockControls.set((c) => ({ ...c, errorRate: Number(v) }))}
                  options={[
                    { value: "0", label: "Off" },
                    { value: "0.03", label: "3%" },
                    { value: "0.25", label: "25%" },
                  ]}
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-[13px]">
                <span>Latency</span>
                <Segmented
                  label="Latency"
                  value={controls.latencyMax <= 50 ? "fast" : controls.latencyMax >= 1500 ? "slow" : "normal"}
                  onChange={(v) =>
                    mockControls.set((c) => ({
                      ...c,
                      latencyMin: v === "fast" ? 0 : v === "slow" ? 1200 : 100,
                      latencyMax: v === "fast" ? 30 : v === "slow" ? 2400 : 400,
                    }))
                  }
                  options={[
                    { value: "fast", label: "0ms" },
                    { value: "normal", label: "100–400" },
                    { value: "slow", label: "1.2–2.4s" },
                  ]}
                />
              </div>
              <Switch
                label="Offline (queue changes)"
                checked={controls.offline}
                onChange={(e) => {
                  const offline = e.target.checked;
                  mockControls.set((c) => ({ ...c, offline }));
                  onlineManager.setOnline(!offline);
                }}
              />
              <Switch
                label="Teammates: presence every 7s, edits every ~45s"
                checked={controls.teammates}
                onChange={(e) => mockControls.set((c) => ({ ...c, teammates: e.target.checked }))}
              />
              <div className="flex items-center justify-between gap-2 text-[13px]">
                <span>Realtime</span>
                <Segmented
                  label="Realtime"
                  value={controls.realtime}
                  onChange={(v) => mockControls.set((c) => ({ ...c, realtime: v }))}
                  options={[
                    { value: "live", label: "Live (SSE)" },
                    { value: "polling", label: "Polling" },
                  ]}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    const { simulateTeammateEdit } = await import("@/lib/mock/teammates");
                    const { getDB } = await import("@/lib/mock/db");
                    const key = search.get("task");
                    const target = key ? getDB().tasks.find((t) => t.key === key.toUpperCase())?.id : undefined;
                    const changed = simulateTeammateEdit(target);
                    toast.info(changed ? `A teammate changed ${changed}` : "No task to change", {
                      body: changed ? "Your next edit to it will hit a version conflict." : undefined,
                    });
                  }}
                >
                  Simulate teammate edit
                </Button>
                <Button
                  size="sm"
                  variant="danger-ghost"
                  onClick={async () => {
                    const { resetDB } = await import("@/lib/mock/db");
                    resetDB();
                    await qc.invalidateQueries();
                    toast.info("Mock data reset to the seed");
                  }}
                >
                  Reset mock data
                </Button>
              </div>
            </section>
          )}
          {isMock && (
            <section className="flex flex-col gap-2">
              <h3 className="eyebrow m-0">Integrations</h3>
              <p className="m-0 text-meta text-fg-3">
                Provider events for {search.get("task") ? <span className="font-mono">{search.get("task")!.toUpperCase()}</span> : "the open task (?task=)"}, applied as the backend processor would.
              </p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["Open PR on task", "simulateOpenPr"],
                    ["Merge PR", "simulateMergePr"],
                    ["Fail checks", "simulateFailChecks"],
                  ] as const
                ).map(([label, fn]) => (
                  <Button
                    key={fn}
                    size="sm"
                    onClick={async () => {
                      const m = await import("@/lib/mock/handlers/integrations");
                      const msg = m[fn](search.get("task"));
                      await qc.invalidateQueries();
                      toast.info(msg);
                    }}
                  >
                    {label}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="danger-ghost"
                  onClick={async () => {
                    const m = await import("@/lib/mock/handlers/integrations");
                    const msg = m.simulateExpireToken(route.workspace || "platform");
                    await qc.invalidateQueries();
                    toast.info(msg);
                  }}
                >
                  Expire GitHub token
                </Button>
              </div>
            </section>
          )}
          <Link href="/dev/ui" className="text-[12px] text-accent-t underline-offset-2 hover:underline">
            Open component gallery
          </Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
