import { createRequire } from "node:module";
import { pickImages } from "./attachments.ts";
import type { AuditSink, SkipReason } from "./audit.ts";
import type { Brain } from "./brain.ts";
import type { BridgeConfig } from "./config.ts";
import { maskHandle, normalizeHandle } from "./handles.ts";
import type { ImsgMessage, ImsgRpc, WatchOverflow } from "./imsg.ts";
import type { SentLedger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import { AnswerPolicy, chatKey, Dedupe, inboundText, RateLimiter, TakeoverTracker } from "./policy.ts";
import type { BridgeState, StateStore } from "./state.ts";

/** The subset of ImsgRpc the bridge uses, so tests can pass a fake. */
export type ImsgLike = Pick<
  ImsgRpc,
  "status" | "subscribe" | "unsubscribe" | "after" | "send" | "sendFile" | "on" | "off"
>;

export interface BridgeDeps {
  config: BridgeConfig;
  imsg: ImsgLike;
  /** Whatever answers: Bland, your own model, or a command. */
  brain: Brain;
  state: StateStore;
  audit: AuditSink;
  log: Logger;
  /** Guids opencontact sent from any process (`opencontact text` runs beside the bridge). */
  sentLedger?: SentLedger | undefined;
  /** Path of the business's .vcf, sent once per customer after the first reply. */
  contactCardPath?: string | undefined;
  now?: () => number;
}

export interface BridgeStats {
  inbound: number;
  skipped: number;
  turns: number;
  sent: number;
  dryRunSends: number;
  errors: number;
  cards: number;
}

/**
 * One loop: Messages → brain → Messages. Everything that decides whether to
 * answer lives in policy.ts; this class only sequences it.
 */
export class Bridge {
  readonly stats: BridgeStats = { inbound: 0, skipped: 0, turns: 0, sent: 0, dryRunSends: 0, errors: 0, cards: 0 };

  private readonly allow: AnswerPolicy;
  private readonly rate: RateLimiter;
  private readonly takeover: TakeoverTracker;
  private readonly dedupe = new Dedupe();
  private state: BridgeState;
  private dryRun: boolean;
  private subscription: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: BridgeDeps) {
    const now = deps.now ?? (() => Date.now());
    this.allow = new AnswerPolicy(deps.config.answer, deps.config.allowFrom, deps.state);
    this.rate = new RateLimiter(
      { perHour: deps.config.maxSendsPerHour, perSenderPerHour: deps.config.maxSendsPerSenderPerHour },
      now,
    );
    this.takeover = new TakeoverTracker(deps.config.ownerTakeoverMinutes, now);
    this.dryRun = deps.config.dryRun;
    this.state = deps.state.load();
  }

  /** Flip between dry-run and live without restarting. */
  setDryRun(value: boolean): void {
    this.dryRun = value;
    this.deps.log.info(
      value ? "switched to dry-run: nothing will be sent" : "LIVE: replies now go out through Messages",
    );
  }

  get isDryRun(): boolean {
    return this.dryRun;
  }

  /** Check imsg, subscribe from the saved cursor, and start handling events. */
  async start(): Promise<void> {
    const { imsg, log, config } = this.deps;
    const status = await imsg.status();
    if (status.database && status.database.ready === false) {
      throw new Error(
        `imsg cannot read the Messages database${status.database.error ? `: ${status.database.error.replace(/\.$/, "")}` : ""}. Grant Full Disk Access to the terminal (or app) that runs opencontact, then try again.`,
      );
    }
    if (!this.dryRun && Array.isArray(status.methods) && !status.methods.includes("send")) {
      throw new Error(
        "imsg reports that `send` is unavailable. Grant Automation → Messages to the terminal that runs the bridge.",
      );
    }

    imsg.on("message", this.onMessage);
    imsg.on("overflow", this.onOverflow);

    const since = this.state.cursorRowid;
    const sub = await imsg.subscribe(since !== null ? { since_rowid: since } : {});
    this.subscription = sub.subscription;
    log.info("watching Messages", {
      mode: this.dryRun ? "dry-run" : "live",
      brain: this.deps.brain.kind,
      answers: this.allow.describe(),
      groups: config.groups,
      resume_from: since ?? "tail",
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.deps.imsg.off("message", this.onMessage);
    this.deps.imsg.off("overflow", this.onOverflow);
    if (this.subscription !== null) {
      try {
        await this.deps.imsg.unsubscribe(this.subscription);
      } catch {
        // imsg may already be gone.
      }
      this.subscription = null;
    }
    await this.queue;
  }

  /** Wait for everything queued so far. Tests use this. */
  idle(): Promise<void> {
    return this.queue;
  }

  private readonly onMessage = (msg: ImsgMessage): void => {
    if (this.stopped) return;
    this.queue = this.queue.then(() => this.handle(msg)).catch((err: unknown) => this.fail("handle", err));
  };

  private readonly onOverflow = (info: WatchOverflow): void => {
    if (this.stopped) return;
    this.queue = this.queue.then(() => this.recover(info)).catch((err: unknown) => this.fail("overflow", err));
  };

  /** The watch buffer overflowed: page forward from the resume point, then subscribe again. */
  private async recover(info: WatchOverflow): Promise<void> {
    const { imsg, log } = this.deps;
    log.warn("watch overflow; catching up", { reason: info.reason, resume_after: info.resume_after_rowid });
    let cursor = info.resume_after_rowid ?? this.state.cursorRowid ?? 0;
    for (;;) {
      const page = await imsg.after(cursor);
      for (const m of page.messages) await this.handle(m);
      cursor = page.next_rowid;
      if (!page.has_more) break;
    }
    const sub = await imsg.subscribe({ since_rowid: cursor });
    this.subscription = sub.subscription;
  }

  /** Decide about one inbound and act on it. Public for tests. */
  async handle(msg: ImsgMessage): Promise<void> {
    const { config, audit, log, brain } = this.deps;
    const key = chatKey(msg);
    const sender = normalizeHandle(msg.sender ?? "");

    if (msg.type === "edited" || msg.type === "unsent") {
      this.skip(msg, sender, "edit_or_unsend");
      return;
    }
    if (!this.dedupe.first(msg.guid)) {
      this.skip(msg, sender, "duplicate");
      return;
    }

    if (msg.is_from_me) {
      if (this.takeover.isBridgeSent(msg.guid) || this.deps.sentLedger?.has(msg.guid)) {
        this.skip(msg, sender, "bridge_sent");
      } else {
        this.takeover.ownerReplied(key);
        audit.write({ event: "owner_reply", guid: msg.guid, chat_id: msg.chat_id });
        log.info("owner replied from Messages; agent paused in this chat", {
          chat_id: msg.chat_id,
          minutes: config.ownerTakeoverMinutes,
        });
      }
      this.advance(msg.id);
      return;
    }

    this.stats.inbound += 1;
    audit.write({
      event: "inbound",
      guid: msg.guid,
      chat_id: msg.chat_id,
      sender: maskHandle(sender),
      chars: (msg.text ?? "").length,
    });

    if (msg.is_group && !config.groups) return this.skipAndAdvance(msg, sender, "group_chat");
    if (!this.allow.allows(sender)) return this.skipAndAdvance(msg, sender, "not_allowed");
    if (this.takeover.isPaused(key)) return this.skipAndAdvance(msg, sender, "owner_takeover");

    const images = brain.acceptsImages ? pickImages(msg.attachments) : [];
    const text = inboundText(msg, config.attachments, images.length);
    if (text === null) return this.skipAndAdvance(msg, sender, "empty");

    const turn = await brain.reply(sender, text, msg.guid, images);
    this.stats.turns += 1;
    audit.write({
      event: "agent_turn",
      guid: msg.guid,
      conversation_id: turn.conversationId,
      status: turn.status,
      replies: turn.texts.length,
      ...(turn.error ? { error: turn.error } : {}),
    });
    if (turn.status === "human_handoff") {
      log.info("agent handed this conversation to a human; reply from Messages yourself", {
        conversation_id: turn.conversationId,
        chat_id: msg.chat_id,
      });
    }

    let delivered = 0;
    for (const reply of turn.texts) {
      if (reply.trim().length === 0) continue;
      await this.deliver(msg, sender, turn.conversationId, reply);
      delivered += 1;
    }
    if (delivered > 0) await this.maybeSendCard(msg, sender, turn.conversationId);
    this.advance(msg.id);
  }

  /** The business card, once per customer, right after their first answer. */
  private async maybeSendCard(msg: ImsgMessage, sender: string, conversationId: string): Promise<void> {
    const { contactCardPath, imsg, audit, log } = this.deps;
    if (!contactCardPath) return;
    const fresh = this.deps.state.load();
    if (fresh.cardSentTo.includes(sender)) return;
    if (this.dryRun) {
      audit.write({ event: "dry_run_card", conversation_id: conversationId, chat_id: msg.chat_id });
      log.info(`DRY RUN → would send the contact card to chat ${msg.chat_id}`);
      return;
    }
    try {
      const result = await imsg.sendFile({ chat_id: msg.chat_id }, contactCardPath);
      this.takeover.markBridgeSent(result.guid);
      this.deps.sentLedger?.add(result.guid ?? "");
      this.stats.cards += 1;
      fresh.cardSentTo.push(sender);
      this.deps.state.save(fresh);
      audit.write({
        event: "card_sent",
        conversation_id: conversationId,
        chat_id: msg.chat_id,
        ...(result.guid ? { message_guid: result.guid } : {}),
      });
      log.info("sent contact card", { chat_id: msg.chat_id });
    } catch (err) {
      audit.write({
        event: "send_failed",
        conversation_id: conversationId,
        chat_id: msg.chat_id,
        error: `contact card: ${(err as Error).message}`,
      });
      log.warn("contact card failed", { chat_id: msg.chat_id, error: (err as Error).message });
    }
  }

  /** Send one reply back into the chat, or log it in dry-run. */
  private async deliver(msg: ImsgMessage, sender: string, conversationId: string, text: string): Promise<void> {
    const { imsg, audit, log } = this.deps;
    const decision = this.rate.take(sender);
    if (!decision.ok) {
      audit.write({
        event: "rate_limited",
        conversation_id: conversationId,
        sender: maskHandle(sender),
        scope: decision.scope,
      });
      log.warn("send cap reached; reply dropped", { scope: decision.scope, chat_id: msg.chat_id });
      return;
    }
    if (this.dryRun) {
      this.stats.dryRunSends += 1;
      audit.write({ event: "dry_run_send", conversation_id: conversationId, chat_id: msg.chat_id, chars: text.length });
      log.info(`DRY RUN → would send to chat ${msg.chat_id}: ${text}`);
      return;
    }
    try {
      const result = await imsg.send({ chat_id: msg.chat_id }, text);
      this.takeover.markBridgeSent(result.guid);
      this.deps.sentLedger?.add(result.guid ?? "");
      this.stats.sent += 1;
      audit.write({
        event: "sent",
        conversation_id: conversationId,
        chat_id: msg.chat_id,
        chars: text.length,
        ...(result.guid ? { message_guid: result.guid } : {}),
      });
      log.info("sent reply", { chat_id: msg.chat_id, chars: text.length });
    } catch (err) {
      this.stats.errors += 1;
      audit.write({
        event: "send_failed",
        conversation_id: conversationId,
        chat_id: msg.chat_id,
        error: String((err as Error).message ?? err),
      });
      log.error("send failed", { chat_id: msg.chat_id, error: (err as Error).message });
    }
  }

  private skip(msg: ImsgMessage, sender: string, reason: SkipReason): void {
    this.stats.skipped += 1;
    this.deps.audit.write({ event: "skipped", guid: msg.guid, sender: maskHandle(sender), reason });
    this.deps.log.debug("skipped", { reason, chat_id: msg.chat_id });
  }

  private skipAndAdvance(msg: ImsgMessage, sender: string, reason: SkipReason): void {
    this.skip(msg, sender, reason);
    this.advance(msg.id);
  }

  private advance(rowid: number): void {
    if (typeof rowid !== "number") return;
    if (this.state.cursorRowid === null || rowid > this.state.cursorRowid) {
      const fresh = this.deps.state.load();
      fresh.cursorRowid = rowid;
      this.deps.state.save(fresh);
      this.state = fresh;
    }
  }

  private fail(where: string, err: unknown): void {
    this.stats.errors += 1;
    const message = err instanceof Error ? err.message : String(err);
    this.deps.audit.write({ event: "error", where, error: message });
    this.deps.log.error(`${where} failed`, { error: message });
  }
}

/** The package version, read from package.json so it cannot drift from what npm publishes. */
export const BRIDGE_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;
