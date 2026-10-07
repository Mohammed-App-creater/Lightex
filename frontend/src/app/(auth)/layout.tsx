import type { ReactNode } from "react";
import { AuthFlowProvider } from "@/features/auth/auth-flow";

/** Auth screens (board 21): centred card on the grid-and-bolt backdrop. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthFlowProvider>{children}</AuthFlowProvider>;
}
