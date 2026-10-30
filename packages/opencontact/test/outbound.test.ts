import { describe, expect, it } from "vitest";
import { MemoryAudit } from "../src/audit.ts";
import type { BlandApi, ChatConversation, OpenChatInput } from "../src/bland.ts";
import { BlandBrain } from "../src/brain.ts";
import type { BridgeConfig } from "../src/config.ts";
import { MemorySentLedger } from "../src/ledger.ts";
import { silentLogger } from "../src/log.ts";
import { startOutbound } from "../src/outbound.ts";
import { MemoryStateStore } from "../src/state.ts";

const AGENT = "11111111-1111-4111-8111-111111111111";
const config: BridgeConfig = {
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
};

function convo(id: string, messages: ChatConversation["messages"] = []): ChatConversation {
  return {
    conversation_id: id,
    agent_id: AGENT,
    end_user_id: "x",
    status: "active",
    ended: false,
    created_at: null,
    summary: null,
    disposition: null,
    variables: null,
    metadata: null,
    messages,
  };
}

describe("startOutbound", () => {
  it("opens a fresh conversation with the context, asks for the opener, sends it, and records state", async () => {
    const opened: OpenChatInput[] = [];
    const relayed: Array<{ id: string; text: string }> = [];
    const bland: BlandApi = {
      async me() {
        return {};
      },
      async openChat(input) {
        opened.push(input);
        return convo("c9");
      },
      async sendMessage(id, text) {
        relayed.push({ id, text });
        return convo(id, [
          { id: "m1", role: "agent", text: "Hi Sam, this is Acme Dental following up on Thursday.", created_at: "" },
        ]);
      },
    };
    const sent: Array<{ target: unknown; text: string }> = [];
    const files: Array<{ target: unknown; file: string }> = [];
    const imsg = {
      async send(target: unknown, text: string) {
        sent.push({ target, text });
        return { ok: true, guid: "OUT-1" };
      },
      async sendFile(target: unknown, file: string) {
        files.push({ target, file });
        return { ok: true, guid: "CARD-1" };
      },
    };
    const state = new MemoryStateStore();
    const ledger = new MemorySentLedger();
    const audit = new MemoryAudit();

    const brain = new BlandBrain(bland, config, state, audit, silentLogger);
    const r = await startOutbound(
      {
        config,
        brain,
        imsg: imsg as never,
        state,
        audit,
        log: silentLogger,
        sentLedger: ledger,
        contactCardPath: "/cards/acme.vcf",
      },
      "(415) 555-1212",
      "follow up on Thursday's quote",
    );

    expect(opened[0]).toMatchObject({
      endUserId: "+14155551212",
      contact: { phone_number: "+14155551212" },
      requestData: { outreach_context: "follow up on Thursday's quote" },
      newConversation: true,
    });
    expect(relayed).toEqual([{ id: "c9", text: "" }]);
    expect(sent).toEqual([
      { target: { to: "+14155551212" }, text: "Hi Sam, this is Acme Dental following up on Thursday." },
    ]);
    expect(ledger.has("OUT-1")).toBe(true);
    expect(state.load().conversations["+14155551212"]?.conversationId).toBe("c9");
    expect(r.sent).toHaveLength(1);
    expect(r.cardSent).toBe(true);
    expect(files).toEqual([{ target: { to: "+14155551212" }, file: "/cards/acme.vcf" }]);
    expect(ledger.has("CARD-1")).toBe(true);
    expect(state.load().cardSentTo).toEqual(["+14155551212"]);
    expect(state.load().conversations["+14155551212"]?.outbound).toBe(true);
    expect(r.cardAlreadySent).toBe(false);

    // A second outbound to the same number keeps the card unless asked to resend.
    const again = await startOutbound(
      {
        config,
        brain,
        imsg: imsg as never,
        state,
        audit,
        log: silentLogger,
        sentLedger: ledger,
        contactCardPath: "/cards/acme.vcf",
      },
      "+14155551212",
    );
    expect(again.cardSent).toBe(false);
    expect(again.cardAlreadySent).toBe(true);

    // A name rides along on the contact, so the agent greets the right person.
    await startOutbound(
      { config, brain, imsg: imsg as never, state, audit, log: silentLogger, name: "Kyle" },
      "+14155551212",
      "The recipient's name is Kyle.",
    );
    expect(opened.at(-1)?.contact).toEqual({ phone_number: "+14155551212", name: "Kyle" });
    expect(state.load().conversations["+14155551212"]?.name).toBe("Kyle");
    const forced = await startOutbound(
      {
        config,
        brain,
        imsg: imsg as never,
        state,
        audit,
        log: silentLogger,
        sentLedger: ledger,
        contactCardPath: "/cards/acme.vcf",
        resendCard: true,
      },
      "+14155551212",
    );
    expect(forced.cardSent).toBe(true);
    expect(audit.records.map((r) => r.event).slice(-2)).toEqual(["outbound", "card_sent"]);
    expect(opened[0]).toMatchObject({ metadata: { channel: "opencontact", outbound: true } });
  });

  it("rejects handles that are not a phone or email", async () => {
    const bland = {
      me: async () => ({}),
      openChat: async () => convo("c"),
      sendMessage: async () => convo("c"),
    } as BlandApi;
    const brain = new BlandBrain(bland, config, new MemoryStateStore(), new MemoryAudit(), silentLogger);
    await expect(
      startOutbound(
        {
          config,
          brain,
          imsg: { send: async () => ({ ok: true }), sendFile: async () => ({ ok: true }) } as never,
          state: new MemoryStateStore(),
          audit: new MemoryAudit(),
          log: silentLogger,
        },
        "bob",
      ),
    ).rejects.toThrow(/not a phone number or email/);
  });

  it("fails clearly when the agent produces no opener", async () => {
    const bland = {
      me: async () => ({}),
      openChat: async () => convo("c"),
      sendMessage: async () => ({ ...convo("c"), status: "human_handoff" as const }),
    } as BlandApi;
    const brain = new BlandBrain(bland, config, new MemoryStateStore(), new MemoryAudit(), silentLogger);
    await expect(
      startOutbound(
        {
          config,
          brain,
          imsg: { send: async () => ({ ok: true }), sendFile: async () => ({ ok: true }) } as never,
          state: new MemoryStateStore(),
          audit: new MemoryAudit(),
          log: silentLogger,
        },
        "+14155551212",
      ),
    ).rejects.toThrow(/no opener/);
  });
});
