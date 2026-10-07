"use client";

import { useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Wordmark } from "@/components/brand/logo";
import { ProjectBadge } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/choice";
import { AuthBanner, AuthField, AuthInput } from "@/features/auth/auth-ui";
import { useWorkspaces } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Project, ProjectTemplate, Workspace } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { EmailChips } from "./email-chips";
import {
  chipsError,
  deriveKey,
  inviteCta,
  inviteSummary,
  keyError,
  projectNameError,
  sanitizeKey,
  slugify,
  splitDraft,
  addChips,
  workspaceNameError,
} from "./logic";
import { OnboardingStyles, onboardingStylesClasses as s } from "./onboarding-styles";
import { AuthStyles } from "@/features/auth/auth-styles";
import { TemplatePicker } from "./template-picker";

type Step = 0 | 1 | 2 | 3;
type InviteRole = "member" | "admin";

const STEP_LABELS = ["Workspace", "Project", "Team"];

/**
 * Onboarding (board 23 §3): workspace → first project → invites → "You’re ready".
 * Each entity is created once; going Back shows it read-only and Continue just moves on.
 */
export function Onboarding() {
  const router = useRouter();
  const qc = useQueryClient();
  const mobile = useIsMobile();
  const uid = useId();
  const existing = useWorkspaces();

  const [step, setStep] = useState<Step>(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);

  // Step 1
  const [wsName, setWsName] = useState("");
  const [wsShow, setWsShow] = useState(false);
  const [wsServer, setWsServer] = useState<string | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  // Step 2
  const [projName, setProjName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [template, setTemplate] = useState<ProjectTemplate>("kanban");
  const [projShow, setProjShow] = useState<{ name: boolean; key: boolean }>({ name: false, key: false });
  const [projServer, setProjServer] = useState<{ name?: string; key?: string }>({});
  const [project, setProject] = useState<Project | null>(null);
  // Step 3
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [chipsShow, setChipsShow] = useState(false);
  const [chipsServer, setChipsServer] = useState<string | null>(null);
  const [invited, setInvited] = useState<{ count: number; role: InviteRole } | null>(null);

  const firstField = useRef<HTMLInputElement | null>(null);
  const readyHeading = useRef<HTMLHeadingElement | null>(null);
  const mounted = useRef(false);

  // Focus the step's first field on navigation (not on first paint: autoFocus covers that).
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (step === 3) readyHeading.current?.focus();
    else firstField.current?.focus();
  }, [step]);

  const go = (to: Step) => {
    setDir(to > step ? 1 : -1);
    setAlert(null);
    setStep(to);
  };

  /* ── derived ── */
  const slug = slugify(wsName);
  const wsError = ws ? null : (wsServer ?? workspaceNameError(wsName));
  const effectiveKey = keyEdited ? key : deriveKey(projName);
  const nameErr = project ? null : (projServer.name ?? projectNameError(projName));
  const keyErr = project ? null : (projServer.key ?? keyError(effectiveKey));
  const chipsErr = chipsServer ?? chipsError(chips);

  /* ── step actions ── */
  async function submitWorkspace() {
    if (ws) return go(1);
    setWsShow(true);
    if (wsError) return firstField.current?.focus();
    setBusy(true);
    try {
      const created = await api.workspaces.create({ name: wsName.trim(), slug });
      setWs(created);
      void qc.invalidateQueries({ queryKey: qk.workspaces() });
      go(1);
    } catch (err) {
      if (isApiError(err) && err.status === 422 && (err.fieldErrors.slug || err.fieldErrors.name)) {
        setWsServer(err.fieldErrors.slug ?? err.fieldErrors.name ?? null);
        firstField.current?.focus();
      } else setAlert(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitProject() {
    if (project) return go(2);
    if (!ws) return go(0);
    setProjShow({ name: true, key: true });
    if (nameErr) return firstField.current?.focus();
    if (keyErr) return document.getElementById(`${uid}-key`)?.focus();
    setBusy(true);
    try {
      const created = await api.projects.create(ws.slug, { name: projName.trim(), key: effectiveKey, template });
      setProject(created);
      void qc.invalidateQueries({ queryKey: qk.projects(ws.slug) });
      go(2);
    } catch (err) {
      const f = isApiError(err) && err.status === 422 ? err.fieldErrors : {};
      if (f.name || f.key) {
        setProjServer({ name: f.name, key: f.key });
        if (f.name) firstField.current?.focus();
        else document.getElementById(`${uid}-key`)?.focus();
      } else setAlert(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitInvites() {
    if (invited || !ws) return go(3);
    // Enter / Continue commits the draft first.
    let list = chips;
    if (draft.trim()) {
      list = addChips(chips, splitDraft(draft, true).tokens);
      setChips(list);
      setDraft("");
    }
    if (!list.length) return go(3);
    setChipsShow(true);
    if (chipsError(list)) return firstField.current?.focus();
    setBusy(true);
    try {
      const roles = await api.roles.list(ws.slug, "workspace");
      const r = roles.find((x) => x.scope === "workspace" && x.name.toLowerCase() === role);
      if (!r) throw new Error("Couldn’t find the role for invites. Try again.");
      await api.workspaces.invite(ws.slug, list, r.id);
      void qc.invalidateQueries({ queryKey: qk.invites(ws.slug) });
      setInvited({ count: list.length, role });
      go(3);
    } catch (err) {
      if (isApiError(err) && err.status === 422 && err.fieldErrors.emails) {
        setChipsServer(err.fieldErrors.emails);
        firstField.current?.focus();
      } else setAlert(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (step === 0) void submitWorkspace();
    else if (step === 1) void submitProject();
    else if (step === 2) void submitInvites();
    else openApp();
  };

  const destination = project && ws ? routes.project(ws.slug, project.key, "board") : ws ? routes.home(ws.slug) : existing.data?.length ? "/" : null;
  function openApp() {
    if (destination) router.push(destination);
  }

  function startOver() {
    // Created entities stay created (they exist on the server); only the invite draft resets.
    setChips([]);
    setDraft("");
    setChipsShow(false);
    setChipsServer(null);
    setAlert(null);
    go(0);
  }

  const cta =
    step === 2 && !invited ? inviteCta(chips.length + (draft.trim() ? 1 : 0)) : step === 3 ? (project ? "Open board" : ws ? "Open workspace" : "Open Lightex") : "Continue";

  const busyLabel = step === 0 ? "Creating…" : step === 1 ? "Creating…" : "Sending…";

  return (
    <div className="flex h-dvh flex-col bg-bg">
      <AuthStyles />
      <OnboardingStyles />
      {/* Top bar */}
      <header className="flex h-14 flex-none items-center gap-4 px-5 max-[760px]:h-[52px] max-[760px]:pl-3.5 max-[760px]:pr-2">
        <Wordmark size={17} />
        <span className="flex-1" />
        {step < 3 && (
          <Button variant="ghost" size="sm" onClick={() => go(3)} className="max-[760px]:h-11">
            Skip for now
          </Button>
        )}
      </header>

      <Progress step={step} />

      <form noValidate onSubmit={onSubmit} aria-labelledby={`${uid}-h`} className="flex min-h-0 flex-1 flex-col">
        <main className="flex min-h-0 flex-1 justify-center overflow-y-auto px-6 pb-6 pt-9 max-[760px]:px-4 max-[760px]:py-6">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 16 * dir }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className={cn("flex w-[460px] max-w-full flex-col gap-[18px]", step === 3 && "items-start")}
          >
            {step === 0 && (
              <>
                <StepHeading id={`${uid}-h`}>Create your workspace</StepHeading>
                <div className="flex flex-col gap-2">
                  <AuthField
                    label="Workspace name"
                    error={wsShow ? wsError : null}
                    hint={ws ? "Already created. You can rename it later in Settings." : undefined}
                  >
                    {(a) => (
                      <AuthInput
                        {...a}
                        ref={firstField}
                        autoFocus
                        maxLength={40}
                        placeholder="Platform team"
                        autoComplete="organization"
                        value={ws ? ws.name : wsName}
                        readOnly={Boolean(ws)}
                        onChange={(e) => {
                          setWsName(e.target.value);
                          setWsServer(null);
                        }}
                        onBlur={() => wsName.trim() && setWsShow(true)}
                      />
                    )}
                  </AuthField>
                  <p className="m-0 flex min-w-0 font-mono text-meta font-medium text-fg-3" aria-live="polite">
                    lightex.app/
                    <b className="truncate font-medium text-accent-t">{ws ? ws.slug : slug || "your-team"}</b>
                  </p>
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <StepHeading id={`${uid}-h`}>Create your first project</StepHeading>
                {project && <p className="m-0 -mt-2 text-meta text-fg-3">Already created. You can rename it later in project settings.</p>}
                <div className="grid grid-cols-[1fr_96px] items-start gap-3 max-[760px]:grid-cols-[1fr_84px]">
                  <AuthField label="Project name">
                    {(a) => (
                      <AuthInput
                        {...a}
                        aria-invalid={projShow.name && nameErr ? true : undefined}
                        aria-describedby={projShow.name && nameErr ? `${uid}-perr` : undefined}
                        ref={firstField}
                        autoFocus={false}
                        maxLength={60}
                        placeholder="Platform Rebuild"
                        value={project ? project.name : projName}
                        readOnly={Boolean(project)}
                        onChange={(e) => {
                          setProjName(e.target.value);
                          setProjServer((p) => ({ ...p, name: undefined }));
                        }}
                        onBlur={() => projName.trim() && setProjShow((p) => ({ ...p, name: true }))}
                      />
                    )}
                  </AuthField>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={`${uid}-key`} className="text-[12.5px] font-medium text-fg-2">
                      Key
                    </label>
                    <AuthInput
                      id={`${uid}-key`}
                      mono
                      className="uppercase tracking-[0.04em]"
                      maxLength={5}
                      placeholder="PRJ"
                      autoCapitalize="characters"
                      spellCheck={false}
                      value={project ? project.key : effectiveKey}
                      readOnly={Boolean(project)}
                      aria-invalid={projShow.key && keyErr && !(projShow.name && nameErr) ? true : undefined}
                      aria-describedby={projShow.key && keyErr && !(projShow.name && nameErr) ? `${uid}-kerr` : undefined}
                      onChange={(e) => {
                        setKey(sanitizeKey(e.target.value));
                        setKeyEdited(true);
                        setProjServer((p) => ({ ...p, key: undefined }));
                      }}
                      onBlur={() => effectiveKey && setProjShow((p) => ({ ...p, key: true }))}
                    />
                  </div>
                </div>
                {projShow.name && nameErr ? (
                  <InlineError id={`${uid}-perr`}>{nameErr}</InlineError>
                ) : projShow.key && keyErr ? (
                  <InlineError id={`${uid}-kerr`}>{keyErr}</InlineError>
                ) : null}
                <p className="m-0 -mt-1.5 font-mono text-meta font-medium text-fg-3">
                  Tasks:{" "}
                  <b className="font-medium text-accent-t">
                    {(project?.key ?? effectiveKey) || "KEY"}-1, {(project?.key ?? effectiveKey) || "KEY"}-2…
                  </b>
                </p>
                <TemplatePicker
                  name={`${uid}-tpl`}
                  value={project?.template ?? template}
                  onChange={setTemplate}
                  locked={Boolean(project)}
                />
              </>
            )}

            {step === 2 && (
              <>
                <StepHeading id={`${uid}-h`}>Invite your team</StepHeading>
                {invited && (
                  <p className="m-0 -mt-2 text-meta text-fg-3">
                    Invites sent. You can invite more people from Settings → Members.
                  </p>
                )}
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${uid}-emails`} className="text-[12.5px] font-medium text-fg-2">
                    Emails
                  </label>
                  <EmailChips
                    ref={firstField}
                    id={`${uid}-emails`}
                    chips={chips}
                    draft={draft}
                    readOnly={Boolean(invited)}
                    invalid={Boolean(chipsShow && chipsErr)}
                    describedBy={chipsShow && chipsErr ? `${uid}-cerr` : undefined}
                    onChange={(n) => {
                      setChips(n.chips);
                      setDraft(n.draft);
                      setChipsServer(null);
                      if (n.chips.length !== chips.length) setChipsShow(true);
                    }}
                  />
                  {chipsShow && chipsErr && <InlineError id={`${uid}-cerr`}>{chipsErr}</InlineError>}
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] font-medium text-fg-2">Role</span>
                  <Segmented<InviteRole>
                    label="Role for invites"
                    size="lg"
                    value={invited?.role ?? role}
                    onChange={(v) => !invited && setRole(v)}
                    options={[
                      { value: "member", label: "Member" },
                      { value: "admin", label: "Admin" },
                    ]}
                    className="self-start"
                  />
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <span aria-hidden className={s.ring}>
                  {[
                    [0, -34],
                    [30, -17],
                    [30, 17],
                    [0, 34],
                    [-30, 17],
                    [-30, -17],
                  ].map(([dx, dy], i) => (
                    <span key={i} className={s.spark} style={{ ["--dx" as string]: `${dx}px`, ["--dy" as string]: `${dy}px` }} />
                  ))}
                </span>
                <h2
                  id={`${uid}-h`}
                  ref={readyHeading}
                  tabIndex={-1}
                  role="status"
                  className="m-0 text-h2 outline-none focus-visible:shadow-none max-[760px]:text-[21px] max-[760px]:leading-7"
                >
                  You’re ready
                </h2>
                {(ws || project || invited) && (
                  <dl className="m-0 w-full overflow-hidden rounded-[10px] border border-line bg-surface">
                    {ws && (
                      <SummaryRow label="Workspace">
                        <span className="truncate font-mono text-meta">lightex.app/{ws.slug}</span>
                      </SummaryRow>
                    )}
                    {project && (
                      <SummaryRow label="Project">
                        <ProjectBadge code={project.key} hue={project.hue} size={22} />
                        <span className="truncate">{project.name}</span>
                      </SummaryRow>
                    )}
                    {invited && invited.count > 0 && (
                      <SummaryRow label="Invites">{inviteSummary(invited.count, invited.role)}</SummaryRow>
                    )}
                  </dl>
                )}
                {!ws && !existing.data?.length && (
                  <p className="m-0 text-ui text-fg-2">You’ll need a workspace to start. Use Start over to create one.</p>
                )}
              </>
            )}

            {alert && <AuthBanner title="Something went wrong">{alert}</AuthBanner>}
          </motion.div>
        </main>

        {/* Footer actions */}
        <footer
          className={cn(
            "mx-auto flex w-[508px] max-w-full flex-none items-center gap-2.5 px-6 pb-6 pt-4",
            "max-[760px]:w-full max-[760px]:border-t max-[760px]:border-line max-[760px]:bg-surface max-[760px]:px-4 max-[760px]:pb-6 max-[760px]:pt-3",
          )}
        >
          {(step === 1 || step === 2) && (
            <Button variant="ghost" size="lg" onClick={() => go((step - 1) as Step)} className="max-[760px]:h-11">
              Back
            </Button>
          )}
          {step === 3 && (
            <Button variant="ghost" size="lg" onClick={startOver} className="max-[760px]:h-11">
              Start over
            </Button>
          )}
          <span className="flex-1 max-[760px]:hidden" />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            kbd={mobile || busy ? undefined : "↵"}
            disabledReason={step === 3 && !destination ? "Create a workspace first" : undefined}
            className="max-[760px]:h-11 max-[760px]:flex-1"
          >
            {busy ? busyLabel : cta}
          </Button>
        </footer>
      </form>
    </div>
  );
}

function StepHeading({ id, children }: { id: string; children: string }) {
  return (
    <h1 id={id} className="m-0 text-h2 max-[760px]:text-[21px] max-[760px]:leading-7">
      {children}
    </h1>
  );
}

function InlineError({ id, children }: { id: string; children: string }) {
  return (
    <span id={id} role="alert" className="-mt-2 flex items-start gap-1.5 text-meta text-danger">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden className="mt-0.5 flex-none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.75v3.75" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="11" r=".9" fill="currentColor" />
      </svg>
      {children}
    </span>
  );
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-[42px] items-center gap-2.5 border-b border-line px-3.5 text-ui last:border-b-0">
      <dt className="w-[84px] flex-none text-fg-3">{label}</dt>
      <dd className="m-0 flex min-w-0 items-center gap-2 text-fg">{children}</dd>
    </div>
  );
}

function Progress({ step }: { step: Step }) {
  const fin = step === 3;
  return (
    <div
      role="progressbar"
      aria-label="Setup progress"
      aria-valuemin={0}
      aria-valuemax={3}
      aria-valuenow={step}
      aria-valuetext={fin ? "Setup complete" : `Step ${step + 1} of 3`}
      className="mx-auto mt-2 grid w-[420px] max-w-[calc(100%-32px)] flex-none grid-cols-3 gap-2 max-[760px]:mx-4 max-[760px]:w-auto max-[760px]:max-w-none"
    >
      {STEP_LABELS.map((label, i) => {
        const done = fin || i < step;
        const current = i === step;
        return (
          <div key={label} className="flex flex-col gap-2">
            <span className="h-1 overflow-hidden rounded-[2px] bg-line-2">
              <span
                className="block h-full rounded-[2px] transition-[width,background-color] duration-300 ease-out"
                style={{ width: done ? "100%" : current ? "45%" : "0%", background: fin ? "var(--ok)" : "var(--accent)" }}
              />
            </span>
            <span
              className={cn(
                "flex items-center gap-1.5 text-meta font-medium",
                current ? "text-fg" : done ? "text-fg-2" : "text-fg-3",
              )}
            >
              {done ? (
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden className="text-ok">
                  <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <span className="font-mono text-[11px] font-semibold">{i + 1}</span>
              )}
              <span className="max-[760px]:sr-only">{label}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
