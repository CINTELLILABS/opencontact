import { describe, expect, it } from "vitest";
import { BlandApiError, BlandClient } from "../src/bland.ts";

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = handler(u, init ?? {});
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe("BlandClient", () => {
  it("opens a chat with the contact link and unwraps the envelope", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { data: { conversation_id: "c1", status: "active", messages: [] }, errors: null },
    }));
    const c = new BlandClient({ apiUrl: "https://api.test", apiKey: "k", fetch });
    const convo = await c.openChat({
      agentId: "a",
      endUserId: "+14155551212",
      contact: { phone_number: "+14155551212" },
    });
    expect(convo.conversation_id).toBe("c1");
    expect(calls[0]?.url).toBe("https://api.test/v1/chat");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      agent_id: "a",
      end_user_id: "+14155551212",
      contact: { phone_number: "+14155551212" },
    });
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer k");
  });

  it("relays a message with an idempotency key", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: {
        data: {
          conversation_id: "c1",
          status: "active",
          messages: [{ id: "m", role: "agent", text: "hi", created_at: "" }],
        },
      },
    }));
    const c = new BlandClient({ apiUrl: "https://api.test", apiKey: "k", fetch });
    const r = await c.sendMessage("c1", "hello", "G1");
    expect(r.messages[0]?.text).toBe("hi");
    expect(calls[0]?.url).toBe("https://api.test/v1/chat/c1/messages");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ message: "hello", idempotency_key: "G1" });
  });

  it("throws BlandApiError with the envelope's code", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { data: null, errors: [{ error: "CHAT_ENDED", message: "This conversation has ended; open a new one" }] },
    }));
    const c = new BlandClient({ apiUrl: "https://api.test", apiKey: "k", fetch });
    await expect(c.sendMessage("c1", "x", "g")).rejects.toMatchObject({ status: 409, code: "CHAT_ENDED" });
    await expect(c.sendMessage("c1", "x", "g")).rejects.toBeInstanceOf(BlandApiError);
  });
});
