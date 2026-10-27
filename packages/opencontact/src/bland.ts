/**
 * The two Bland endpoints the bridge needs, both part of "API chat": a
 * customer-run chat surface on the messaging pipeline. See docs/bland-api.md.
 */

export type ChatStatus = "active" | "ended" | "timeout" | "human_handoff";

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "human";
  text: string;
  created_at: string;
}

export interface ChatConversation {
  conversation_id: string;
  agent_id: string | null;
  end_user_id: string;
  status: ChatStatus;
  ended: boolean;
  created_at: string | null;
  summary: string | null;
  disposition: string | null;
  variables: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  messages: ChatMessage[];
  /** Set when the turn ran but the pipeline reported a problem. */
  error?: string;
}

export interface OpenChatInput {
  agentId: string;
  endUserId: string;
  contact?: { phone_number?: string; email?: string; name?: string };
  metadata?: Record<string, unknown>;
  requestData?: Record<string, unknown>;
  /** End any open conversation for this end user first. */
  newConversation?: boolean;
}

export class BlandApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BlandApiError";
  }
}

export interface BlandClientOptions {
  apiUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  updatedAt?: string | undefined;
}

export interface GeneratedAgent {
  agent_id: string;
  version_id: string;
  name: string;
  summary: string;
  scenarios: unknown[];
  website: string;
}

export interface BlandApi {
  me(): Promise<Record<string, unknown>>;
  openChat(input: OpenChatInput): Promise<ChatConversation>;
  sendMessage(conversationId: string, text: string, idempotencyKey: string): Promise<ChatConversation>;
}

export class BlandClient implements BlandApi {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(private readonly opts: BlandClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.userAgent = opts.userAgent ?? "opencontact";
  }

  async me(): Promise<Record<string, unknown>> {
    return (await this.call("GET", "/v1/me")) as Record<string, unknown>;
  }

  /** The org's v2 agents, most recently updated first. */
  async listAgents(): Promise<AgentSummary[]> {
    const data = await this.call("GET", "/v2/agents");
    const rows = Array.isArray(data) ? data : [];
    return rows
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => ({
        id: String(r.id ?? r.agent_id ?? ""),
        name: String(r.name ?? "(unnamed)"),
        updatedAt:
          typeof r.updatedAt === "string" ? r.updatedAt : typeof r.updated_at === "string" ? r.updated_at : undefined,
      }))
      .filter((r) => r.id.length > 0);
  }

  /** Read a website and publish an agent for it. Takes up to a minute or two. */
  async generateAgent(website: string, requestId: string): Promise<GeneratedAgent> {
    return (await this.call(
      "POST",
      "/v2/agents/generate",
      { website, request_id: requestId },
      240_000,
    )) as GeneratedAgent;
  }

  async openChat(input: OpenChatInput): Promise<ChatConversation> {
    const body: Record<string, unknown> = {
      agent_id: input.agentId,
      end_user_id: input.endUserId,
    };
    if (input.contact) body.contact = input.contact;
    if (input.metadata) body.metadata = input.metadata;
    if (input.requestData) body.request_data = input.requestData;
    if (input.newConversation) body.new_conversation = true;
    return (await this.call("POST", "/v1/chat", body)) as ChatConversation;
  }

  async sendMessage(conversationId: string, text: string, idempotencyKey: string): Promise<ChatConversation> {
    return (await this.call("POST", `/v1/chat/${encodeURIComponent(conversationId)}/messages`, {
      message: text,
      idempotency_key: idempotencyKey,
    })) as ChatConversation;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": this.userAgent,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new BlandApiError(0, "NETWORK", `request to ${path} failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    const envelope = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
      data?: unknown;
      errors?: Array<{ error?: string; message?: string }> | null;
    };

    if (!res.ok) {
      const first = envelope.errors?.[0];
      throw new BlandApiError(
        res.status,
        first?.error ?? `HTTP_${res.status}`,
        first?.message ?? `${method} ${path} returned ${res.status}`,
      );
    }
    return envelope.data !== undefined ? envelope.data : parsed;
  }
}
