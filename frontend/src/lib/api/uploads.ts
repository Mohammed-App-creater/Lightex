import { validateUpload } from "@/lib/files";
import { attachments, imports } from "./endpoints";
import { ApiError } from "./errors";
import type { Attachment, ImportJob, ImportSource, UploadTicket } from "./types";

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

/**
 * Board 40 import upload: 1) create the draft job and get a signed URL (I1), 2) PUT the CSV to
 * storage with progress (same path as attachments, including the mock-upload:// branch), 3) ask the
 * server to analyze it (I2). Resolves with the analysed job (`ready`) or rejects with the ApiError
 * (422 `details.file` for analysis errors). The client pre-checks (extension, size, empty) run in the
 * wizard before this is called. `onCreated` hands back the draft so the caller can discard it later.
 */
export async function uploadImportFile(
  projectId: string,
  source: ImportSource,
  file: File,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
  onCreated?: (job: ImportJob) => void,
): Promise<ImportJob> {
  const { job, upload } = await imports.create(projectId, { source, fileName: file.name, size: file.size });
  onCreated?.(job);
  await putToSignedUrl(upload, file, onProgress, signal);
  return imports.analyze(job.id);
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
