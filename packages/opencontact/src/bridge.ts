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

/** What the live view (or anything else) wants to hear about, as it happens. */
export interface BridgeEvents {
  inbound?(e: { handle: string; name?: string | undefined; chatId: number; text: string; images: number }): void;
  thinking?(e: { handle: string; chatId: number }): void;
  reply?(e: { handle: string; chatId: number; text: string; dryRun: boolean }): void;
  card?(e: { handle: string; chatId: number; dryRun: boolean }): void;
  /** Something opencontact sent from another process (`opencontact text`), seen coming back from Messages. */
  ownSend?(e: { handle: string; chatId: number; text: string; card: boolean }): void;
  skipped?(e: { handle: string; reason: SkipReason }): void;
  takeover?(e: { handle: string; chatId: number; text: string }): void;
  error?(e: { where: string; message: string }): void;
}

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
  events?: BridgeEvents | undefined;
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
  /** One promise chain per chat: a chat's messages stay in order, different chats run concurrently. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly inflight = new Set<number>();
  private doneMax: number | null = null;
  private recovering: Promise<void> = Promise.resolve();
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

  /** Conversations a person has taken over: the agent stays out until handed back. */
  private readonly manual = new Set<string>();

  setManual(handle: string, on: boolean): void {
    const h = normalizeHandle(handle);
    if (on) this.manual.add(h);
    else this.manual.delete(h);
  }

  isManual(handle: string): boolean {
    return this.manual.has(normalizeHandle(handle));
  }

  /** A message the owner sent from opencontact itself: its echo is neither the agent nor a takeover. */
  markOwnSend(guid: string | undefined): void {
    this.takeover.markBridgeSent(guid);
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
    await this.idle();
  }

  /** Wait for everything queued so far. Tests use this. */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.chains.values(), this.recovering];
      await Promise.all(pending);
      if ([...this.chains.values(), this.recovering].every((p) => pending.includes(p))) return;
    }
  }

  private readonly onMessage = (msg: ImsgMessage): void => {
    if (this.stopped) return;
    const key = chatKey(msg);
    const prev = this.chains.get(key) ?? Promise.resolve();
    if (typeof msg.id === "number") this.inflight.add(msg.id);
    const next = prev
      .then(() => this.recovering)
      .then(() => this.handle(msg))
      .catch((err: unknown) => this.fail("handle", err))
      .finally(() => {
        if (typeof msg.id === "number") this.inflight.delete(msg.id);
        this.settle();
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  };

  private readonly onOverflow = (info: WatchOverflow): void => {
    if (this.stopped) return;
    this.recovering = this.recovering
      .then(() => this.recover(info))
      .catch((err: unknown) => this.fail("overflow", err))
      .finally(() => this.settle());
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
      const to = normalizeHandle(msg.participants?.[0] ?? msg.chat_identifier ?? "");
      if (this.takeover.isBridgeSent(msg.guid)) {
        this.skip(msg, sender, "bridge_sent");
      } else if (this.deps.sentLedger?.has(msg.guid)) {
        this.skip(msg, sender, "bridge_sent");
        const isCard = (msg.attachments ?? []).some((a) => /\.vcf$/i.test(String(a.filename ?? a.transfer_name ?? "")));
        this.deps.events?.ownSend?.({ handle: to, chatId: msg.chat_id, text: msg.text ?? "", card: isCard });
      } else {
        // Only conversations the agent is part of are worth a note, and only once per pause.
        const engaged = this.deps.state.load().conversations[to] !== undefined;
        const alreadyPaused = this.takeover.isPaused(key);
        this.takeover.ownerReplied(key);
        if (engaged)
          this.deps.events?.takeover?.({
            handle: to,
            chatId: msg.chat_id,
            text: alreadyPaused ? (msg.text ?? "") : (msg.text ?? ""),
          });
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
    const sentAt = Date.parse(msg.created_at ?? "");
    const now = this.deps.now ? this.deps.now() : Date.now();
    if (config.maxAgeMinutes > 0 && Number.isFinite(sentAt) && now - sentAt > config.maxAgeMinutes * 60_000)
      return this.skipAndAdvance(msg, sender, "stale");
    if (!this.allow.allows(sender)) return this.skipAndAdvance(msg, sender, "not_allowed");

    const images = brain.acceptsImages ? pickImages(msg.attachments) : [];
    const text = inboundText(msg, config.attachments, images.length);
    if (text === null) return this.skipAndAdvance(msg, sender, "empty");

    // Shown even when a person has the conversation, so they see what came in.
    this.deps.events?.inbound?.({
      handle: sender,
      name: typeof msg.sender_name === "string" && msg.sender_name ? msg.sender_name : undefined,
      chatId: msg.chat_id,
      text: (msg.text ?? "").replace(/\uFFFC/g, "").trim() || (images.length > 0 ? "📷 photo" : text),
      images: images.length,
    });
    if (this.manual.has(sender)) return this.skipAndAdvance(msg, sender, "manual");
    if (this.takeover.isPaused(key)) return this.skipAndAdvance(msg, sender, "owner_takeover");

    this.deps.events?.thinking?.({ handle: sender, chatId: msg.chat_id });
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
      this.deps.events?.card?.({ handle: sender, chatId: msg.chat_id, dryRun: true });
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
      this.deps.events?.card?.({ handle: sender, chatId: msg.chat_id, dryRun: false });
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
      this.deps.events?.reply?.({ handle: sender, chatId: msg.chat_id, text, dryRun: true });
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
      this.deps.events?.reply?.({ handle: sender, chatId: msg.chat_id, text, dryRun: false });
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
    if (
      reason !== "bridge_sent" &&
      reason !== "duplicate" &&
      reason !== "edit_or_unsend" &&
      reason !== "stale" &&
      reason !== "manual"
    )
      this.deps.events?.skipped?.({ handle: sender, reason });
    this.stats.skipped += 1;
    this.deps.audit.write({ event: "skipped", guid: msg.guid, sender: maskHandle(sender), reason });
    this.deps.log.debug("skipped", { reason, chat_id: msg.chat_id });
  }

  private skipAndAdvance(msg: ImsgMessage, sender: string, reason: SkipReason): void {
    this.skip(msg, sender, reason);
    this.advance(msg.id);
  }

  /** A message is handled; the cursor moves in settle(), never past one still in flight. */
  private advance(rowid: number): void {
    if (typeof rowid !== "number") return;
    if (this.doneMax === null || rowid > this.doneMax) this.doneMax = rowid;
  }

  private settle(): void {
    if (this.doneMax === null) return;
    const target = this.inflight.size > 0 ? Math.min(this.doneMax, Math.min(...this.inflight) - 1) : this.doneMax;
    if (this.state.cursorRowid === null || target > this.state.cursorRowid) {
      const fresh = this.deps.state.load();
      fresh.cursorRowid = target;
      this.deps.state.save(fresh);
      this.state = fresh;
    }
  }

  private fail(where: string, err: unknown): void {
    this.stats.errors += 1;
    const message = err instanceof Error ? err.message : String(err);
    this.deps.audit.write({ event: "error", where, error: message });
    this.deps.log.error(`${where} failed`, { error: message });
    this.deps.events?.error?.({ where, message });
  }
}

/** The package version, read from package.json so it cannot drift from what npm publishes. */
export const BRIDGE_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;
