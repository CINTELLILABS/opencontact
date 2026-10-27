import { describe, expect, it } from "vitest";
import { parseSha256Sums, sha256 } from "../src/install-imsg.ts";

describe("parseSha256Sums", () => {
  it("reads the GNU coreutils format imsg publishes", () => {
    const text = [
      "adb176c1b00aa1e8abe3b5fe640fc0d84586282c5eac1b91aa328ef3a08acf31  imsg-macos.zip",
      "0000000000000000000000000000000000000000000000000000000000000000 *imsg-linux-x86_64.tar.gz",
      "",
      "not a checksum line",
    ].join("\n");
    const m = parseSha256Sums(text);
    expect(m.get("imsg-macos.zip")).toBe("adb176c1b00aa1e8abe3b5fe640fc0d84586282c5eac1b91aa328ef3a08acf31");
    expect(m.get("imsg-linux-x86_64.tar.gz")).toBe("0".repeat(64));
    expect(m.size).toBe(2);
  });
});

describe("sha256", () => {
  it("hashes bytes", () => {
    expect(sha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
