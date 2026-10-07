/*
 * Upload rules (brief + board 14): 10 MB max, images and common code/text files only.
 * Shared by client-side validation and the mock backend's server-side check.
 * Rendering rule: only raster images are ever shown inline. SVG and HTML uploads are allowed
 * as files but are download-only; code files are download-only (preview text is drawn as
 * plain text, never as markup).
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_DROP = 10;

export const RASTER_IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp"] as const;
export const IMAGE_EXT = [...RASTER_IMAGE_EXT, "svg"] as const;
export const CODE_EXT = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "swift", "rb", "php", "c", "h", "cpp", "cs",
  "json", "yml", "yaml", "toml", "xml", "md", "sql", "sh", "css", "scss", "html", "txt", "diff", "patch", "log", "csv",
] as const;

export const ACCEPT_ATTR = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", ...CODE_EXT.map((e) => `.${e}`)].join(",");

export function extOf(name: string) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1]!.toLowerCase() : "";
}

export function isRasterImage(name: string, mime?: string) {
  const ext = extOf(name);
  if (!(RASTER_IMAGE_EXT as readonly string[]).includes(ext)) return false;
  return !mime || /^image\/(png|jpe?g|gif|webp)$/.test(mime);
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Returns the design's error copy, or null when the file is acceptable. */
export function validateUpload(file: { name: string; size: number; type?: string }): string | null {
  const ext = extOf(file.name);
  const allowed = (IMAGE_EXT as readonly string[]).includes(ext) || (CODE_EXT as readonly string[]).includes(ext);
  if (!file.name || !allowed) return "Images or code files only";
  // A mismatched MIME claiming to be an image is rejected (e.g. "pic.png" served as text/html).
  if (file.type && /^image\//.test(file.type) && !(IMAGE_EXT as readonly string[]).includes(ext)) return "Images or code files only";
  if (file.type && file.type.includes("html") && ext !== "html") return "Images or code files only";
  if (file.size > MAX_UPLOAD_BYTES) return `Too large · ${(file.size / (1024 * 1024)).toFixed(1)} MB (max 10)`;
  return null;
}
