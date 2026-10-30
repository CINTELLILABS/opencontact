import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_IMAGE_BYTES = 1_000_000;
const MAX_PAGE_BYTES = 8_000_000;
const TIMEOUT_MS = 8_000;
// Many sites turn away a bare HTTP client; this is the owner's own Mac fetching the owner's own site.
const HEADERS = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) opencontact", accept: "*/*" };

/** Icon candidates from a page, best first: Apple touch icons are square and large, which is what a contact photo wants. */
export function logoCandidates(html: string, pageUrl: string): string[] {
  const found: Array<{ href: string; rank: number }> = [];
  for (const tag of html.match(/<(link|meta)\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
    const rel = attr("rel")?.toLowerCase() ?? "";
    const prop = (attr("property") ?? attr("name") ?? "").toLowerCase();
    if (rel.includes("apple-touch-icon")) {
      // The biggest one first: 180px beats 152px.
      const size = Number(attr("sizes")?.match(/\d+/)?.[0] ?? 180);
      found.push({ href: attr("href") ?? "", rank: -size / 1000 });
    } else if (rel.split(/\s+/).includes("icon") && /\.(png|jpe?g)(\?|$)/i.test(attr("href") ?? ""))
      found.push({ href: attr("href") ?? "", rank: 2 });
    else if (prop === "og:image") found.push({ href: attr("content") ?? "", rank: 3 });
  }
  found.push({ href: "/apple-touch-icon.png", rank: 1 });
  const urls: string[] = [];
  for (const { href } of found.filter((f) => f.href).sort((a, b) => a.rank - b.rank)) {
    try {
      const u = new URL(href, pageUrl);
      if ((u.protocol === "https:" || u.protocol === "http:") && !urls.includes(u.href)) urls.push(u.href);
    } catch {}
  }
  return urls;
}

/** PNG or JPEG by magic bytes; the vCard photo supports nothing else. */
export function imageKind(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

async function get(fetchImpl: typeof fetch, url: string, max: number): Promise<Uint8Array | null> {
  try {
    const res = await fetchImpl(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength > max ? null : bytes;
  } catch {
    return null;
  }
}

/**
 * The business's logo, taken from its own website, saved for the contact card.
 * Returns the saved path, or null when the site offers nothing usable.
 */
export async function fetchSiteLogo(
  website: string,
  dir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const page = await get(fetchImpl, website, MAX_PAGE_BYTES);
  const html = page ? new TextDecoder().decode(page) : "";
  for (const url of logoCandidates(html, website)) {
    const bytes = await get(fetchImpl, url, MAX_IMAGE_BYTES);
    const kind = bytes ? imageKind(bytes) : null;
    if (!bytes || !kind || bytes.byteLength < 512) continue;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${new URL(website).hostname.replace(/[^a-z0-9.-]/gi, "_")}.${kind}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  }
  return null;
}
