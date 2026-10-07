import { validateUpload } from "@/lib/files";
import { attachments } from "./endpoints";
import { ApiError } from "./errors";
import type { Attachment, UploadTicket } from "./types";

/**
 * Upload flow: 1) request a signed URL, 2) PUT the file directly to storage with progress,
 * 3) confirm with the API. Client-side validation runs first (10 MB, images/code/text only);
 * the server validates again when issuing the URL.
 */
export async function uploadAttachment(
  taskId: string,
  file: File,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<Attachment> {
  const problem = validateUpload(file);
  if (problem) throw new ApiError({ code: "validation_failed", message: problem, status: 422 });
  const ticket = await attachments.uploadUrl(taskId, {
    fileName: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
  });
  await putToSignedUrl(ticket, file, onProgress, signal);
  return attachments.confirm(taskId, ticket.uploadId);
}

async function putToSignedUrl(ticket: UploadTicket, file: File, onProgress: (pct: number) => void, signal?: AbortSignal) {
  if (ticket.url.startsWith("mock-upload://")) {
    const { mockUpload } = await import("@/lib/mock/transport");
    return mockUpload(ticket.url, file, onProgress, signal);
  }
  // fetch() has no upload progress; XHR does.
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(ticket.method, ticket.url);
    Object.entries(ticket.headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError({ code: "upload_failed", message: "Upload failed. Try again.", status: xhr.status }));
    xhr.onerror = () => reject(new ApiError({ code: "network_error", message: "Upload interrupted.", status: 0 }));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}
