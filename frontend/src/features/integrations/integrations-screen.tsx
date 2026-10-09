"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { toast } from "@/components/ui/toast";
import { SettingsPage, SettingsSection } from "@/features/settings/settings-shell";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Integration, IntegrationsOverview, Provider } from "@/lib/api/types";
import { apiMode } from "@/lib/env";
import { can, useCurrentWorkspace } from "@/lib/permissions/can";
import { replaceUrl } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { ConnectionCard } from "./connection-card";
import { DisconnectDialog, GitLabConnectDialog, MockAuthorizeDialog, ReconnectTokenDialog } from "./dialogs";
import { CONNECT_STORAGE_KEY, connectErrorCopy, parseConnectFragment, PROVIDER_NAME } from "./lib/dev-lib";
import { ProviderTile, type TileState } from "./provider-tile";
import { useIntegrations } from "./queries";
import { RepoPicker } from "./repo-picker";
import { TaskKeysCard } from "./task-keys-card";

type Pending = { provider: Provider; mode: "connect" | "reconnect"; integrationId: string | null; startedAt?: number };
type Banner = { text: string; tone: "info" | "error" };
type Picker = { integration: Integration; mode: "connect" | "edit" };

function readPending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(CONNECT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}
function writePending(p: Pending | null) {
  try {
    if (p) sessionStorage.setItem(CONNECT_STORAGE_KEY, JSON.stringify({ ...p, startedAt: Date.now() }));
    else sessionStorage.removeItem(CONNECT_STORAGE_KEY);
  } catch {
    /* storage blocked: the return just won't say "cancelled" */
  }
}

/** Confirm calls already sent (React dev mode runs effects twice; the token is single-use). */
const confirming = new Set<string>();

const stripHash = () => replaceUrl(window.location.pathname + window.location.search);

/**
 * Workspace settings → Integrations (board 37, §9.3): Source control (a card per connection, then a
 * tile per provider not yet connected) and Task keys. Every member sees it; actions need
 * `integration.manage`. The provider round-trip (§9.6) ends here with `#connect=<attempt>.<token>`,
 * which is removed from the address bar before the confirm call.
 */
export function IntegrationsScreen() {
  const ws = useCurrentWorkspace()!;
  const slug = ws.slug;
  const qc = useQueryClient();
  const canManage = can("integration.manage", ws.my_permissions);
  const q = useIntegrations(slug);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [mockAuth, setMockAuth] = useState<{ provider: Provider; attempt: string } | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [saving, setSaving] = useState(false);
  const [disconnect, setDisconnect] = useState<Integration | null>(null);
  const [gitlabOpen, setGitlabOpen] = useState(false);
  const [tokenReconnect, setTokenReconnect] = useState<Integration | null>(null);
  const handled = useRef(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.integrations(slug) });
    void qc.invalidateQueries({ queryKey: qk.projects(slug) });
    void qc.invalidateQueries({ queryKey: ["project", slug] });
  };

  /* ── the return from the provider (§9.6 #2) and the mock consent page (#4) ── */
  useEffect(() => {
    const onHash = () => {
      const f = parseConnectFragment(window.location.hash);
      if (!f) return;
      if (f.kind === "mock") {
        setMockAuth({ provider: f.provider, attempt: f.attempt });
        return;
      }
      stripHash();
      setMockAuth(null);
      const p = readPending();
      writePending(null);
      setPending(null);
      if (f.kind === "error") {
        setBanner(connectErrorCopy(f.code, p?.provider ?? null));
        return;
      }
      if (confirming.has(f.attempt)) return;
      confirming.add(f.attempt);
      setBanner(null);
      api.integrations
        .confirm(slug, { attempt: f.attempt, token: f.token })
        .then((integration) => {
          refresh();
          if (p?.mode === "reconnect") toast.success(`${PROVIDER_NAME[integration.provider]} reconnected`);
          else setPicker({ integration, mode: "connect" });
        })
        .catch((e) => {
          if (isApiError(e) && e.status === 404) setBanner({ text: "That connection link expired. Try again.", tone: "error" });
          else setBanner({ text: errorMessage(e), tone: "error" });
        });
    };
    const first = () => {
      if (!handled.current) {
        handled.current = true;
        // Back without a fragment (the browser's Back from the provider): "Connection cancelled".
        if (!parseConnectFragment(window.location.hash) && readPending() && apiMode === "live") {
          writePending(null);
          setBanner({ text: "Connection cancelled.", tone: "info" });
        }
      }
      onHash();
    };
    const t = window.setTimeout(first, 0);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("hashchange", onHash);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  /* ── starting a round-trip (§9.6 #1) ── */
  const go = async (provider: Provider, mode: "connect" | "reconnect", integrationId: string | null, start: () => Promise<{ authorizeUrl: string } | Integration>) => {
    setBanner(null);
    const p: Pending = { provider, mode, integrationId };
    setPending(p);
    try {
      const res = await start();
      if ("authorizeUrl" in res) {
        writePending(p);
        window.location.assign(res.authorizeUrl);
        return res;
      }
      setPending(null);
      return res;
    } catch (e) {
      setPending(null);
      throw e;
    }
  };

  const connectGitHub = () => {
    void go("github", "connect", null, () => api.integrations.connectGitHub(slug)).catch((e) => toast.error("Couldn’t connect GitHub", { body: errorMessage(e) }));
  };

  const reconnect = (i: Integration) => {
    if (i.authKind === "gitlab_token") {
      setTokenReconnect(i);
      return;
    }
    void go(i.provider, "reconnect", i.id, () => api.integrations.reconnect(i.id)).catch((e) => toast.error(`Couldn’t reconnect ${PROVIDER_NAME[i.provider]}`, { body: errorMessage(e) }));
  };

  const cancelWaiting = () => {
    if (mockAuth) {
      void import("@/lib/mock/handlers/integrations").then((m) => {
        window.location.hash = m.fakeAuthorize(mockAuth.attempt, { deny: true });
      });
    }
    writePending(null);
    setPending(null);
    setMockAuth(null);
  };

  /* ── picker (G9) ── */
  const savePicker = async (externalIds: string[]) => {
    if (!picker) return;
    const { integration, mode } = picker;
    setSaving(true);
    try {
      // Already-tracked repositories keep their project scope; new ones apply to all projects.
      const body = externalIds.map((externalId) => {
        const cur = integration.repositories.find((r) => r.externalId === externalId);
        return cur && !cur.allProjects ? { externalId, projectIds: cur.projectIds } : { externalId };
      });
      const next = await api.integrations.setRepositories(integration.id, body);
      qc.setQueryData<IntegrationsOverview>(qk.integrations(slug), (o) =>
        o ? { ...o, integrations: o.integrations.some((x) => x.id === next.id) ? o.integrations.map((x) => (x.id === next.id ? next : x)) : [...o.integrations, next] } : o,
      );
      refresh();
      setPicker(null);
      const n = next.repositories.length;
      toast.success(mode === "connect" ? `${PROVIDER_NAME[next.provider]} connected · ${n} ${n === 1 ? "repo" : "repos"}` : "Repositories updated");
    } catch (e) {
      toast.error("Couldn’t save the repositories", { body: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  const cancelPicker = () => {
    if (!picker) return;
    const { integration, mode } = picker;
    setPicker(null);
    // §11 #20: Cancel on the first picker after a connect returns to "not connected" (disconnects).
    if (mode === "connect" && integration.repositories.length === 0) {
      void api.integrations
        .disconnect(integration.id)
        .then(refresh)
        .catch(() => refresh());
    }
  };

  /* ── disconnect (G13, optimistic) ── */
  const doDisconnect = async (i: Integration) => {
    setDisconnect(null);
    const key = qk.integrations(slug);
    await qc.cancelQueries({ queryKey: key });
    const prev = qc.getQueryData<IntegrationsOverview>(key);
    qc.setQueryData<IntegrationsOverview>(key, (o) => (o ? { ...o, integrations: o.integrations.filter((x) => x.id !== i.id) } : o));
    try {
      await api.integrations.disconnect(i.id);
      toast.success(`${PROVIDER_NAME[i.provider]} disconnected`);
    } catch (e) {
      if (prev) qc.setQueryData(key, prev);
      toast.error(`Couldn’t disconnect ${PROVIDER_NAME[i.provider]}`, { body: `${errorMessage(e)} Reverted.` });
    } finally {
      refresh();
    }
  };

  const data = q.data;
  const connected = new Set((data?.integrations ?? []).map((i) => i.provider));
  const tileState = (p: Provider): TileState =>
    pending?.provider === p && pending.mode === "connect" ? "waiting" : picker?.mode === "connect" && picker.integration.provider === p && picker.integration.repositories.length === 0 ? "choosing" : "idle";

  return (
    <SettingsPage title="Integrations">
      {banner && (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          className={cn(
            "mb-4 flex items-start gap-2.5 rounded-[10px] border px-3.5 py-2.5 text-[13px]",
            banner.tone === "error" ? "border-[color-mix(in_srgb,var(--danger)_40%,transparent)] bg-danger-s text-fg" : "border-line-2 bg-raised text-fg-2",
          )}
        >
          {banner.tone === "error" ? <TriangleAlert size={15} aria-hidden className="mt-0.5 flex-none text-danger" /> : <Info size={15} aria-hidden className="mt-0.5 flex-none text-fg-3" />}
          <span className="flex-1">{banner.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setBanner(null)} className="-m-1 flex size-6 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg">
            <X size={13} aria-hidden />
          </button>
        </div>
      )}

      {q.isPending ? (
        <LoadingState />
      ) : q.isError ? (
        <ErrorState title="Couldn’t load integrations" body={errorMessage(q.error)} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          <SettingsSection title="Source control" description="Link branches, commits and pull requests to tasks by their key.">
            {data!.integrations.map((i) => (
              <ConnectionCard
                key={i.id}
                integration={i}
                slug={slug}
                canManage={canManage}
                waiting={pending?.mode === "reconnect" && pending.integrationId === i.id}
                onEditRepos={() => setPicker({ integration: i, mode: "edit" })}
                onReconnect={() => reconnect(i)}
                onDisconnect={() => setDisconnect(i)}
                onAddAnother={() => (i.provider === "github" ? connectGitHub() : setGitlabOpen(true))}
              />
            ))}
            {data!.providers.some((p) => !connected.has(p.provider)) && (
              <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
                {data!.providers
                  .filter((p) => !connected.has(p.provider))
                  .map((p) => (
                    <ProviderTile
                      key={p.provider}
                      info={p}
                      canManage={canManage}
                      state={tileState(p.provider)}
                      onConnect={() => (p.provider === "github" ? connectGitHub() : setGitlabOpen(true))}
                      onCancel={cancelWaiting}
                    />
                  ))}
              </div>
            )}
          </SettingsSection>
          <SettingsSection title="Task keys" description="Put a task key in a branch name, PR title or commit message.">
            <TaskKeysCard slug={slug} />
          </SettingsSection>
        </>
      )}

      {mockAuth && (
        <MockAuthorizeDialog
          provider={mockAuth.provider}
          onCancel={cancelWaiting}
          onAuthorize={() => {
            const a = mockAuth;
            void import("@/lib/mock/handlers/integrations").then((m) => {
              window.location.hash = m.fakeAuthorize(a.attempt);
            });
          }}
        />
      )}
      {picker && <RepoPicker integration={picker.integration} mode={picker.mode} saving={saving} onCancel={cancelPicker} onConfirm={(ids) => void savePicker(ids)} />}
      {disconnect && <DisconnectDialog provider={disconnect.provider} onCancel={() => setDisconnect(null)} onConfirm={() => void doDisconnect(disconnect)} />}
      {gitlabOpen && data && (
        <GitLabConnectDialog
          info={data.providers.find((p) => p.provider === "gitlab")!}
          onClose={() => setGitlabOpen(false)}
          onOAuth={async () => {
            setGitlabOpen(false);
            await go("gitlab", "connect", null, () => api.integrations.connectGitLab(slug, { method: "oauth" }));
          }}
          onToken={async (baseUrl, token) => {
            const res = await go("gitlab", "connect", null, () => api.integrations.connectGitLab(slug, { method: "token", baseUrl, token }));
            if (!("authorizeUrl" in res)) {
              setGitlabOpen(false);
              refresh();
              setPicker({ integration: res, mode: "connect" });
            }
          }}
          onReconnectExisting={(id) => {
            setGitlabOpen(false);
            const i = data.integrations.find((x) => x.id === id);
            if (i) reconnect(i);
          }}
        />
      )}
      {tokenReconnect && (
        <ReconnectTokenDialog
          integration={tokenReconnect}
          onClose={() => setTokenReconnect(null)}
          onSubmit={async (token) => {
            await api.integrations.reconnect(tokenReconnect.id, { token });
            setTokenReconnect(null);
            refresh();
            toast.success("GitLab reconnected");
          }}
        />
      )}
    </SettingsPage>
  );
}

/** The design's loading frame. */
function LoadingState() {
  return (
    <div aria-busy="true" aria-label="Loading integrations" className="flex flex-col gap-3.5 border-t border-line pt-5">
      <Skeleton className="h-3 w-[110px]" />
      <div className="overflow-hidden rounded-[12px] border border-line bg-surface">
        <div className="flex items-center gap-3 p-3.5">
          <Skeleton className="size-9 rounded-[9px]" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-[150px]" />
            <Skeleton className="h-2.5 w-[190px]" />
          </div>
        </div>
        {[170, 130, 190, 150].map((w) => (
          <div key={w} className="flex h-[38px] items-center gap-2.5 border-t border-line px-3.5">
            <Skeleton className="size-3.5 rounded-[4px]" />
            <Skeleton className="h-2.5" style={{ width: w }} />
            <span className="flex-1" />
            <Skeleton className="h-2.5 w-10" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-2 h-3 w-20" />
      <div className="overflow-hidden rounded-[12px] border border-line bg-surface">
        {[150, 220, 260].map((w) => (
          <div key={w} className="grid h-10 grid-cols-[84px_minmax(0,1fr)] items-center gap-3 border-t border-line px-3.5 first:border-t-0">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-2.5" style={{ width: w }} />
          </div>
        ))}
      </div>
    </div>
  );
}
