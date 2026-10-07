import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Lightex", template: "%s · Lightex" },
  description: "Project management for software teams. Fast, quiet, keyboard-first.",
  applicationName: "Lightex",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#060B18" },
    { media: "(prefers-color-scheme: light)", color: "#FAFAFB" },
  ],
  colorScheme: "dark light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // next-themes writes data-theme before paint; suppressHydrationWarning covers that attribute.
    <html lang="en" data-theme="dark" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
