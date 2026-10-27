import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One `opencontact run` per state directory. Two bridges on the same Messages
 * database each answer every text, and each reads the other's sends as the
 * owner typing. The pid file makes the second one refuse to start.
 */
export class RunLock {
  constructor(private readonly path: string) {}

  /** The pid holding the lock, or null when it is free (or stale). */
  holder(): number | null {
    if (!existsSync(this.path)) return null;
    const pid = Number(readFileSync(this.path, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null; // stale: the process is gone
    }
  }

  acquire(pid: number = process.pid): void {
    const other = this.holder();
    if (other !== null && other !== pid) {
      throw new Error(`opencontact is already running (pid ${other}). Stop it first, or run \`kill ${other}\`.`);
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, `${String(pid)}\n`, { mode: 0o600 });
  }

  release(pid: number = process.pid): void {
    if (!existsSync(this.path)) return;
    const held = Number(readFileSync(this.path, "utf8").trim());
    if (held === pid) rmSync(this.path, { force: true });
  }
}
