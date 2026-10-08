"use client";

import { Check, Eye, EyeOff, Lock, Upload } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { initialsOf } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useMe, useSession } from "@/features/auth/session";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils/cn";
import { avatarFileError, newPasswordError, passwordScore, profileNameError, STRENGTH } from "./lib";
import { SaveBar, type SaveState } from "./save-bar";
import { SettingsPage, SettingsSection } from "./settings-shell";
import { useLeaveGuard } from "./use-leave-guard";

/** Profile (board 20 B.3): avatar, identity, password, theme. */
export function ProfileScreen() {
  return (
    <SettingsPage title="Profile">
      <AvatarSection />
      <IdentitySection />
      <PasswordSection />
      <ThemeSection />
    </SettingsPage>
  );
}

function UserAvatar({ name, hue, url, size }: { name: string; hue: number; url: string | null; size: number }) {
  return (
    <span
      className="inline-flex flex-none items-center justify-center overflow-hidden rounded-full font-semibold text-fg shadow-[0_0_0_1px_var(--line-2)]"
      style={{ width: size, height: size, background: url ? undefined : `oklch(var(--av-l) var(--av-c) ${hue})`, fontSize: size * 0.34 }}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- data URLs / user uploads, no optimisation
        <img src={url} alt="" className="size-full object-cover" />
      ) : (
        <span aria-hidden>{initialsOf(name)}</span>
      )}
    </span>
  );
}

function AvatarSection() {
  const me = useMe();
  const { setUser } = useSession();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const pick = (file: File | undefined) => {
    if (!file) return;
    const err = avatarFileError(file);
    setError(err);
    if (err) return;
    const reader = new FileReader();
    reader.onload = () => setPreview(String(reader.result));
    reader.readAsDataURL(file);
  };

  const apply = async (avatarUrl: string | null) => {
    setBusy(true);
    try {
      const u = await api.auth.updateMe({ avatarUrl });
      setUser(u);
      setOpen(false);
      setPreview(null);
      toast.success(avatarUrl ? "Photo updated" : "Photo removed");
    } catch (e) {
      toast.error("Couldn’t update photo", { body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Avatar">
      <div className="flex flex-wrap items-center gap-3">
        <UserAvatar name={me.name} hue={me.hue} url={me.avatarUrl} size={64} />
        <Button variant="secondary" size="sm" aria-expanded={open} aria-controls="avatar-upload" onClick={() => setOpen((o) => !o)}>
          {me.avatarUrl ? "Change" : "Upload"}
        </Button>
        {me.avatarUrl && (
          <Button variant="ghost" size="sm" loading={busy && !preview} onClick={() => void apply(null)}>
            Remove
          </Button>
        )}
      </div>
      {open && (
        <div
          id="avatar-upload"
          className="grid animate-[fade-in_180ms_var(--ease)] grid-cols-[minmax(0,1fr)_auto] gap-3.5 rounded-[10px] border border-line bg-surface p-3.5 max-[760px]:grid-cols-1"
        >
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              pick(e.dataTransfer.files[0]);
            }}
            className={cn(
              "relative flex min-h-[104px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border-[1.5px] border-dashed border-line-2 p-3 text-fg-2 transition-colors hover:border-control",
              "focus-within:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--ring)]",
              over && "border-accent bg-accent-s",
            )}
          >
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-describedby="avatar-hint"
              onChange={(e) => pick(e.target.files?.[0])}
            />
            <Upload size={20} aria-hidden />
            <span className="font-medium text-fg">Drop image or browse</span>
            <span id="avatar-hint" className="font-mono text-[11px] text-fg-3">
              PNG · JPG · WebP · 2 MB
            </span>
          </label>
          <div className="flex flex-col justify-between gap-3">
            <div className="flex items-end gap-3 px-1" aria-label="Preview" role="group">
              {[64, 32, 20].map((s) =>
                preview ? (
                  <UserAvatar key={s} name={me.name} hue={me.hue} url={preview} size={s} />
                ) : (
                  <span
                    key={s}
                    aria-hidden
                    className="rounded-full shadow-[0_0_0_1px_var(--line-2)]"
                    style={{
                      width: s,
                      height: s,
                      background: "repeating-linear-gradient(135deg, var(--raised) 0 5px, var(--surface) 5px 10px)",
                    }}
                  />
                ),
              )}
            </div>
            <div className="flex justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setPreview(null);
                  setError(null);
                }}
              >
                Cancel
              </Button>
              {preview && (
                <Button variant="secondary" size="sm" loading={busy} onClick={() => void apply(preview)}>
                  Use photo
                </Button>
              )}
            </div>
          </div>
          {error && (
            <p role="alert" className="col-span-full m-0 text-[12px] text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

function IdentitySection() {
  const me = useMe();
  const { setUser } = useSession();
  const [name, setName] = useState(me.name);
  const [phase, setPhase] = useState<"edit" | "saving" | "error" | "saved">("edit");
  const [shake, setShake] = useState(0);
  const err = profileNameError(name);
  const dirty = name !== me.name;
  useLeaveGuard(dirty && phase !== "saving", () => setShake((s) => s + 1));
  useEffect(() => {
    if (phase !== "saved") return;
    const t = setTimeout(() => setPhase("edit"), 2200);
    return () => clearTimeout(t);
  }, [phase]);

  const save = async () => {
    if (!dirty || err) return;
    setPhase("saving");
    try {
      const u = await api.auth.updateMe({ name: name.trim() });
      setUser(u);
      setName(u.name);
      setPhase("saved");
    } catch {
      setPhase("error");
    }
  };

  let state: SaveState = "idle";
  if (phase === "saving") state = "saving";
  else if (phase === "error") state = "error";
  else if (phase === "saved") state = "saved";
  else if (dirty) state = err ? "invalid" : "dirty";

  return (
    <>
      <SettingsSection title="Identity">
        <div className="grid grid-cols-2 gap-3.5 max-[760px]:grid-cols-1">
          <Field label="Name" error={err}>
            <Input value={name} autoComplete="name" onChange={(e) => setName(e.target.value.slice(0, 60))} />
          </Field>
          <Field label="Email" hint="Used to sign in · can’t be changed here">
            <Input value={me.email} readOnly trailing={<Lock size={14} className="text-fg-3" aria-hidden />} />
          </Field>
        </div>
      </SettingsSection>
      <SaveBar
        state={state}
        shake={shake}
        onSave={() => void save()}
        onDiscard={() => {
          setName(me.name);
          setPhase("edit");
        }}
        className="order-last"
      />
    </>
  );
}

function PasswordSection() {
  const me = useMe();
  const { setUser } = useSession();
  // Accounts made with Google sign-in have no password yet: they set one without a current password.
  const hasPassword = me.hasPassword !== false;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [serverErr, setServerErr] = useState<{ current?: string; next?: string }>({});
  const doneTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(doneTimer.current), []);

  const score = passwordScore(next);
  const currentErr = serverErr.current ?? (hasPassword && submitted && !current ? "Required" : null);
  const nextErr = serverErr.next ?? newPasswordError(next, current, submitted);
  const confirmErr = confirm && confirm !== next ? "Doesn’t match" : submitted && !confirm ? "Required" : null;
  const matches = Boolean(confirm) && confirm === next;

  const submit = async () => {
    setSubmitted(true);
    setServerErr({});
    if ((hasPassword && !current) || !next || !confirm || newPasswordError(next, current, true) || confirm !== next) return;
    setBusy(true);
    try {
      await api.auth.changePassword(current, next);
      if (!hasPassword) setUser({ ...me, hasPassword: true });
      setCurrent("");
      setNext("");
      setConfirm("");
      setSubmitted(false);
      setDone(true);
      clearTimeout(doneTimer.current);
      doneTimer.current = setTimeout(() => setDone(false), 3400);
    } catch (e) {
      if (isApiError(e) && (e.fieldErrors.currentPassword || e.fieldErrors.newPassword)) {
        setServerErr({ current: e.fieldErrors.currentPassword, next: e.fieldErrors.newPassword });
      } else toast.error(hasPassword ? "Couldn’t update password" : "Couldn’t set password", { body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Password"
      description={hasPassword ? undefined : "You sign in with Google. Set a password to also sign in with your email."}
    >
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* Hidden username helps password managers pair the fields. */}
        <input type="text" autoComplete="username" hidden readOnly />
        {hasPassword && (
          <Field label="Current" error={currentErr} className="max-w-[272px] max-[760px]:max-w-none">
            <Input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value);
                setServerErr((s) => ({ ...s, current: undefined }));
              }}
            />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3.5 max-[760px]:grid-cols-1">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pw-new" className="text-meta font-medium text-fg-2">
              New
            </label>
            <Input
              id="pw-new"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              value={next}
              aria-invalid={nextErr ? true : undefined}
              aria-describedby="pw-new-help"
              onChange={(e) => {
                setNext(e.target.value);
                setServerErr((s) => ({ ...s, next: undefined }));
              }}
              trailing={
                <button
                  type="button"
                  aria-label={show ? "Hide password" : "Show password"}
                  aria-pressed={show}
                  onClick={() => setShow((v) => !v)}
                  className="flex size-7 items-center justify-center rounded-[5px] text-fg-3 hover:bg-hover hover:text-fg"
                >
                  {show ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                </button>
              }
            />
            <div className="flex items-center gap-2" aria-hidden={score === 0}>
              <div className="grid flex-1 grid-cols-4 gap-1">
                {[1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className="h-1 rounded-[2px] transition-colors duration-200"
                    style={{ background: score >= i && score > 0 ? STRENGTH[score as 1 | 2 | 3 | 4].color : "var(--raised)" }}
                  />
                ))}
              </div>
              <span
                className="min-w-[52px] text-right font-mono text-[11px] font-medium"
                style={{ color: score ? STRENGTH[score as 1 | 2 | 3 | 4].color : undefined }}
              >
                {score ? STRENGTH[score as 1 | 2 | 3 | 4].label : ""}
              </span>
            </div>
            <span id="pw-new-help" role={nextErr ? "alert" : undefined} className={cn("min-h-4 text-[12px] leading-4", nextErr ? "text-danger" : "text-fg-3")}>
              {nextErr ?? (next ? "" : "8+ characters, mix case, digits and a symbol")}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pw-confirm" className="text-meta font-medium text-fg-2">
              Confirm
            </label>
            <Input
              id="pw-confirm"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              value={confirm}
              aria-invalid={confirmErr ? true : undefined}
              aria-describedby="pw-confirm-help"
              onChange={(e) => setConfirm(e.target.value)}
            />
            <span
              id="pw-confirm-help"
              className={cn("mt-3.5 min-h-4 text-[12px] leading-4", confirmErr ? "text-danger" : matches ? "text-ok" : "text-fg-3")}
            >
              {confirmErr ?? (matches ? "✓ Matches" : "")}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="secondary" size="sm" loading={busy}>
            {hasPassword ? "Update password" : "Set password"}
          </Button>
          {done && (
            <span role="status" className="inline-flex animate-[fade-in_160ms_var(--ease)] items-center gap-1.5 text-[12px] font-medium text-ok">
              <Check size={13} aria-hidden /> {hasPassword ? "Password updated" : "Password set"}
            </span>
          )}
        </div>
      </form>
    </SettingsSection>
  );
}

const THEME_TILES: { value: string; label: string; preview: string }[] = [
  { value: "dark", label: "Navy", preview: "dark" },
  { value: "black", label: "Near-black", preview: "black" },
  { value: "light", label: "Light", preview: "light" },
  { value: "system", label: "System", preview: "light" },
];

const noop = () => () => {};

function ThemeSection() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const current = mounted ? (theme ?? "dark") : null;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusIdx = Math.max(0, THEME_TILES.findIndex((x) => x.value === current));
  const move = (i: number) => {
    const n = THEME_TILES.length;
    const j = (i + n) % n;
    refs.current[j]?.focus();
    setTheme(THEME_TILES[j]!.value);
  };
  return (
    <SettingsSection title="Theme">
      <div role="radiogroup" aria-label="Theme" className="grid max-w-[600px] grid-cols-4 gap-3 max-[760px]:grid-cols-2">
        {THEME_TILES.map((t, i) => {
          const on = current === t.value;
          return (
            <button
              key={t.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={i === focusIdx ? 0 : -1}
              onClick={() => setTheme(t.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  move(i + 1);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(i - 1);
                }
              }}
              className={cn(
                "flex flex-col gap-2 rounded-[10px] border border-line bg-surface p-1.5 text-left text-[12.5px] font-medium",
                "transition-[border-color,transform,box-shadow] duration-[var(--dur-base)] ease-[var(--spring)] hover:-translate-y-px hover:border-control",
                on && "border-accent shadow-[0_0_0_3px_var(--accent-s)] hover:border-accent",
              )}
            >
              <ThemePreview theme={t.preview} split={t.value === "system"} />
              <span className="flex items-center justify-between px-1 pb-1 pt-0.5">
                {t.label}
                {on && <Check size={14} className="text-accent-t" aria-hidden />}
              </span>
            </button>
          );
        })}
      </div>
    </SettingsSection>
  );
}

function MiniUI({ theme, className }: { theme: string; className?: string }): ReactNode {
  return (
    <span data-theme={theme} className={cn("absolute inset-0 block bg-bg", className)}>
      <span className="absolute inset-y-0 left-0 block w-[28%] border-r border-line bg-surface" />
      <span className="absolute left-[6%] top-3 block h-1 w-[14%] rounded-full bg-line-2" />
      <span className="absolute left-[6%] top-[22px] block h-1 w-[12%] rounded-full bg-line-2" />
      <span className="absolute left-[36%] top-3 block h-1.5 w-[40%] rounded-full bg-fg-2 opacity-70" />
      <span className="absolute left-[36%] top-[26px] block h-[5px] w-[54%] rounded-full bg-raised" />
      <span className="absolute left-[36%] top-[37px] block h-[5px] w-[46%] rounded-full bg-raised" />
      <span className="absolute bottom-[9px] left-[36%] block h-2 w-[18%] rounded-[3px] bg-accent" />
    </span>
  );
}

function ThemePreview({ theme, split }: { theme: string; split?: boolean }) {
  return (
    <span aria-hidden className="relative block h-16 overflow-hidden rounded-sm border border-line">
      <MiniUI theme={theme} />
      {split && <MiniUI theme="dark" className="[clip-path:polygon(100%_0,100%_100%,0_100%)]" />}
    </span>
  );
}
