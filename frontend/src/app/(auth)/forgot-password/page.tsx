import type { Metadata } from "next";
import { ForgotForm } from "@/platform/auth/forgot-form";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return <ForgotForm />;
}
