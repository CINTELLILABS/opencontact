import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname } from "node:path";
import type { ImsgAttachment } from "./imsg.ts";

/** An inbound image the brain may look at. */
export interface InboundImage {
  path: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  bytes: number;
}

const MIME_BY_EXT: Record<string, InboundImage["mimeType"]> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function expandHome(p: string): string {
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}

/**
 * The images among a message's attachments that a vision model can take:
 * JPEG, PNG, GIF, WebP, present on disk, under the size cap. HEIC (what
 * iPhones shoot by default) is skipped; Messages usually converts it on the
 * way in, and when it does not, the brain is told an image arrived.
 */
export function pickImages(
  attachments: ReadonlyArray<ImsgAttachment> | undefined,
  opts: { max?: number; maxBytes?: number; exists?: (p: string) => boolean; size?: (p: string) => number } = {},
): InboundImage[] {
  const max = opts.max ?? MAX_IMAGES;
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const exists = opts.exists ?? existsSync;
  const size = opts.size ?? ((p: string) => statSync(p).size);
  const out: InboundImage[] = [];
  for (const a of attachments ?? []) {
    if (out.length >= max) break;
    if (a.missing === true || a.is_sticker === true) continue;
    const raw =
      typeof a.filename === "string" ? a.filename : typeof a.original_path === "string" ? a.original_path : "";
    if (!raw) continue;
    const path = expandHome(raw);
    const mime =
      (typeof a.mime_type === "string" && a.mime_type.startsWith("image/") ? a.mime_type : "") ||
      MIME_BY_EXT[extname(path).toLowerCase()] ||
      "";
    const mimeType = (Object.values(MIME_BY_EXT) as string[]).includes(mime)
      ? (mime as InboundImage["mimeType"])
      : null;
    if (!mimeType) continue;
    if (!exists(path)) continue;
    const bytes = typeof a.total_bytes === "number" ? a.total_bytes : size(path);
    if (bytes > maxBytes) continue;
    out.push({ path, mimeType, bytes });
  }
  return out;
}

export function imageBase64(img: InboundImage): string {
  return readFileSync(img.path).toString("base64");
}
