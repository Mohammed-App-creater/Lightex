"use client";

/* Last-resort boundary: replaces the root layout, so no providers, fonts or tokens are available. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100dvh", display: "grid", placeItems: "center", background: "#0d1117", color: "#e6edf3", font: "14px/1.5 system-ui, sans-serif" }}>
        <main style={{ textAlign: "center", padding: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>Lightex failed to load</h1>
          <p style={{ margin: "0 0 16px", color: "#9aa4b2" }}>An unexpected error stopped the app. Reloading usually fixes it.</p>
          <button type="button" onClick={reset} style={{ height: 32, padding: "0 14px", borderRadius: 7, border: 0, background: "#5b8cff", color: "#fff", fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
