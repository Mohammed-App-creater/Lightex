import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetForm } from "@/features/auth/reset-form";

export const metadata: Metadata = { title: "Set a new password" };

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
