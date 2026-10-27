import { describe, expect, it } from "vitest";
import { pickImages } from "../src/attachments.ts";

describe("pickImages", () => {
  const exists = (p: string) => !p.includes("gone");
  const size = () => 100;
  it("keeps present JPEG/PNG/GIF/WebP under the cap, expands ~, skips stickers, missing, HEIC, and big files", () => {
    const imgs = pickImages(
      [
        { filename: "~/Library/Messages/Attachments/a/photo.jpeg", mime_type: "image/jpeg", total_bytes: 1200 },
        { filename: "/tmp/x/shot.PNG", mime_type: "", total_bytes: 900 },
        { filename: "/tmp/x/anim.gif", mime_type: "image/gif", total_bytes: 50 },
        { filename: "/tmp/x/pic.heic", mime_type: "image/heic", total_bytes: 50 },
        { filename: "/tmp/x/doc.pdf", mime_type: "application/pdf", total_bytes: 50 },
        { filename: "/tmp/x/sticker.png", mime_type: "image/png", is_sticker: true },
        { filename: "/tmp/x/gone.png", mime_type: "image/png", missing: true },
        { filename: "/tmp/x/huge.png", mime_type: "image/png", total_bytes: 50 * 1024 * 1024 },
      ],
      { exists, size },
    );
    expect(imgs.map((i) => [i.mimeType, i.bytes])).toEqual([
      ["image/jpeg", 1200],
      ["image/png", 900],
      ["image/gif", 50],
    ]);
    expect(imgs[0]?.path.startsWith("/")).toBe(true);
    expect(imgs[0]?.path).not.toContain("~");
  });
  it("caps the count", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      filename: `/tmp/x/${i}.png`,
      mime_type: "image/png",
      total_bytes: 1,
    }));
    expect(pickImages(many, { exists, size })).toHaveLength(3);
    expect(pickImages(many, { exists, size, max: 1 })).toHaveLength(1);
  });
  it("returns nothing for no attachments", () => {
    expect(pickImages(undefined)).toEqual([]);
    expect(pickImages([])).toEqual([]);
  });
});
