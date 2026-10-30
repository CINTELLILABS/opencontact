import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchSiteLogo, imageKind, logoCandidates } from "../src/site-logo.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(600).fill(1)]);

describe("logoCandidates", () => {
  it("prefers the touch icon, resolves relative links, and falls back to og:image", () => {
    const html = `<meta property="og:image" content="https://cdn.x/og.jpg">
      <link rel="icon" href="/fav.ico"><link rel="apple-touch-icon" sizes="180x180" href="/img/touch.png">`;
    expect(logoCandidates(html, "https://acme.test/about")).toEqual([
      "https://acme.test/img/touch.png",
      "https://acme.test/apple-touch-icon.png",
      "https://cdn.x/og.jpg",
    ]);
  });
});

describe("fetchSiteLogo", () => {
  it("saves the first real PNG or JPEG and skips HTML pretending to be an icon", async () => {
    const fake = (async (url: string) => {
      if (url === "https://acme.test") return new Response('<link rel="apple-touch-icon" href="/t.png">');
      if (url === "https://acme.test/t.png") return new Response("<html>not found</html>");
      if (url === "https://acme.test/apple-touch-icon.png") return new Response(PNG);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "oc-logo-"));
    const path = await fetchSiteLogo("https://acme.test", dir, fake);
    expect(path).toBe(join(dir, "acme.test.png"));
    expect(imageKind(readFileSync(path as string))).toBe("png");
  });

  it("returns null when the site is down", async () => {
    const down = (async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch;
    expect(await fetchSiteLogo("https://gone.test", tmpdir(), down)).toBeNull();
  });
});
