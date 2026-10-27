import type { AnswerMode } from "./config.ts";
import { normalizeHandle } from "./handles.ts";
import type { ImsgMessage } from "./imsg.ts";
import type { StateStore } from "./state.ts";

/** Who gets answered, by mode. */
export class AnswerPolicy {
  private readonly list: Allowlist;

  constructor(
    readonly mode: AnswerMode,
    entries: readonly string[],
    private readonly state: StateStore,
  ) {
    this.list = new Allowlist(entries);
  }

  allows(handle: string): boolean {
    switch (this.mode) {
      case "everyone":
        return true;
      case "list":
        return !this.list.everyone && this.list.allows(handle);
      case "outbound":
        return this.state.load().conversations[normalizeHandle(handle)]?.outbound === true;
    }
  }

  describe(): string {
    switch (this.mode) {
      case "everyone":
        return "anyone who texts this number";
      case "list":
        return this.list.everyone ? "nobody (the list is empty)" : `only ${this.list.size} listed handle(s)`;
      case "outbound":
        return "only people the agent texted first";
    }
  }
}

/** A handle list. An empty list answers everyone; a non-empty list restricts to it. */
export class Allowlist {
  private readonly set: Set<string>;

  constructor(entries: readonly string[]) {
    this.set = new Set(entries.map(normalizeHandle).filter((h) => h.length > 0));
  }

  allows(handle: string): boolean {
    if (this.set.size === 0) return true;
    return this.set.has(normalizeHandle(handle));
  }

  get everyone(): boolean {
    return this.set.size === 0;
  }

  get size(): number {
    return this.set.size;
  }
}

export type RateDecision = { ok: true } | { ok: false; scope: "global" | "sender" };

/** Sliding one-hour window, global and per recipient. A cap of 0 disables that cap. */
export class RateLimiter {
  private readonly global: number[] = [];
  private readonly perSender = new Map<string, number[]>();

  constructor(
    private readonly caps: { perHour: number; perSenderPerHour: number },
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs = 60 * 60 * 1000,
  ) {}

  /** Reserve one send. Call only when a send is about to happen (or would, in dry-run). */
  take(sender: string): RateDecision {
    const t = this.now();
    this.prune(this.global, t);
    const mine = this.perSender.get(sender) ?? [];
    this.prune(mine, t);

    if (this.caps.perHour > 0 && this.global.length >= this.caps.perHour) return { ok: false, scope: "global" };
    if (this.caps.perSenderPerHour > 0 && mine.length >= this.caps.perSenderPerHour)
      return { ok: false, scope: "sender" };

    this.global.push(t);
    mine.push(t);
    this.perSender.set(sender, mine);
    return { ok: true };
  }

  private prune(list: number[], t: number): void {
    const cutoff = t - this.windowMs;
    while (list.length > 0 && (list[0] as number) <= cutoff) list.shift();
  }
}

/**
 * When the business owner types a reply in Messages themselves, the agent
 * steps back in that chat for a while. Messages the bridge itself sent also
 * show up as `is_from_me`, so their guids are tracked and excluded.
 */
export class TakeoverTracker {
  private readonly pausedUntil = new Map<string, number>();
  private readonly bridgeGuids = new Set<string>();
  private readonly bridgeGuidOrder: string[] = [];

  constructor(
    private readonly minutes: number,
    private readonly now: () => number = () => Date.now(),
    private readonly maxTrackedGuids = 2_000,
  ) {}

  markBridgeSent(guid: string | undefined): void {
    if (!guid) return;
    this.bridgeGuids.add(guid);
    this.bridgeGuidOrder.push(guid);
    while (this.bridgeGuidOrder.length > this.maxTrackedGuids) {
      const old = this.bridgeGuidOrder.shift();
      if (old) this.bridgeGuids.delete(old);
    }
  }

  isBridgeSent(guid: string): boolean {
    return this.bridgeGuids.has(guid);
  }

  ownerReplied(chatKey: string): void {
    if (this.minutes <= 0) return;
    this.pausedUntil.set(chatKey, this.now() + this.minutes * 60 * 1000);
  }

  isPaused(chatKey: string): boolean {
    const until = this.pausedUntil.get(chatKey);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.pausedUntil.delete(chatKey);
      return false;
    }
    return true;
  }
}

/** Remember recently seen guids so a replayed watch event is not answered twice. */
export class Dedupe {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly max = 5_000) {}

  /** Returns true the first time a guid is seen. */
  first(guid: string): boolean {
    if (this.seen.has(guid)) return false;
    this.seen.add(guid);
    this.order.push(guid);
    while (this.order.length > this.max) {
      const old = this.order.shift();
      if (old) this.seen.delete(old);
    }
    return true;
  }
}

/**
 * The text the agent sees for one inbound. Attachment-only messages become a
 * bracketed description so the agent can ask for text, or are dropped.
 */
export function inboundText(msg: ImsgMessage, attachments: "describe" | "ignore", imagesAttached = 0): string | null {
  // Messages.app stores an object-replacement character where an attachment sits.
  const text = (msg.text ?? "").replace(/\uFFFC/g, "").trim();
  const count = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
  if (text.length > 0 && count === 0) return text;
  if (count === 0) return null;
  if (imagesAttached > 0) {
    const note = `[${imagesAttached === 1 ? "An image is" : `${imagesAttached} images are`} attached to this message.]`;
    return text.length > 0 ? `${text}\n\n${note}` : note;
  }
  if (attachments === "ignore") return text.length > 0 ? text : null;

  const kinds = msg.attachments
    .map((a) => a.mime_type || a.uti || a.transfer_name || "file")
    .map(String)
    .slice(0, 3)
    .join(", ");
  const note = `[The customer sent ${count === 1 ? "an attachment" : `${count} attachments`} (${kinds}) that could not be delivered over this channel. Ask them to describe it in text if it matters.]`;
  return text.length > 0 ? `${text}\n\n${note}` : note;
}

/** Stable key for "this chat" across messages: prefer the chat guid, fall back to the id. */
export function chatKey(msg: ImsgMessage): string {
  return msg.chat_guid ?? `chat:${msg.chat_id}`;
}
