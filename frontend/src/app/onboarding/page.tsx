import type { Metadata } from "next";
import { AuthGate } from "@/components/shell/app-shell";
import { Onboarding } from "@/features/onboarding/onboarding";

export const metadata: Metadata = { title: "Set up your workspace" };

export default function OnboardingPage() {
  return (
    <AuthGate>
      <Onboarding />
    </AuthGate>
  );
}
