import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { MemoryAudit } from "../src/audit.ts";
import { type BlandApi, BlandApiError, type ChatConversation, type OpenChatInput } from "../src/bland.ts";
import { BlandBrain } from "../src/brain.ts";
import { Bridge } from "../src/bridge.ts";
import type { BridgeConfig } from "../src/config.ts";
import type { ImsgMessage } from "../src/imsg.ts";
import { MemorySentLedger } from "../src/ledger.ts";
import { silentLogger } from "../src/log.ts";
import { MemoryStateStore } from "../src/state.ts";

const AGENT = "11111111-1111-4111-8111-111111111111";

class FakeImsg extends EventEmitter {
  sent: Array<{ target: unknown; text: string }> = [];
  afterPages: Array<{ messages: ImsgMessage[]; next_rowid: number; has_more: boolean }> = [];
  subscriptions: unknown[] = [];
  statusResult: Record<string, unknown> = { database: { ready: true }, methods: ["send", "watch.subscribe"] };
  async status() {
    return this.statusResult;
  }
  async subscribe(opts: unknown) {
    this.subscriptions.push(opts);
    return { subscription: this.subscriptions.length, buffer_limit: 256 };
  }
  async unsubscribe() {
    return { ok: true };
  }
  async after() {
    return this.afterPages.shift() ?? { messages: [], next_rowid: 0, has_more: false };
  }
  async send(target: unknown, text: string) {
    this.sent.push({ target, text });
    return { ok: true, id: this.sent.length, guid: `BRIDGE-${this.sent.length}` };
  }
  files: Array<{ target: unknown; file: string }> = [];
  async sendFile(target: unknown, file: string) {
    this.files.push({ target, file });
    return { ok: true, id: 900 + this.files.length, guid: `CARD-${this.files.length}` };
  }
}

class FakeBland implements BlandApi {
  opened: OpenChatInput[] = [];
  relayed: Array<{ id: string; text: string; key: string }> = [];
  replies: string[] = ["Thanks for texting Acme Dental! How can I help?"];
  status: ChatConversation["status"] = "active";
  failNextWith: number | null = null;
  private n = 0;

  async me() {
    return {};
  }
  async openChat(input: OpenChatInput): Promise<ChatConversation> {
    this.opened.push(input);
    this.n += 1;
    return this.convo(`conv-${this.n}`, []);
  }
  async sendMessage(id: string, text: string, key: string): Promise<ChatConversation> {
    if (this.failNextWith !== null) {
      const status = this.failNextWith;
      this.failNextWith = null;
      throw new BlandApiError(status, "CHAT_ENDED", "ended");
    }
    this.relayed.push({ id, text, key });
    return this.convo(
      id,
      this.replies.map((t, i) => ({ id: `m${i}`, role: "agent" as const, text: t, created_at: "" })),
    );
  }
  private convo(id: string, messages: ChatConversation["messages"]): ChatConversation {
    const ended = this.status === "ended" || this.status === "timeout";
    return {
      conversation_id: id,
      agent_id: AGENT,
      end_user_id: "+14155551212",
      status: this.status,
      ended,
      created_at: null,
      summary: null,
      disposition: null,
      variables: null,
      metadata: null,
      messages,
    };
  }
}

const config = (over: Partial<BridgeConfig> = {}): BridgeConfig => ({
  brain: { kind: "bland" },
  apiKey: "k",
  apiUrl: "https://api.test",
  agentId: AGENT,
  dryRun: false,
  answer: "everyone",
  allowFrom: [],
  groups: false,
  maxSendsPerHour: 60,
  maxSendsPerSenderPerHour: 20,
  ownerTakeoverMinutes: 30,
  maxAgeMinutes: 0,
  attachments: "describe",
  imsgPath: "imsg",
  stateDir: "/tmp/unused",
  ...over,
});

const inbound = (over: Partial<ImsgMessage> = {}): ImsgMessage => ({
  id: 100,
  chat_id: 42,
  chat_guid: "iMessage;-;+14155551212",
  is_group: false,
  guid: `G-${Math.random()}`,
  sender: "+1 (415) 555-1212",
  is_from_me: false,
  text: "Do you take Delta Dental?",
  created_at: new Date().toISOString(),
  attachments: [],
  ...over,
});

async function setup(
  cfg: Partial<BridgeConfig> = {},
  extra: { contactCardPath?: string; ledger?: MemorySentLedger } = {},
) {
  const imsg = new FakeImsg();
  const bland = new FakeBland();
  const audit = new MemoryAudit();
  const state = new MemoryStateStore();
  const cfg2 = config(cfg);
  const bridge = new Bridge({
    config: cfg2,
    imsg: imsg as never,
    brain: new BlandBrain(bland, cfg2, state, audit, silentLogger),
    state,
    audit,
    log: silentLogger,
    sentLedger: extra.ledger,
    contactCardPath: extra.contactCardPath,
  });
  await bridge.start();
  return { imsg, bland, audit, state, bridge };
}

describe("Bridge", () => {
  it("opens a chat for whoever texts, relays the text, and replies into the same chat", async () => {
    const { imsg, bland, audit, state, bridge } = await setup();
    const msg = inbound();
    imsg.emit("message", msg, 1);
    await bridge.idle();

    expect(bland.opened).toHaveLength(1);
    expect(bland.opened[0]).toMatchObject({
      agentId: AGENT,
      endUserId: "+14155551212",
      contact: { phone_number: "+14155551212" },
    });
    expect(bland.relayed).toEqual([{ id: "conv-1", text: "Do you take Delta Dental?", key: msg.guid }]);
    expect(imsg.sent).toEqual([{ target: { chat_id: 42 }, text: "Thanks for texting Acme Dental! How can I help?" }]);
    expect(state.load().cursorRowid).toBe(100);
    expect(state.load().conversations["+14155551212"]?.conversationId).toBe("conv-1");
    expect(audit.records.map((r) => r.event)).toEqual(["inbound", "chat_opened", "agent_turn", "sent"]);
  });

  it("reuses the open conversation on the next message", async () => {
    const { imsg, bland, bridge } = await setup();
    imsg.emit("message", inbound({ id: 1 }), 1);
    imsg.emit("message", inbound({ id: 2, text: "and Cigna?" }), 1);
    await bridge.idle();
    expect(bland.opened).toHaveLength(1);
    expect(bland.relayed.map((r) => r.id)).toEqual(["conv-1", "conv-1"]);
  });

  it("dry-run sends nothing but records what it would have sent", async () => {
    const { imsg, audit, bridge } = await setup({ dryRun: true });
    imsg.emit("message", inbound(), 1);
    await bridge.idle();
    expect(imsg.sent).toEqual([]);
    expect(audit.records.some((r) => r.event === "dry_run_send")).toBe(true);
    expect(bridge.stats.dryRunSends).toBe(1);
  });

  it("answers anyone by default, including email handles", async () => {
    const { imsg, bland, bridge } = await setup();
    imsg.emit("message", inbound({ sender: "stranger@example.com" }), 1);
    await bridge.idle();
    expect(bland.opened[0]).toMatchObject({
      endUserId: "stranger@example.com",
      contact: { email: "stranger@example.com" },
    });
  });

  it("in outbound mode, answers only people the agent texted first", async () => {
    const { imsg, bland, state, bridge } = await setup({ answer: "outbound" });
    imsg.emit("message", inbound({ id: 1, sender: "+14155550000" }), 1);
    await bridge.idle();
    expect(bland.relayed).toHaveLength(0);
    const st = state.load();
    st.conversations["+14155551212"] = { conversationId: "conv-out", agentId: AGENT, openedAt: "", outbound: true };
    state.save(st);
    imsg.emit("message", inbound({ id: 2 }), 1);
    await bridge.idle();
    expect(bland.relayed).toHaveLength(1);
    expect(bland.relayed[0]?.id).toBe("conv-out");
  });

  it("ignores texters outside the restriction list when one is set", async () => {
    const { imsg, bland, audit, bridge } = await setup({ answer: "list", allowFrom: ["+14155551212"] });
    imsg.emit("message", inbound({ sender: "+14155550000" }), 1);
    await bridge.idle();
    expect(bland.opened).toEqual([]);
    expect(audit.records.at(-1)).toMatchObject({ event: "skipped", reason: "not_allowed" });
  });

  it("stays out of group chats unless enabled", async () => {
    const { imsg, bland, bridge } = await setup();
    imsg.emit("message", inbound({ is_group: true }), 1);
    await bridge.idle();
    expect(bland.opened).toEqual([]);
  });

  it("pauses when the owner replies from Messages, and does not treat its own sends as the owner", async () => {
    const { imsg, bland, audit, bridge } = await setup();
    imsg.emit("message", inbound({ id: 1 }), 1);
    await bridge.idle();
    // The bridge's own reply shows up as is_from_me with the guid imsg returned.
    imsg.emit("message", inbound({ id: 2, is_from_me: true, guid: "BRIDGE-1", text: "Thanks for texting…" }), 1);
    await bridge.idle();
    expect(audit.records.filter((r) => r.event === "owner_reply")).toHaveLength(0);

    // The owner types a reply themselves.
    imsg.emit("message", inbound({ id: 3, is_from_me: true, guid: "OWNER-1", text: "I'll handle this one" }), 1);
    imsg.emit("message", inbound({ id: 4, text: "great thanks" }), 1);
    await bridge.idle();
    expect(audit.records.filter((r) => r.event === "owner_reply")).toHaveLength(1);
    expect(audit.records.at(-1)).toMatchObject({ event: "skipped", reason: "owner_takeover" });
    expect(bland.relayed).toHaveLength(1);
  });

  it("pauses only for what is left of the window after an older owner message", async () => {
    const { imsg, bland, bridge } = await setup({ ownerTakeoverMinutes: 30 });
    const hoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    // Caught up at startup: the owner texted this person two hours ago.
    imsg.emit("message", inbound({ id: 1, is_from_me: true, guid: "OLD-1", text: "see you", created_at: hoursAgo }), 1);
    imsg.emit("message", inbound({ id: 2, text: "hi" }), 1);
    await bridge.idle();
    expect(bland.relayed).toHaveLength(1);
  });

  it("lifts a pause when the agent reaches out on the owner's word", async () => {
    const ledger = new MemorySentLedger();
    const { imsg, bland, bridge } = await setup({ ownerTakeoverMinutes: 30 }, { ledger });
    imsg.emit("message", inbound({ id: 1, is_from_me: true, guid: "OWNER-1", text: "hey" }), 1);
    // `opencontact text` in another tab: its send is in the shared ledger.
    ledger.add("OUTREACH-1");
    imsg.emit("message", inbound({ id: 2, is_from_me: true, guid: "OUTREACH-1", text: "Hi Sam, Acme here" }), 1);
    imsg.emit("message", inbound({ id: 3, text: "hi" }), 1);
    await bridge.idle();
    expect(bland.relayed).toHaveLength(1);
  });

  it("reopens when Bland says the conversation ended", async () => {
    const { imsg, bland, bridge } = await setup();
    imsg.emit("message", inbound({ id: 1 }), 1);
    await bridge.idle();
    bland.failNextWith = 409;
    imsg.emit("message", inbound({ id: 2, text: "hello again" }), 1);
    await bridge.idle();
    expect(bland.opened).toHaveLength(2);
    expect(bland.relayed.at(-1)).toMatchObject({ id: "conv-2", text: "hello again" });
  });

  it("forgets the conversation once Bland reports it ended", async () => {
    const { imsg, bland, state, bridge } = await setup();
    bland.status = "ended";
    imsg.emit("message", inbound({ id: 1 }), 1);
    await bridge.idle();
    expect(state.load().conversations["+14155551212"]).toBeUndefined();
  });

  it("drops replies past the send cap", async () => {
    const { imsg, bland, audit, bridge } = await setup({ maxSendsPerSenderPerHour: 1 });
    bland.replies = ["one", "two"];
    imsg.emit("message", inbound(), 1);
    await bridge.idle();
    expect(imsg.sent.map((s) => s.text)).toEqual(["one"]);
    expect(audit.records.some((r) => r.event === "rate_limited")).toBe(true);
  });

  it("describes attachment-only inbound so the agent can ask for text", async () => {
    const { imsg, bland, bridge } = await setup();
    imsg.emit("message", inbound({ text: "", attachments: [{ mime_type: "image/heic" }] }), 1);
    await bridge.idle();
    expect(bland.relayed[0]?.text).toMatch(/sent an attachment \(image\/heic\)/);
  });

  it("skips edits, unsends, and duplicates", async () => {
    const { imsg, bland, bridge } = await setup();
    const m = inbound();
    imsg.emit("message", m, 1);
    imsg.emit("message", m, 1);
    imsg.emit("message", inbound({ type: "edited" }), 1);
    await bridge.idle();
    expect(bland.relayed).toHaveLength(1);
  });

  it("resumes from the saved cursor and catches up after an overflow", async () => {
    const imsg = new FakeImsg();
    const bland = new FakeBland();
    const state = new MemoryStateStore();
    state.save({ cursorRowid: 500, conversations: {}, cardSentTo: [] });
    const bridge = new Bridge({
      config: config(),
      imsg: imsg as never,
      brain: new BlandBrain(bland, config(), state, new MemoryAudit(), silentLogger),
      state,
      audit: new MemoryAudit(),
      log: silentLogger,
    });
    await bridge.start();
    expect(imsg.subscriptions[0]).toEqual({ since_rowid: 500 });

    imsg.afterPages.push({ messages: [inbound({ id: 501 })], next_rowid: 501, has_more: false });
    imsg.emit("overflow", { subscription: 1, resume_after_rowid: 500, reason: "buffer" });
    await bridge.idle();
    expect(bland.relayed).toHaveLength(1);
    expect(imsg.subscriptions[1]).toEqual({ since_rowid: 501 });
  });

  it("sends the contact card once, after the first reply, and not in dry-run", async () => {
    const { imsg, state, audit, bridge } = await setup({}, { contactCardPath: "/cards/acme.vcf" });
    imsg.emit("message", inbound({ id: 1 }), 1);
    imsg.emit("message", inbound({ id: 2, text: "and parking?" }), 1);
    await bridge.idle();
    expect(imsg.files).toEqual([{ target: { chat_id: 42 }, file: "/cards/acme.vcf" }]);
    expect(state.load().cardSentTo).toEqual(["+14155551212"]);
    expect(audit.records.filter((r) => r.event === "card_sent")).toHaveLength(1);

    const dry = await setup({ dryRun: true }, { contactCardPath: "/cards/acme.vcf" });
    dry.imsg.emit("message", inbound(), 1);
    await dry.bridge.idle();
    expect(dry.imsg.files).toEqual([]);
    expect(dry.audit.records.some((r) => r.event === "dry_run_card")).toBe(true);
  });

  it("treats guids in the shared ledger as its own sends, not the owner", async () => {
    const ledger = new MemorySentLedger();
    ledger.add("OUT-FROM-OPENCONTACT-TEXT");
    const { imsg, bland, audit, bridge } = await setup({}, { ledger });
    imsg.emit(
      "message",
      inbound({ id: 1, is_from_me: true, guid: "OUT-FROM-OPENCONTACT-TEXT", text: "Hi, Acme here" }),
      1,
    );
    imsg.emit("message", inbound({ id: 2, text: "oh hi" }), 1);
    await bridge.idle();
    expect(audit.records.filter((r) => r.event === "owner_reply")).toHaveLength(0);
    expect(bland.relayed).toHaveLength(1);
  });

  it("continues a conversation that opencontact text opened in another process", async () => {
    const imsg = new FakeImsg();
    const bland = new FakeBland();
    const state = new MemoryStateStore();
    const bridge = new Bridge({
      config: config(),
      imsg: imsg as never,
      brain: new BlandBrain(bland, config(), state, new MemoryAudit(), silentLogger),
      state,
      audit: new MemoryAudit(),
      log: silentLogger,
    });
    await bridge.start();
    // Another process opened the chat after the bridge started.
    state.save({
      cursorRowid: null,
      conversations: { "+14155551212": { conversationId: "conv-outbound", agentId: AGENT, openedAt: "" } },
      cardSentTo: [],
    });
    imsg.emit("message", inbound({ id: 1 }), 1);
    await bridge.idle();
    expect(bland.opened).toHaveLength(0);
    expect(bland.relayed[0]?.id).toBe("conv-outbound");
  });

  it("answers different chats in parallel and never moves the cursor past one still in flight", async () => {
    const imsg = new FakeImsg();
    const state = new MemoryStateStore();
    const order: string[] = [];
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const brain = {
      kind: "command" as const,
      acceptsImages: false,
      async reply(handle: string, text: string) {
        order.push(`start ${text}`);
        if (text === "slow") await slowGate;
        order.push(`end ${text}`);
        return { texts: [`re: ${text}`], conversationId: `c-${handle}`, status: "active" as const };
      },
      async open() {
        return { texts: [], conversationId: "x", status: "active" as const };
      },
      async check() {
        return { ok: true, detail: "" };
      },
    };
    const events: string[] = [];
    const bridge = new Bridge({
      config: config(),
      imsg: imsg as never,
      brain,
      state,
      audit: new MemoryAudit(),
      log: silentLogger,
      events: {
        reply: (e) => events.push(`reply ${e.handle} ${e.text}`),
        thinking: (e) => events.push(`thinking ${e.handle}`),
      },
    });
    await bridge.start();
    imsg.emit("message", inbound({ id: 10, chat_id: 1, chat_guid: "a", sender: "+14155550001", text: "slow" }), 1);
    imsg.emit("message", inbound({ id: 11, chat_id: 2, chat_guid: "b", sender: "+14155550002", text: "fast" }), 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start slow", "start fast", "end fast"]);
    expect(state.load().cursorRowid ?? 0).toBeLessThan(10);
    releaseSlow();
    await bridge.idle();
    expect(state.load().cursorRowid).toBe(11);
    expect(events).toContain("reply +14155550002 re: fast");
    expect(events).toContain("thinking +14155550001");
  });

  it("reports a send from another process as ownSend, not as the owner taking over", async () => {
    const ledger = new MemorySentLedger();
    ledger.add("OTHER-1");
    const seen: string[] = [];
    const imsg = new FakeImsg();
    const state = new MemoryStateStore();
    const bridge = new Bridge({
      config: config(),
      imsg: imsg as never,
      brain: new BlandBrain(new FakeBland(), config(), state, new MemoryAudit(), silentLogger),
      state,
      audit: new MemoryAudit(),
      log: silentLogger,
      sentLedger: ledger,
      events: { ownSend: (e) => seen.push(`${e.handle} ${e.text}`), takeover: () => seen.push("takeover") },
    });
    await bridge.start();
    imsg.emit(
      "message",
      inbound({ id: 1, is_from_me: true, guid: "OTHER-1", participants: ["+14155550134"], text: "Hi Sam" }),
      1,
    );
    await bridge.idle();
    expect(seen).toEqual(["+14155550134 Hi Sam"]);
  });

  it("does not answer texts older than maxAgeMinutes when catching up", async () => {
    const { imsg, bland, audit, bridge } = await setup({ maxAgeMinutes: 15 });
    imsg.emit("message", inbound({ id: 1, created_at: new Date(Date.now() - 60 * 60_000).toISOString() }), 1);
    imsg.emit("message", inbound({ id: 2, created_at: new Date().toISOString(), text: "fresh" }), 1);
    await bridge.idle();
    expect(bland.relayed.map((r) => r.text)).toEqual(["fresh"]);
    expect(audit.records.some((r) => r.event === "skipped" && r.reason === "stale")).toBe(true);
  });

  it("reports the owner's messages only for conversations the agent is in", async () => {
    const imsg = new FakeImsg();
    const state = new MemoryStateStore();
    state.save({
      cursorRowid: null,
      conversations: { "+14155551212": { conversationId: "c", agentId: AGENT, openedAt: "" } },
      cardSentTo: [],
    });
    const notes: string[] = [];
    const bridge = new Bridge({
      config: config(),
      imsg: imsg as never,
      brain: new BlandBrain(new FakeBland(), config(), state, new MemoryAudit(), silentLogger),
      state,
      audit: new MemoryAudit(),
      log: silentLogger,
      events: { takeover: (e) => notes.push(e.handle) },
    });
    await bridge.start();
    const mine = (id: number, to: string, guid: string) =>
      inbound({ id, is_from_me: true, guid, participants: [to], chat_guid: `iMessage;-;${to}`, chat_identifier: to });
    imsg.emit("message", mine(1, "+14155550188", "P1"), 1);
    imsg.emit("message", mine(2, "+14155550188", "P2"), 1);
    imsg.emit("message", mine(3, "+14155551212", "O1"), 1);
    imsg.emit("message", mine(4, "+14155551212", "O2"), 1);
    await bridge.idle();
    // Personal chats never show; every message in an agent conversation does, so the view can show it.
    expect(notes).toEqual(["+14155551212", "+14155551212"]);
  });

  it("refuses to start when the database is not readable", async () => {
    const imsg = new FakeImsg();
    imsg.statusResult = { database: { ready: false, error: "permission denied" } };
    const bridge = new Bridge({
      config: config(),
      imsg: imsg as never,
      brain: new BlandBrain(new FakeBland(), config(), new MemoryStateStore(), new MemoryAudit(), silentLogger),
      state: new MemoryStateStore(),
      audit: new MemoryAudit(),
      log: silentLogger,
    });
    await expect(bridge.start()).rejects.toThrow(/Full Disk Access/);
  });
});
