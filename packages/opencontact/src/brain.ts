/**
 * The brain is whatever answers a text. Four kinds:
 *
 *   bland      Bland's hosted agent (default). Built from your website, memory
 *              per contact, scenarios, handoff, the dashboard, and the path to
 *              a real number with RCS and iMessage branding.
 *   anthropic  Your own Anthropic key, a persona file, a transcript per contact.
 *   openai     Same, against OpenAI or any OpenAI-compatible endpoint.
 *   command    Any local program: the prompt on stdin, the reply on stdout.
 *
 * The Bland brain is the product; the others are the open door. They get a
 * persona and memory of the thread, nothing more.
 *
 * Raw HTTP, not the vendor SDKs: this package ships with zero runtime
 * dependencies on purpose (see AGENTS.md). Request shapes come from the
 * vendors' published HTTP references.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type InboundImage, imageBase64 } from "./attachments.ts";
import type { AuditSink } from "./audit.ts";
import { type BlandApi, BlandApiError, type ChatConversation } from "./bland.ts";
import type { BridgeConfig } from "./config.ts";
import { isEmailHandle, isPhoneHandle, maskHandle } from "./handles.ts";
import type { Logger } from "./log.ts";
import type { ConversationRef, StateStore } from "./state.ts";

export type BrainStatus = "active" | "ended" | "human_handoff";

export interface BrainReply {
  texts: string[];
  conversationId: string;
  status: BrainStatus;
  error?: string | undefined;
}

export interface Brain {
  readonly kind: BridgeConfig["brain"]["kind"];
  /** Whether images in a text reach the model, or only a note that one arrived. */
  readonly acceptsImages: boolean;
  /** Answer one inbound text from `handle`. `guid` is the idempotency key. */
  reply(handle: string, text: string, guid: string, images?: InboundImage[]): Promise<BrainReply>;
  /** Speak first. `context` is why we are reaching out. */
  /** `name` is who we are texting, when we know it; Bland files it on the contact. */
  open(handle: string, context?: string, name?: string): Promise<BrainReply>;
  /** Cheap credential or availability check for `doctor`. */
  check(): Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------------------
// Bland

export class BlandBrain implements Brain {
  readonly kind = "bland" as const;
  readonly acceptsImages = false;

  constructor(
    private readonly bland: BlandApi,
    private readonly config: BridgeConfig,
    private readonly state: StateStore,
    private readonly audit: AuditSink,
    private readonly log: Logger,
  ) {}

  async reply(handle: string, text: string, guid: string): Promise<BrainReply> {
    let ref = this.lookup(handle);
    if (!ref || ref.agentId !== this.config.agentId) ref = await this.openConversation(handle);
    let convo: ChatConversation;
    try {
      convo = await this.bland.sendMessage(ref.conversationId, text, guid);
    } catch (err) {
      // 409 is "this conversation has ended; open a new one"; 404 means it is gone. Open and retry once.
      if (err instanceof BlandApiError && (err.status === 409 || err.status === 404)) {
        this.log.info("conversation closed; opening a new one", { sender: maskHandle(handle), reason: err.code });
        this.audit.write({ event: "error", where: "sendMessage", error: `${err.status} ${err.code}` });
        ref = await this.openConversation(handle);
        convo = await this.bland.sendMessage(ref.conversationId, text, guid);
      } else throw err;
    }
    if (convo.ended) this.forget(handle);
    return {
      texts: convo.messages.filter((m) => m.role === "agent").map((m) => m.text),
      conversationId: convo.conversation_id,
      status: toBrainStatus(convo.status),
      error: convo.error,
    };
  }

  async open(handle: string, context?: string, name?: string): Promise<BrainReply> {
    const contact = contactFor(handle);
    // Bland takes a name of 1 to 200 characters.
    const label = name?.trim().slice(0, 200);
    if (contact && label) contact.name = label;
    const convo = await this.bland.openChat({
      agentId: this.config.agentId,
      endUserId: handle,
      ...(contact ? { contact } : {}),
      metadata: { channel: "opencontact", outbound: true },
      ...(context ? { requestData: { outreach_context: context } } : {}),
      newConversation: true,
    });
    this.remember(handle, {
      conversationId: convo.conversation_id,
      agentId: this.config.agentId,
      openedAt: new Date().toISOString(),
    });
    // An empty message asks the agent to speak first.
    const turn = await this.bland.sendMessage(convo.conversation_id, "", `outbound-${convo.conversation_id}`);
    return {
      texts: turn.messages.filter((m) => m.role === "agent").map((m) => m.text),
      conversationId: convo.conversation_id,
      status: toBrainStatus(turn.status),
      error: turn.error,
    };
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.bland.me();
      return { ok: true, detail: `${this.config.apiUrl} accepted the key · agent ${this.config.agentId}` };
    } catch (err) {
      return { ok: false, detail: err instanceof BlandApiError ? `${err.status} ${err.code}` : (err as Error).message };
    }
  }

  private async openConversation(handle: string): Promise<ConversationRef> {
    const contact = contactFor(handle);
    const convo = await this.bland.openChat({
      agentId: this.config.agentId,
      endUserId: handle,
      ...(contact ? { contact } : {}),
      metadata: { channel: "opencontact" },
    });
    const ref = {
      conversationId: convo.conversation_id,
      agentId: this.config.agentId,
      openedAt: new Date().toISOString(),
    };
    this.remember(handle, ref);
    this.audit.write({ event: "chat_opened", sender: maskHandle(handle), conversation_id: convo.conversation_id });
    this.log.info("opened conversation", { sender: maskHandle(handle), conversation_id: convo.conversation_id });
    return ref;
  }

  private lookup(handle: string): ConversationRef | undefined {
    return this.state.load().conversations[handle];
  }
  private remember(handle: string, ref: ConversationRef): void {
    const fresh = this.state.load();
    fresh.conversations[handle] = ref;
    this.state.save(fresh);
  }
  private forget(handle: string): void {
    const fresh = this.state.load();
    delete fresh.conversations[handle];
    this.state.save(fresh);
  }
}

/** Bland's "timeout" is an ended conversation as far as the bridge cares. */
function toBrainStatus(status: "active" | "ended" | "timeout" | "human_handoff"): BrainStatus {
  return status === "timeout" ? "ended" : status;
}

function contactFor(handle: string): { phone_number?: string; email?: string; name?: string } | undefined {
  if (isPhoneHandle(handle)) return { phone_number: handle };
  if (isEmailHandle(handle)) return { email: handle };
  return undefined;
}

// ---------------------------------------------------------------------------
// Persona + transcript, shared by the BYO brains

export const DEFAULT_PERSONA = (name: string) => `# Persona

You answer text messages on behalf of ${name}. You are texting, so keep replies short: one to three
sentences, warm, specific, no bullet points, no markdown. Match the other person's tone. If you do not
know something, say so and offer to find out rather than guessing. Never invent prices, availability,
or commitments. If someone asks for a human, say you will pass it along and stop selling.
`;

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  ts: string;
}

export interface TranscriptStore {
  recent(handle: string, limit: number): TranscriptTurn[];
  append(handle: string, turn: TranscriptTurn): void;
}

/** One JSONL file per contact under `<stateDir>/transcripts/`. */
export class FileTranscriptStore implements TranscriptStore {
  constructor(private readonly dir: string) {}

  private pathFor(handle: string): string {
    return join(this.dir, `${handle.replace(/[^A-Za-z0-9@._+-]/g, "_")}.jsonl`);
  }

  recent(handle: string, limit: number): TranscriptTurn[] {
    const path = this.pathFor(handle);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    return lines.slice(-limit).map((l) => JSON.parse(l) as TranscriptTurn);
  }

  append(handle: string, turn: TranscriptTurn): void {
    const path = this.pathFor(handle);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(turn)}\n`, { mode: 0o600 });
  }

  /** Drop everything kept for this contact. */
  forget(handle: string): boolean {
    const path = this.pathFor(handle);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }
}

export class MemoryTranscriptStore implements TranscriptStore {
  readonly turns = new Map<string, TranscriptTurn[]>();
  recent(handle: string, limit: number): TranscriptTurn[] {
    return (this.turns.get(handle) ?? []).slice(-limit);
  }
  append(handle: string, turn: TranscriptTurn): void {
    this.turns.set(handle, [...(this.turns.get(handle) ?? []), turn]);
  }
}

/** Read the persona file, writing the default first if it does not exist. */
export function loadPersona(path: string, name: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, DEFAULT_PERSONA(name), { mode: 0o600 });
  }
  return readFileSync(path, "utf8");
}

const HISTORY_TURNS = 40;

function openerPrompt(context?: string): string {
  return `[You are reaching out first.${context ? ` Context: ${context}` : ""} Write the opening text message, and only the message.]`;
}

// ---------------------------------------------------------------------------
// Anthropic / OpenAI over HTTP

export interface LlmBrainOptions {
  kind: "anthropic" | "openai";
  apiKey: string;
  model: string;
  /** Anthropic only: output_config.effort. Chat does well at "low". */
  effort?: string | undefined;
  /** OpenAI only: base URL for OpenAI-compatible servers. */
  baseUrl?: string | undefined;
  /** Anthropic only: let the model search the web (server-side tool). Default true. */
  webSearch?: boolean | undefined;
  persona: string;
  transcripts: TranscriptStore;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class LlmBrain implements Brain {
  readonly kind: "anthropic" | "openai";
  readonly acceptsImages = true;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: LlmBrainOptions) {
    this.kind = opts.kind;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async reply(handle: string, text: string, _guid?: string, images: InboundImage[] = []): Promise<BrainReply> {
    const history = this.opts.transcripts.recent(handle, HISTORY_TURNS);
    const answer = await this.complete([...history, { role: "user", text, ts: now() }], images);
    this.opts.transcripts.append(handle, { role: "user", text, ts: now() });
    if (answer) this.opts.transcripts.append(handle, { role: "assistant", text: answer, ts: now() });
    return { texts: answer ? [answer] : [], conversationId: `${this.kind}:${handle}`, status: "active" };
  }

  async open(handle: string, context?: string): Promise<BrainReply> {
    const history = this.opts.transcripts.recent(handle, HISTORY_TURNS);
    const answer = await this.complete([...history, { role: "user", text: openerPrompt(context), ts: now() }]);
    if (answer) this.opts.transcripts.append(handle, { role: "assistant", text: answer, ts: now() });
    return { texts: answer ? [answer] : [], conversationId: `${this.kind}:${handle}`, status: "active" };
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    const url = this.kind === "anthropic" ? "https://api.anthropic.com/v1/models?limit=1" : `${this.baseUrl()}/models`;
    try {
      const res = await this.fetchImpl(url, { headers: this.headers() });
      return res.ok
        ? { ok: true, detail: `${this.kind} accepted the key · model ${this.opts.model}` }
        : { ok: false, detail: `${this.kind} returned ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  private baseUrl(): string {
    return (this.opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return this.kind === "anthropic"
      ? {
          "content-type": "application/json",
          "x-api-key": this.opts.apiKey,
          "anthropic-version": "2026-10-21",
          "anthropic-beta": "server-side-fallback-2026-07-01",
        }
      : { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` };
  }

  /** One completion over the persona and the thread; returns the reply text or "" when the model declined. */
  private async complete(turns: TranscriptTurn[], images: InboundImage[] = []): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 120_000);
    timer.unref?.();
    try {
      if (this.kind === "anthropic") return await this.completeAnthropic(turns, images, controller.signal);
      return await this.completeOpenAi(turns, images, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Messages API with the thread as alternating turns, images on the last
   * user turn, and the server-side web search tool. Web search can pause the
   * turn (`stop_reason: "pause_turn"`); the response content is appended and
   * the request repeated until the model finishes, a few times at most.
   */
  private async completeAnthropic(
    turns: TranscriptTurn[],
    images: InboundImage[],
    signal: AbortSignal,
  ): Promise<string> {
    type Block = { type: string; text?: string; [k: string]: unknown };
    const messages: Array<{ role: "user" | "assistant"; content: string | Block[] }> = turns.map((t) => ({
      role: t.role,
      content: t.text,
    }));
    const last = messages[messages.length - 1];
    if (last && last.role === "user" && images.length > 0) {
      last.content = [
        ...images.map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.mimeType, data: imageBase64(img) },
        })),
        { type: "text", text: typeof last.content === "string" ? last.content : "" },
      ];
    }
    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: 2048,
      system: this.opts.persona,
      messages,
      output_config: { effort: this.opts.effort ?? "low" },
      fallbacks: "default",
    };
    if (this.opts.webSearch !== false) body.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }];

    const texts: string[] = [];
    for (let round = 0; round < 4; round++) {
      const res = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
      const data = (await res.json()) as { content?: Block[]; stop_reason?: string; error?: { message?: string } };
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${data.error?.message ?? "request failed"}`);
      if (data.stop_reason === "refusal") return "";
      const content = data.content ?? [];
      for (const b of content) if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      if (data.stop_reason !== "pause_turn") break;
      // Continue the same turn: the assistant content so far goes back as-is.
      messages.push({ role: "assistant", content });
      body.messages = messages;
    }
    return texts.join("\n").trim();
  }

  private async completeOpenAi(turns: TranscriptTurn[], images: InboundImage[], signal: AbortSignal): Promise<string> {
    type Part = { type: string; [k: string]: unknown };
    const messages: Array<{ role: string; content: string | Part[] }> = [
      { role: "system", content: this.opts.persona },
      ...turns.map((t) => ({ role: t.role, content: t.text })),
    ];
    const last = messages[messages.length - 1];
    if (last && last.role === "user" && images.length > 0) {
      last.content = [
        { type: "text", text: typeof last.content === "string" ? last.content : "" },
        ...images.map((img) => ({
          type: "image_url",
          image_url: { url: `data:${img.mimeType};base64,${imageBase64(img)}` },
        })),
      ];
    }
    const res = await this.fetchImpl(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: this.opts.model, messages }),
      signal,
    });
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(`openai ${res.status}: ${body.error?.message ?? "request failed"}`);
    return (body.choices?.[0]?.message?.content ?? "").trim();
  }
}

// ---------------------------------------------------------------------------
// Any local program

export interface CommandBrainOptions {
  /** Run through `sh -c`, so quoting works the way it does in a terminal. */
  command: string;
  persona: string;
  transcripts: TranscriptStore;
  timeoutMs?: number;
}

/**
 * The prompt goes to stdin as plain text (persona, the thread, the new
 * message, an instruction to answer with only the reply). The program's
 * stdout, trimmed, is the reply. Environment: OPENCONTACT_HANDLE, OPENCONTACT_TEXT,
 * OPENCONTACT_PERSONA, OPENCONTACT_TRANSCRIPT_JSON for programs that want structure.
 */
export class CommandBrain implements Brain {
  readonly kind = "command" as const;
  readonly acceptsImages = true;

  constructor(private readonly opts: CommandBrainOptions) {}

  async reply(handle: string, text: string, _guid?: string, images: InboundImage[] = []): Promise<BrainReply> {
    const history = this.opts.transcripts.recent(handle, HISTORY_TURNS);
    const answer = await this.run(handle, text, history, images);
    this.opts.transcripts.append(handle, { role: "user", text, ts: now() });
    if (answer) this.opts.transcripts.append(handle, { role: "assistant", text: answer, ts: now() });
    return { texts: answer ? [answer] : [], conversationId: `command:${handle}`, status: "active" };
  }

  async open(handle: string, context?: string): Promise<BrainReply> {
    const history = this.opts.transcripts.recent(handle, HISTORY_TURNS);
    const answer = await this.run(handle, openerPrompt(context), history);
    if (answer) this.opts.transcripts.append(handle, { role: "assistant", text: answer, ts: now() });
    return { texts: answer ? [answer] : [], conversationId: `command:${handle}`, status: "active" };
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    const first = this.opts.command.trim().split(/\s+/)[0] ?? "";
    const found = await new Promise<boolean>((resolve) => {
      const p = spawn("sh", ["-c", `command -v ${JSON.stringify(first)}`], { stdio: "ignore" });
      p.on("exit", (code) => resolve(code === 0));
      p.on("error", () => resolve(false));
    });
    return found ? { ok: true, detail: this.opts.command } : { ok: false, detail: `${first} not found on PATH` };
  }

  composePrompt(text: string, history: TranscriptTurn[], images: InboundImage[] = []): string {
    const thread = history.map((t) => `${t.role === "user" ? "Them" : "You"}: ${t.text}`).join("\n");
    const files =
      images.length > 0
        ? `\nAttached images (view them with your file tools before answering): ${images.map((i) => i.path).join(", ")}\n`
        : "";
    return `${this.opts.persona.trim()}\n\n--- Conversation so far ---\n${thread || "(none)"}\n\n--- New message ---\nThem: ${text}\n${files}\nReply with only the text message to send back. No preamble, no quotes.\n`;
  }

  private run(handle: string, text: string, history: TranscriptTurn[], images: InboundImage[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      // CLAUDECODE marks a nested Claude Code session and makes `claude -p` refuse to run; the brain is not nested.
      const { CLAUDECODE: _nested, ...env } = process.env;
      const child = spawn("sh", ["-c", this.opts.command], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...env,
          OPENCONTACT_HANDLE: handle,
          OPENCONTACT_TEXT: text,
          OPENCONTACT_PERSONA: this.opts.persona,
          OPENCONTACT_TRANSCRIPT_JSON: JSON.stringify(history),
          OPENCONTACT_ATTACHMENTS: JSON.stringify(images.map((i) => i.path)),
        },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGTERM"), this.opts.timeoutMs ?? 120_000);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(new Error(`command exited ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`));
        resolve(out.trim());
      });
      child.stdin.end(this.composePrompt(text, history, images));
    });
  }
}

/** Models an Ollama server offers, or null when none is listening. */
export async function detectOllama(
  baseUrl = "http://127.0.0.1:11434",
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string");
  } catch {
    return null;
  }
}

function now(): string {
  return new Date().toISOString();
}
