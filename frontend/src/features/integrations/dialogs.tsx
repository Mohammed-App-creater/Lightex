"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { FilterPills } from "@/components/ui/tabs";
import { isApiError } from "@/lib/api/errors";
import type { Integration, Provider, ProviderInfo } from "@/lib/api/types";
import { DEV_ICON, DevGlyph, ProviderLogo } from "./icons";
import { PROVIDER_NAME } from "./lib/dev-lib";

/** 422 `details.fields` → { field: message }. */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!isApiError(e) || e.code !== "validation_failed") return {};
  return ((e.details as { fields?: Record<string, string> } | undefined)?.fields ?? {}) as Record<string, string>;
}

/**
 * "Connect GitLab" (§11 #9): GitLab.com (OAuth; hidden when the server has no OAuth app) or an access
 * token for gitlab.com or a self-managed instance. Field errors come from the 422; 409
 * integration_exists offers Reconnect instead.
 */
export function GitLabConnectDialog({
  info,
  onClose,
  onOAuth,
  onToken,
  onReconnectExisting,
}: {
  info: ProviderInfo;
  onClose: () => void;
  onOAuth: () => Promise<void>;
  onToken: (baseUrl: string, token: string) => Promise<void>;
  onReconnectExisting: (integrationId: string) => void;
}) {
  const oauth = info.methods.includes("oauth");
  const [mode, setMode] = useState<"oauth" | "token">(oauth ? "oauth" : "token");
  const [baseUrl, setBaseUrl] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exists, setExists] = useState<string | null>(null);
  const [general, setGeneral] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setExists(null);
    setGeneral(null);
    try {
      if (mode === "oauth") await onOAuth();
      else await onToken(baseUrl.trim(), token.trim());
    } catch (e) {
      const f = fieldErrors(e);
      if (Object.keys(f).length) setErrors(f);
      else if (isApiError(e) && e.code === "integration_exists") setExists(String((e.details as { integrationId?: string } | undefined)?.integrationId ?? ""));
      else setGeneral(isApiError(e) ? e.message : "Couldn’t connect GitLab.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Connect GitLab"
      description={mode === "oauth" ? "Sign in on GitLab.com and allow Lightex." : "Paste a group or project access token. Self-managed GitLab works too."}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()} disabledReason={mode === "token" && !token.trim() ? "Paste a token first" : undefined}>
            {mode === "oauth" ? "Continue to GitLab" : "Connect"}
          </Button>
        </>
      }
    >
      {oauth && (
        <FilterPills
          label="How to connect"
          value={mode}
          onChange={setMode}
          items={[
            { value: "oauth", label: "GitLab.com" },
            { value: "token", label: "Access token" },
          ]}
          className="self-start"
        />
      )}
      {mode === "token" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void submit();
          }}
        >
          <Field label="Instance URL" error={errors.baseUrl} hint="gitlab.com or your self-managed address (https only).">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} mono inputMode="url" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Access token" error={errors.token} hint="Group access token (preferred) or project token · role Maintainer · scope api · with an expiry date.">
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" mono autoComplete="off" spellCheck={false} placeholder="glpat-…" />
          </Field>
          <button type="submit" hidden />
        </form>
      ) : (
        <p className="m-0 flex items-center gap-2.5 rounded-md border border-line bg-bg px-3 py-2.5 text-[12.5px] text-fg-2">
          <ProviderLogo provider="gitlab" small />
          You’ll grant the <code className="font-mono text-fg">api</code> scope on {info.oauthBaseUrl?.replace("https://", "") ?? "gitlab.com"}.
        </p>
      )}
      {exists !== null && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-line-2 bg-raised px-3 py-2 text-[12.5px] text-fg-2">
          <span className="flex-1">This GitLab account is already connected.</span>
          <Button size="sm" onClick={() => exists && onReconnectExisting(exists)}>
            Reconnect
          </Button>
        </div>
      )}
      {general && (
        <p role="alert" className="m-0 text-[12px] text-danger">
          {general}
        </p>
      )}
    </Modal>
  );
}

/** GitLab token mode reconnect (G12 with `{ token }`). */
export function ReconnectTokenDialog({ integration, onClose, onSubmit }: { integration: Integration; onClose: () => void; onSubmit: (token: string) => Promise<void> }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(token.trim());
    } catch (e) {
      setError(fieldErrors(e).token ?? (isApiError(e) ? e.message : "Couldn’t reconnect."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Reconnect GitLab"
      description={`Paste a new token for ${integration.account.login} on ${integration.baseUrl.replace("https://", "")}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabledReason={!token.trim() ? "Paste a token first" : undefined} onClick={() => void submit()}>
            Reconnect
          </Button>
        </>
      }
    >
      <Field label="Access token" error={error}>
        <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" mono autoComplete="off" placeholder="glpat-…" />
      </Field>
    </Modal>
  );
}

/** The design's alertdialog, copy unchanged; Cancel is focused first, Esc closes. */
export function DisconnectDialog({ provider, onCancel, onConfirm }: { provider: Provider; onCancel: () => void; onConfirm: () => void }) {
  const name = PROVIDER_NAME[provider];
  return (
    <Modal
      open
      role="alertdialog"
      onOpenChange={(o) => !o && onCancel()}
      title={`Disconnect ${name}?`}
      description="Linked PRs stay on tasks. Syncing stops."
      footer={
        <>
          <Button variant="ghost" autoFocus onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Disconnect
          </Button>
        </>
      }
    />
  );
}

/** Permission chips shown on the fake consent page: the real ones from §2.1 / §2.2. */
const CONSENT_CHIPS: Record<Provider, string[]> = {
  github: ["contents: write", "pull_requests: read", "checks: read", "statuses: read", "metadata: read"],
  gitlab: ["api"],
};

/**
 * Mock mode only: the design's "Authorize Lightex" dialog stands in for the provider's consent page
 * (§9.6 #4, §11 #2). Authorize / Cancel answer with the same fragment the real callback would.
 */
export function MockAuthorizeDialog({ provider, onAuthorize, onCancel }: { provider: Provider; onAuthorize: () => void; onCancel: () => void }) {
  const name = PROVIDER_NAME[provider];
  return (
    <Modal open onOpenChange={(o) => !o && onCancel()} title={<span className="font-mono text-[12px] font-medium text-fg-3">{name} · authorize</span>} width={320}>
      <div className="flex flex-col">
        <div className="flex flex-col items-center gap-3.5 text-center">
          <div className="flex items-center gap-2.5" aria-hidden>
            <span className="inline-flex size-9 items-center justify-center rounded-[9px] border border-line-2 bg-raised font-mono text-[12px] font-semibold text-fg">Lx</span>
            <span className="ig-dots flex gap-1">
              <i />
              <i />
              <i />
            </span>
            <ProviderLogo provider={provider} />
          </div>
          <b className="text-[15px] font-semibold">Authorize Lightex</b>
          <div className="flex flex-wrap justify-center gap-1.5">
            {CONSENT_CHIPS[provider].map((c) => (
              <span key={c} className="inline-flex h-[22px] items-center rounded-[6px] border border-line bg-raised px-2 font-mono text-[11.5px] text-fg-2">
                {c}
              </span>
            ))}
          </div>
          <p className="m-0 flex items-center gap-1.5 text-[11.5px] text-fg-3">
            <DevGlyph d={DEV_ICON.lock} size={12} />
            Simulated provider (mock mode)
          </p>
          <div className="flex w-full gap-2">
            <Button variant="ghost" className="flex-1" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" className="flex-1" onClick={onAuthorize}>
              Authorize
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
