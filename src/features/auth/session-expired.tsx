"use client";

import { Clock } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { useSession } from "./session";

/**
 * Session expired (board 23 §2.5): re-auth without leaving the page, so drafts survive.
 * Shown when a 401 could not be fixed by a refresh.
 */
export function SessionExpiredModal() {
  const { expired, user, signedIn, signOut } = useSession();
  const [password, setPassword] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  if (!expired || !user) return null;

  const error = !tried ? null : !password ? "Enter your password" : password.length < 8 ? "At least 8 characters" : serverError;

  return (
    <Modal open onOpenChange={() => undefined} title="Session expired" description="Your unsaved edits are kept." width={360}>
      <form
        className="flex flex-col gap-3.5"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          setServerError(null);
          if (!password || password.length < 8) return;
          setBusy(true);
          try {
            const res = await api.auth.login(user.email, password);
            signedIn(res);
            setPassword("");
            setTried(false);
            toast.success("Signed in · draft restored");
          } catch (err) {
            setServerError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <span aria-hidden className="absolute right-6 top-6 flex size-9 items-center justify-center rounded-[9px] bg-raised text-fg-2">
          <Clock size={16} />
        </span>
        <Field label="Email">
          <Input value={user.email} readOnly />
        </Field>
        <Field label="Password" error={error}>
          <Input
            type="password"
            autoComplete="current-password"
            autoFocus
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
          <Button type="submit" variant="primary" kbd="↵" loading={busy}>
            {busy ? "Signing in" : "Sign in again"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
