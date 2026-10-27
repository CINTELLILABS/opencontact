import { describe, expect, it } from "vitest";
import { buildVCard } from "../src/vcard.ts";

describe("buildVCard", () => {
  it("writes a vCard 3.0 Messages can render", () => {
    const v = buildVCard({ name: "Acme Dental, Inc.", phone: "+14155551212", url: "https://acme-dental.com" });
    expect(v.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n")).toBe(true);
    expect(v).toContain("FN:Acme Dental\\, Inc.");
    expect(v).toContain("TEL;TYPE=CELL,VOICE:+14155551212");
    expect(v).toContain("URL:https://acme-dental.com");
    expect(v.endsWith("END:VCARD\r\n")).toBe(true);
    expect(v).not.toContain("PHOTO");
  });
  it("embeds a png logo as folded base64", () => {
    const v = buildVCard({ name: "Acme", photoPath: "/logo.png" }, () => Buffer.alloc(120, 1));
    expect(v).toContain("PHOTO;ENCODING=b;TYPE=PNG:");
    const photoLine = v.split("\r\n").find((l) => l.startsWith("PHOTO"));
    expect(photoLine && photoLine.length <= 75).toBe(true);
    expect(v).toMatch(/\r\n [A-Za-z0-9+/=]+/);
  });
  it("skips photos of unknown type", () => {
    expect(buildVCard({ name: "Acme", photoPath: "/logo.gif" }, () => Buffer.alloc(1))).not.toContain("PHOTO");
  });
});
