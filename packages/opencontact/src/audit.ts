import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only JSONL audit log. One line per decision the bridge made:
 * what came in, why it was skipped, what went out (or would have, in dry-run).
 */
export type AuditEvent =
  | { event: "inbound"; guid: string; chat_id: number; sender: string; chars: number }
  | { event: "skipped"; guid: string; sender: string; reason: SkipReason }
  | { event: "owner_reply"; guid: string; chat_id: number }
  | { event: "chat_opened"; sender: string; conversation_id: string }
  | { event: "agent_turn"; guid: string; conversation_id: string; status: string; replies: number; error?: string }
  | { event: "dry_run_send"; conversation_id: string; chat_id: number; chars: number }
  | { event: "sent"; conversation_id: string; chat_id: number; chars: number; message_guid?: string }
  | { event: "send_failed"; conversation_id: string; chat_id: number; error: string }
  | { event: "rate_limited"; conversation_id: string; sender: string; scope: "global" | "sender" }
  | { event: "card_sent"; conversation_id: string; chat_id: number; message_guid?: string }
  | { event: "dry_run_card"; conversation_id: string; chat_id: number }
  | {
      event: "outbound";
      sender: string;
      conversation_id: string;
      chars: number;
      message_guid?: string;
      dry_run: boolean;
    }
  | { event: "error"; where: string; error: string };

export type SkipReason =
  | "edit_or_unsend"
  | "group_chat"
  | "not_allowed"
  | "owner_takeover"
  | "empty"
  | "duplicate"
  | "bridge_sent";

export interface AuditSink {
  write(record: AuditEvent): void;
}

export class JsonlAudit implements AuditSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  write(record: AuditEvent): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    appendFileSync(this.path, `${line}\n`, { mode: 0o600 });
  }
}

export class MemoryAudit implements AuditSink {
  readonly records: AuditEvent[] = [];
  write(record: AuditEvent): void {
    this.records.push(record);
  }
}
