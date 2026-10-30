import { describe, expect, it } from "vitest";
import { CommandBrain, DEFAULT_PERSONA, LlmBrain, MemoryTranscriptStore } from "../src/brain.ts";

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

describe("LlmBrain (anthropic)", () => {
  it("sends the persona as system, the thread as messages, low effort and default fallbacks, and remembers the turn", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { content: [{ type: "text", text: "We're open till 6 today!" }], stop_reason: "end_turn" },
    }));
    const transcripts = new MemoryTranscriptStore();
    transcripts.append("+14155551212", { role: "user", text: "hi", ts: "" });
    transcripts.append("+14155551212", { role: "assistant", text: "Hi! How can I help?", ts: "" });
    const brain = new LlmBrain({
      kind: "anthropic",
      apiKey: "sk-ant",
      model: "claude-opus-5-5",
      persona: DEFAULT_PERSONA("Acme Dental"),
      transcripts,
      fetch,
    });

    const r = await brain.reply("+14155551212", "are you open today?", "G1");
    expect(r).toMatchObject({ texts: ["We're open till 6 today!"], status: "active" });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant");
    expect(headers["anthropic-version"]).toBe("2026-10-21");
    expect(headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "low" }, fallbacks: "default" });
    expect(body.system).toContain("Acme Dental");
    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "are you open today?" },
    ]);
    expect(
      transcripts
        .recent("+14155551212", 10)
        .map((t) => t.text)
        .slice(-2),
    ).toEqual(["are you open today?", "We're open till 6 today!"]);
  });

  it("enables web search, attaches images on the last user turn, and continues through pause_turn", async () => {
    let round = 0;
    const { fetch, calls } = fakeFetch(() => {
      round += 1;
      if (round === 1)
        return {
          status: 200,
          body: {
            stop_reason: "pause_turn",
            content: [
              { type: "server_tool_use", id: "t1", name: "web_search", input: { query: "acme dental hours" } },
              { type: "web_search_tool_result", tool_use_id: "t1", content: [] },
            ],
          },
        };
      return {
        status: 200,
        body: { stop_reason: "end_turn", content: [{ type: "text", text: "Open till 6 today." }] },
      };
    });
    const brain = new LlmBrain({
      kind: "anthropic",
      apiKey: "k",
      model: "claude-opus-5-5",
      persona: "p",
      transcripts: new MemoryTranscriptStore(),
      fetch,
    });
    const img = { path: "/dev/null", mimeType: "image/png" as const, bytes: 0 };
    const r = await brain.reply("+14155551212", "are you open?", "g", [img]);
    expect(r.texts).toEqual(["Open till 6 today."]);
    expect(calls).toHaveLength(2);
    const first = JSON.parse(String(calls[0]?.init.body));
    expect(first.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 3 }]);
    const lastUser = first.messages[first.messages.length - 1];
    expect(lastUser.role).toBe("user");
    expect(lastUser.content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(lastUser.content[1]).toEqual({ type: "text", text: "are you open?" });
    const second = JSON.parse(String(calls[1]?.init.body));
    expect(second.messages[second.messages.length - 1].role).toBe("assistant");
  });

  it("can turn web search off", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { content: [{ type: "text", text: "ok" }] } }));
    const brain = new LlmBrain({
      kind: "anthropic",
      apiKey: "k",
      model: "m",
      persona: "p",
      transcripts: new MemoryTranscriptStore(),
      fetch,
      webSearch: false,
    });
    await brain.reply("+14155551212", "x", "g");
    expect(JSON.parse(String(calls[0]?.init.body)).tools).toBeUndefined();
  });

  it("returns no reply on a refusal and surfaces API errors", async () => {
    const refusing = fakeFetch(() => ({ status: 200, body: { content: [], stop_reason: "refusal" } }));
    const brain = new LlmBrain({
      kind: "anthropic",
      apiKey: "k",
      model: "m",
      persona: "p",
      transcripts: new MemoryTranscriptStore(),
      fetch: refusing.fetch,
    });
    expect((await brain.reply("+14155551212", "x", "g")).texts).toEqual([]);
    const failing = fakeFetch(() => ({
      status: 401,
      body: { error: { type: "authentication_error", message: "invalid x-api-key" } },
    }));
    const bad = new LlmBrain({
      kind: "anthropic",
      apiKey: "k",
      model: "m",
      persona: "p",
      transcripts: new MemoryTranscriptStore(),
      fetch: failing.fetch,
    });
    await expect(bad.reply("+14155551212", "x", "g")).rejects.toThrow(/anthropic 401: invalid x-api-key/);
  });

  it("writes the opener prompt with context", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { content: [{ type: "text", text: "Hey Sam, Acme here about Thursday." }] },
    }));
    const brain = new LlmBrain({
      kind: "anthropic",
      apiKey: "k",
      model: "m",
      persona: "p",
      transcripts: new MemoryTranscriptStore(),
      fetch,
    });
    const r = await brain.open("+14155551212", "follow up on Thursday");
    expect(r.texts).toEqual(["Hey Sam, Acme here about Thursday."]);
    expect(JSON.parse(String(calls[0]?.init.body)).messages[0].content).toMatch(
      /reaching out first.*Context: follow up on Thursday/,
    );
  });
});

describe("LlmBrain (openai)", () => {
  it("uses chat completions with the persona as the system message, against a custom base URL", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { choices: [{ message: { content: "Sure thing." } }] },
    }));
    const brain = new LlmBrain({
      kind: "openai",
      apiKey: "sk-oai",
      model: "gpt-5",
      baseUrl: "http://localhost:11434/v1/",
      persona: "be brief",
      transcripts: new MemoryTranscriptStore(),
      fetch,
    });
    const r = await brain.reply("a@b.co", "hello", "g");
    expect(r.texts).toEqual(["Sure thing."]);
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer sk-oai");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "gpt-5",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
      ],
    });
  });
});

describe("CommandBrain", () => {
  it("passes attached image paths in the prompt and the environment", async () => {
    const brain = new CommandBrain({
      command: `node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(process.env.OPENCONTACT_ATTACHMENTS+"|"+(s.includes("/tmp/p/one.png")?"inprompt":"no")))'`,
      persona: "p",
      transcripts: new MemoryTranscriptStore(),
    });
    const r = await brain.reply("+14155551212", "look", "g", [
      { path: "/tmp/p/one.png", mimeType: "image/png", bytes: 1 },
    ]);
    expect(r.texts).toEqual(['["/tmp/p/one.png"]|inprompt']);
  });

  it("pipes the composed prompt to the command and takes stdout as the reply", async () => {
    const transcripts = new MemoryTranscriptStore();
    transcripts.append("+14155551212", { role: "user", text: "earlier", ts: "" });
    // The command echoes a marker plus the handle, proving env and stdin both arrived.
    const brain = new CommandBrain({
      command: `node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write("got:"+process.env.OPENCONTACT_HANDLE+":"+(s.includes("New message")?"prompt":"noprompt")+":"+(s.includes("Them: earlier")?"history":"nohistory"))})'`,
      persona: "persona",
      transcripts,
    });
    const r = await brain.reply("+14155551212", "hi there", "g");
    expect(r.texts).toEqual(["got:+14155551212:prompt:history"]);
    expect(transcripts.recent("+14155551212", 10).map((t) => t.role)).toEqual(["user", "user", "assistant"]);
  });
  it("fails clearly on a non-zero exit", async () => {
    const brain = new CommandBrain({
      command: "sh -c 'echo boom >&2; exit 3'",
      persona: "p",
      transcripts: new MemoryTranscriptStore(),
    });
    await expect(brain.reply("+14155551212", "x", "g")).rejects.toThrow(/exited 3: boom/);
  });
  it("reports whether the command exists", async () => {
    expect(
      (await new CommandBrain({ command: "node -e 1", persona: "p", transcripts: new MemoryTranscriptStore() }).check())
        .ok,
    ).toBe(true);
    expect(
      (
        await new CommandBrain({
          command: "definitely-not-a-real-binary --x",
          persona: "p",
          transcripts: new MemoryTranscriptStore(),
        }).check()
      ).ok,
    ).toBe(false);
  });
});

describe("DEFAULT_PERSONA", () => {
  it("carries a description of the business when one is given", () => {
    expect(DEFAULT_PERSONA("Tony's Pizza")).not.toContain("## About");
    expect(DEFAULT_PERSONA("Tony's Pizza", "Open 11 to 10. Large pie $18.")).toContain(
      "## About Tony's Pizza\n\nOpen 11 to 10. Large pie $18.",
    );
  });
});
