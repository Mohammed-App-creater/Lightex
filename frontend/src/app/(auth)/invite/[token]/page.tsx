import type { Metadata } from "next";
import { AcceptInvite } from "@/features/auth/accept-invite";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AcceptInvite token={token} />;
}
