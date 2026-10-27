import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Guids of messages opencontact itself sent, shared between processes. The running
 * bridge sees its own sends (and `opencontact text`'s) come back as `is_from_me`
 * rows; without this it would mistake them for the owner typing and pause.
 */
export interface SentLedger {
  add(guid: string): void;
  has(guid: string): boolean;
}

export class FileSentLedger implements SentLedger {
  private cache = new Set<string>();
  private loadedMtime = -1;

  constructor(
    private readonly path: string,
    private readonly keep = 5_000,
  ) {}

  add(guid: string): void {
    if (!guid) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${guid}\n`, { mode: 0o600 });
    this.cache.add(guid);
  }

  has(guid: string): boolean {
    this.refresh();
    return this.cache.has(guid);
  }

  private refresh(): void {
    if (!existsSync(this.path)) return;
    const mtime = statSync(this.path).mtimeMs;
    if (mtime === this.loadedMtime) return;
    this.loadedMtime = mtime;
    const lines = readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    this.cache = new Set(lines.slice(-this.keep));
  }
}

export class MemorySentLedger implements SentLedger {
  readonly guids = new Set<string>();
  add(guid: string): void {
    if (guid) this.guids.add(guid);
  }
  has(guid: string): boolean {
    return this.guids.has(guid);
  }
}
