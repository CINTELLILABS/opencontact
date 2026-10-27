import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ConversationRef {
  conversationId: string;
  agentId: string;
  openedAt: string;
  /** Opened by `opencontact text`: the agent reached out first. */
  outbound?: boolean | undefined;
}

export interface BridgeState {
  /** Last Messages ROWID the bridge finished handling. `null` means start at the tail. */
  cursorRowid: number | null;
  /** Open Bland conversation per normalized handle. */
  conversations: Record<string, ConversationRef>;
  /** Handles that already received the contact card. */
  cardSentTo: string[];
}

export interface StateStore {
  load(): BridgeState;
  save(state: BridgeState): void;
}

export function emptyState(): BridgeState {
  return { cursorRowid: null, conversations: {}, cardSentTo: [] };
}

/** JSON file, written atomically via rename. */
export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  load(): BridgeState {
    if (!existsSync(this.path)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BridgeState>;
      return {
        cursorRowid: typeof parsed.cursorRowid === "number" ? parsed.cursorRowid : null,
        conversations: parsed.conversations && typeof parsed.conversations === "object" ? parsed.conversations : {},
        cardSentTo: Array.isArray(parsed.cardSentTo)
          ? parsed.cardSentTo.filter((x): x is string => typeof x === "string")
          : [],
      };
    } catch {
      return emptyState();
    }
  }

  save(state: BridgeState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class MemoryStateStore implements StateStore {
  private state: BridgeState = emptyState();
  load(): BridgeState {
    return structuredClone(this.state);
  }
  save(state: BridgeState): void {
    this.state = structuredClone(state);
  }
}
