import type { MetadataRoute } from "next";

/* Web app manifest (board 35): SVG favicon for any size, 512 PNG, and a maskable 512 PNG. */

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lightex",
    short_name: "Lightex",
    description: "Project management for software teams. Fast, quiet, keyboard-first.",
    start_url: "/",
    display: "standalone",
    background_color: "#060B18",
    theme_color: "#060B18",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
