import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";
// Origin of signed upload URLs (object storage), e.g. https://uploads.example.com
const uploadOrigin = process.env.NEXT_PUBLIC_UPLOAD_ORIGIN ?? "";

// Strict CSP: no third-party scripts. 'unsafe-inline' for scripts is required by the
// next-themes no-flash script; styles need it for Motion's inline transforms.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self' blob: ${apiUrl} ${uploadOrigin} ${isDev ? "ws:" : ""}`.replace(/\s+/g, " ").trim(),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  // Cache Components / Partial Prefetching are deliberately off: the app is client-rendered
  // against an API (mock or live) from the browser, and Activity-based route preservation
  // would keep transient overlays and global shortcut listeners alive on hidden routes.
  // See docs/frontend-plan.md §1 and the final report.
  cacheComponents: false,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
