import { describe, expect, it } from "vitest";
import type { ImsgMessage } from "../src/imsg.ts";
import { Allowlist, AnswerPolicy, chatKey, Dedupe, inboundText, RateLimiter, TakeoverTracker } from "../src/policy.ts";
import { MemoryStateStore } from "../src/state.ts";

const base = (over: Partial<ImsgMessage> = {}): ImsgMessage => ({
  id: 1,
  chat_id: 42,
  chat_guid: "iMessage;-;+14155551212",
  is_group: false,
  guid: "G1",
  sender: "+14155551212",
  is_from_me: false,
  text: "hi",
  created_at: "2026-10-26T00:00:00Z",
  attachments: [],
  ...over,
});

describe("Allowlist", () => {
  it("answers everyone when empty", () => {
    const a = new Allowlist([]);
    expect(a.everyone).toBe(true);
    expect(a.allows("+14155551212")).toBe(true);
    expect(a.allows("anyone@example.com")).toBe(true);
  });
  it("restricts to normalized spellings when set", () => {
    const a = new Allowlist(["(415) 555-1212", "Owner@Example.com"]);
    expect(a.everyone).toBe(false);
    expect(a.allows("+14155551212")).toBe(true);
    expect(a.allows("owner@example.com")).toBe(true);
    expect(a.allows("+14155550000")).toBe(false);
  });
});

describe("AnswerPolicy", () => {
  it("everyone answers anyone; list answers only the list and nobody when empty; outbound keys on state", () => {
    const state = new MemoryStateStore();
    expect(new AnswerPolicy("everyone", [], state).allows("+14155550000")).toBe(true);
    expect(new AnswerPolicy("list", ["+14155551212"], state).allows("+14155551212")).toBe(true);
    expect(new AnswerPolicy("list", ["+14155551212"], state).allows("+14155550000")).toBe(false);
    expect(new AnswerPolicy("list", [], state).allows("+14155551212")).toBe(false);
    const out = new AnswerPolicy("outbound", [], state);
    expect(out.allows("+14155551212")).toBe(false);
    state.save({
      cursorRowid: null,
      conversations: { "+14155551212": { conversationId: "c", agentId: "a", openedAt: "", outbound: true } },
      cardSentTo: [],
    });
    expect(out.allows("(415) 555-1212")).toBe(true);
    expect(out.describe()).toMatch(/texted first/);
  });
});

describe("RateLimiter", () => {
  it("enforces per-sender then global caps within the hour", () => {
    let t = 0;
    const rl = new RateLimiter({ perHour: 3, perSenderPerHour: 2 }, () => t);
    expect(rl.take("a")).toEqual({ ok: true });
    expect(rl.take("a")).toEqual({ ok: true });
    expect(rl.take("a")).toEqual({ ok: false, scope: "sender" });
    expect(rl.take("b")).toEqual({ ok: true });
    expect(rl.take("c")).toEqual({ ok: false, scope: "global" });
    t = 61 * 60 * 1000;
    expect(rl.take("a")).toEqual({ ok: true });
  });
  it("a cap of zero disables that cap", () => {
    const rl = new RateLimiter({ perHour: 0, perSenderPerHour: 0 });
    for (let i = 0; i < 100; i++) expect(rl.take("a").ok).toBe(true);
  });
});

describe("TakeoverTracker", () => {
  it("pauses a chat after the owner replies and expires", () => {
    let t = 0;
    const tk = new TakeoverTracker(30, () => t);
    expect(tk.isPaused("c")).toBe(false);
    tk.ownerReplied("c");
    expect(tk.isPaused("c")).toBe(true);
    t = 29 * 60 * 1000;
    expect(tk.isPaused("c")).toBe(true);
    t = 31 * 60 * 1000;
    expect(tk.isPaused("c")).toBe(false);
  });
  it("does not pause when minutes is zero", () => {
    const tk = new TakeoverTracker(0);
    tk.ownerReplied("c");
    expect(tk.isPaused("c")).toBe(false);
  });
  it("tracks the bridge's own guids with a bound", () => {
    const tk = new TakeoverTracker(30, () => 0, 2);
    tk.markBridgeSent("a");
    tk.markBridgeSent("b");
    tk.markBridgeSent("c");
    expect(tk.isBridgeSent("a")).toBe(false);
    expect(tk.isBridgeSent("c")).toBe(true);
  });
});

describe("Dedupe", () => {
  it("returns true once per guid", () => {
    const d = new Dedupe(2);
    expect(d.first("a")).toBe(true);
    expect(d.first("a")).toBe(false);
    d.first("b");
    d.first("c");
    expect(d.first("a")).toBe(true); // evicted
  });
});

describe("inboundText", () => {
  it("passes plain text through and strips the attachment placeholder", () => {
    expect(inboundText(base({ text: "￼hello " }), "describe")).toBe("hello");
  });
  it("drops empty messages", () => {
    expect(inboundText(base({ text: "   " }), "describe")).toBeNull();
  });
  it("describes attachment-only messages", () => {
    const t = inboundText(base({ text: "", attachments: [{ mime_type: "image/jpeg" }] }), "describe");
    expect(t).toMatch(/sent an attachment \(image\/jpeg\)/);
  });
  it("tells an image-capable brain that the image is attached instead of apologizing", () => {
    expect(inboundText(base({ text: "", attachments: [{ mime_type: "image/jpeg" }] }), "describe", 1)).toBe(
      "[An image is attached to this message.]",
    );
    expect(
      inboundText(base({ text: "this one?", attachments: [{ mime_type: "image/jpeg" }, {}] }), "describe", 2),
    ).toMatch(/this one\?\n\n\[2 images are attached/);
  });
  it("ignores attachments when configured", () => {
    expect(inboundText(base({ text: "", attachments: [{ mime_type: "image/jpeg" }] }), "ignore")).toBeNull();
    expect(inboundText(base({ text: "look", attachments: [{ mime_type: "image/jpeg" }] }), "ignore")).toBe("look");
  });
});

describe("chatKey", () => {
  it("prefers the guid", () => {
    expect(chatKey(base())).toBe("iMessage;-;+14155551212");
    expect(chatKey(base({ chat_guid: undefined }))).toBe("chat:42");
  });
});
