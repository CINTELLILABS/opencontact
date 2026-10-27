/**
 * Client for `imsg rpc`: JSON-RPC 2.0, one object per line, over the child's
 * stdin/stdout. Reference: https://github.com/openclaw/imsg/blob/main/docs/rpc.md
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export interface ImsgAttachment {
  /** Path on disk, often `~/Library/Messages/Attachments/…`. */
  filename?: string | undefined;
  original_path?: string | undefined;
  transfer_name?: string | undefined;
  mime_type?: string | undefined;
  uti?: string | undefined;
  total_bytes?: number | undefined;
  missing?: boolean | undefined;
  is_sticker?: boolean | undefined;
  [key: string]: unknown;
}

/** The Message object imsg emits (docs/json.md). Only the fields the bridge reads are typed strictly. */
export interface ImsgMessage {
  id: number;
  chat_id: number;
  chat_identifier?: string | undefined;
  chat_guid?: string | undefined;
  chat_name?: string | undefined;
  participants?: string[] | undefined;
  is_group: boolean;
  guid: string;
  sender: string;
  sender_name?: string | undefined;
  is_from_me: boolean;
  text: string;
  created_at: string;
  attachments: ImsgAttachment[];
  /** Present only on edits and unsends. */
  type?: "edited" | "unsent" | undefined;
  [key: string]: unknown;
}

/** The Chat object imsg emits (docs/json.md). */
export interface ImsgChat {
  id: number;
  guid?: string | undefined;
  identifier?: string | undefined;
  service?: string | undefined;
  is_group?: boolean | undefined;
  participants?: string[] | undefined;
  account_login?: string | undefined;
  /** The handle on this Mac that the chat was addressed to: our own number or email. */
  last_addressed_handle?: string | undefined;
  [key: string]: unknown;
}

export interface ImsgStatus {
  version?: string;
  protocol_version?: number;
  database?: { path?: string; ready?: boolean; error?: string; [k: string]: unknown };
  methods?: string[];
  supported_methods?: string[];
  [key: string]: unknown;
}

export interface SendResult {
  ok: boolean;
  id?: number;
  guid?: string;
}

export interface WatchOverflow {
  subscription: number;
  resume_after_rowid?: number;
  reason?: string;
}

/** Split a byte stream into complete lines, holding back the trailing partial. */
export class LineFramer {
  private buffer = "";

  push(chunk: string | Buffer): string[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    return parts.map((p) => p.replace(/\r$/, "")).filter((p) => p.length > 0);
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest.length > 0 ? [rest] : [];
  }
}

/** The byte-level side of the child process, so the RPC layer can be tested with a fake. */
export interface RpcTransport {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  onStderr?(cb: (text: string) => void): void;
  close(): void;
}

export function spawnImsg(imsgPath: string, args: string[] = ["rpc"]): RpcTransport {
  const child = spawn(imsgPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  const framer = new LineFramer();
  const lineCbs: Array<(line: string) => void> = [];
  const exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  const errCbs: Array<(text: string) => void> = [];

  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of framer.push(chunk)) for (const cb of lineCbs) cb(line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const cb of errCbs) cb(text);
  });
  child.on("exit", (code, signal) => {
    for (const line of framer.flush()) for (const cb of lineCbs) cb(line);
    for (const cb of exitCbs) cb(code, signal);
  });
  child.on("error", (err) => {
    for (const cb of errCbs) cb(`spawn error: ${err.message}`);
    for (const cb of exitCbs) cb(null, null);
  });

  return {
    write: (line) => {
      if (child.stdin.writable) child.stdin.write(`${line}\n`);
    },
    onLine: (cb) => lineCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    onStderr: (cb) => errCbs.push(cb),
    close: () => {
      // Closing stdin asks imsg to drain and exit on its own.
      child.stdin.end();
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
      }, 3_000).unref();
    },
  };
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ImsgRpcEvents {
  message: [ImsgMessage, number];
  overflow: [WatchOverflow];
  exit: [number | null, string | null];
  stderr: [string];
}

/**
 * JSON-RPC client over a transport. `request()` correlates by id; incoming
 * `message` and `watch.overflow` notifications are re-emitted as events.
 */
export class ImsgRpc extends EventEmitter<ImsgRpcEvents> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly transport: RpcTransport,
    private readonly defaultTimeoutMs = 30_000,
  ) {
    super();
    transport.onLine((line) => this.handleLine(line));
    transport.onExit((code, signal) => {
      this.closed = true;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new RpcError(-32000, `imsg exited before answering request ${id}`));
      }
      this.pending.clear();
      this.emit("exit", code, signal);
    });
    transport.onStderr?.((text) => this.emit("stderr", text));
  }

  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(-32000, "imsg is not running"));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-32000, `imsg did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.transport.write(JSON.stringify(payload));
    });
  }

  /** Parse one stdout line. Public so tests can drive it directly. */
  handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("stderr", `unparseable line from imsg: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;

    if ("id" in m && m.id !== null && m.id !== undefined && ("result" in m || "error" in m)) {
      const id = typeof m.id === "number" ? m.id : Number(m.id);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if ("error" in m && m.error) {
        const e = m.error as { code?: number; message?: string; data?: unknown };
        p.reject(new RpcError(e.code ?? -32603, e.message ?? "imsg error", e.data));
      } else {
        p.resolve(m.result);
      }
      return;
    }

    if (typeof m.method === "string") {
      const params = (m.params ?? {}) as Record<string, unknown>;
      if (m.method === "message" && typeof params.message === "object" && params.message !== null) {
        this.emit("message", params.message as ImsgMessage, Number(params.subscription ?? 0));
      } else if (m.method === "watch.overflow") {
        this.emit("overflow", params as unknown as WatchOverflow);
      }
    }
  }

  status(): Promise<ImsgStatus> {
    return this.request<ImsgStatus>("status");
  }

  chats(limit = 30): Promise<ImsgChat[]> {
    return this.request<{ chats: ImsgChat[] } | ImsgChat[]>("chats.list", { limit }).then((r) =>
      Array.isArray(r) ? r : (r.chats ?? []),
    );
  }

  subscribe(
    opts: { since_rowid?: number; chat_id?: number } = {},
  ): Promise<{ subscription: number; buffer_limit: number }> {
    // imsg debounces filesystem events; 500ms is its default, 100ms is plenty for one line.
    return this.request("watch.subscribe", { ...opts, attachments: true, debounce_ms: 100 });
  }

  unsubscribe(subscription: number): Promise<{ ok: boolean }> {
    return this.request("watch.unsubscribe", { subscription });
  }

  after(since_rowid: number, limit = 200): Promise<{ messages: ImsgMessage[]; next_rowid: number; has_more: boolean }> {
    return this.request("messages.after", { since_rowid, limit, attachments: true });
  }

  /** Send text into an existing chat, or directly to a handle when no chat id is known. */
  send(target: { chat_id: number } | { to: string }, text: string): Promise<SendResult> {
    return this.request<SendResult>("send", { ...target, text, transport: "applescript" }, 60_000);
  }

  /** Send a file (a vCard, an image) with optional text. */
  sendFile(target: { chat_id: number } | { to: string }, file: string, text?: string): Promise<SendResult> {
    return this.request<SendResult>(
      "send",
      { ...target, file, ...(text ? { text } : {}), transport: "applescript" },
      90_000,
    );
  }

  close(): void {
    this.closed = true;
    this.transport.close();
  }
}
