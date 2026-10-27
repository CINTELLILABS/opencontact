import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSentLedger } from "../src/ledger.ts";

describe("FileSentLedger", () => {
  it("shares guids between two instances through the file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "sent.txt");
    const writer = new FileSentLedger(path);
    const reader = new FileSentLedger(path);
    expect(reader.has("A")).toBe(false);
    writer.add("A");
    expect(reader.has("A")).toBe(true);
    expect(reader.has("B")).toBe(false);
  });
  it("ignores empty guids", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "sent.txt");
    const l = new FileSentLedger(path);
    l.add("");
    expect(l.has("")).toBe(false);
  });
});
