import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunLock } from "../src/lock.ts";

describe("RunLock", () => {
  it("lets one live holder in and refuses a second", () => {
    const lock = new RunLock(join(mkdtempSync(join(tmpdir(), "lock-")), "run.pid"));
    expect(lock.holder()).toBeNull();
    lock.acquire(process.pid);
    expect(lock.holder()).toBe(process.pid);
    expect(() => lock.acquire(999_999)).toThrow(/already running/);
    lock.release(process.pid);
    expect(lock.holder()).toBeNull();
  });
  it("treats a dead pid as free", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "run.pid");
    const lock = new RunLock(path);
    lock.acquire(2_147_000_000); // not a real process
    expect(lock.holder()).toBeNull();
    expect(() => lock.acquire(process.pid)).not.toThrow();
  });
});
