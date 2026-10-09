import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
// CSP sources are origins only: drop any path or trailing slash ("https://x.com/" -> "https://x.com").
const toOrigin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};
const apiOrigin = process.env.NEXT_PUBLIC_API_URL ? toOrigin(process.env.NEXT_PUBLIC_API_URL) : "";
// Origins of signed upload/download URLs (object storage, e.g. Cloudflare R2), comma or space separated.
// R2 presigns on https://<account>.r2.cloudflarestorage.com (path style) or
// https://<bucket>.<account>.r2.cloudflarestorage.com (virtual-host style), so list both.
const uploadOrigins = (process.env.NEXT_PUBLIC_UPLOAD_ORIGIN ?? "").split(/[\s,]+/).filter(Boolean).map(toOrigin);
// The backend serves signed URLs itself when STORAGE_BACKEND=local, and R2 serves them otherwise:
// both must be allowed for uploads (connect-src) and image previews (img-src).
const remoteSources = [apiOrigin, ...uploadOrigins].filter(Boolean).join(" ");

// Strict CSP: no third-party scripts. 'unsafe-inline' for scripts is required by the
// next-themes no-flash script; styles need it for Motion's inline transforms.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' blob: data: ${remoteSources}`.trim(),
  "font-src 'self'",
  `connect-src 'self' blob: ${remoteSources} ${isDev ? "ws:" : ""}`.replace(/\s+/g, " ").trim(),
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
  // React Compiler: automatic memoization, so board/list/sidebar re-render only what changed.
  // The Rust port runs inside Turbopack, so no Babel plugin dependency is needed.
  reactCompiler: true,
  experimental: {
    turbopackRustReactCompiler: true,
    // Every page is a thin client component rendered from React Query, so its RSC payload never
    // carries data. Keeping it in the client router cache makes repeat tab switches instant.
    staleTimes: { dynamic: 300 },
  },
  turbopack: {
    // A stray package-lock.json in the user's home directory confuses root detection.
    root: process.cwd(),
    rules: {
      "*.css": {
        // Only our own CSS. Without this the loader also runs on Next internals such as the
        // virtual next/font stylesheets, which breaks `next build` on Linux CI
        // ("next/font/google queries have exactly one entry").
        condition: { not: "foreign" },
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
      // Board 38: the push service worker (public/sw.js). After the /:path* rule, so it wins for the same keys.
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
