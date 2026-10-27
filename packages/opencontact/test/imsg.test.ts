import { describe, expect, it } from "vitest";
import { ImsgRpc, LineFramer, RpcError, type RpcTransport } from "../src/imsg.ts";

class FakeTransport implements RpcTransport {
  written: string[] = [];
  private lineCbs: Array<(l: string) => void> = [];
  private exitCbs: Array<(c: number | null, s: string | null) => void> = [];
  write(line: string) {
    this.written.push(line);
  }
  onLine(cb: (l: string) => void) {
    this.lineCbs.push(cb);
  }
  onExit(cb: (c: number | null, s: string | null) => void) {
    this.exitCbs.push(cb);
  }
  close() {}
  feed(obj: unknown) {
    for (const cb of this.lineCbs) cb(JSON.stringify(obj));
  }
  exit() {
    for (const cb of this.exitCbs) cb(0, null);
  }
}

describe("LineFramer", () => {
  it("reassembles lines across chunks", () => {
    const f = new LineFramer();
    expect(f.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(f.push(":2}\r\n\n")).toEqual(['{"b":2}']);
    expect(f.flush()).toEqual([]);
    f.push("tail");
    expect(f.flush()).toEqual(["tail"]);
  });
});

describe("ImsgRpc", () => {
  it("correlates responses by id and emits notifications", async () => {
    const t = new FakeTransport();
    const rpc = new ImsgRpc(t, 1_000);
    const seen: unknown[] = [];
    rpc.on("message", (m, sub) => seen.push([m.guid, sub]));

    const p = rpc.status();
    const sent = JSON.parse(t.written[0] as string);
    expect(sent).toMatchObject({ jsonrpc: "2.0", id: 1, method: "status" });

    t.feed({
      jsonrpc: "2.0",
      method: "message",
      params: { subscription: 7, message: { guid: "X", id: 1, chat_id: 1 } },
    });
    t.feed({ jsonrpc: "2.0", id: 1, result: { version: "1.0" } });

    await expect(p).resolves.toEqual({ version: "1.0" });
    expect(seen).toEqual([["X", 7]]);
  });

  it("rejects with RpcError on error responses", async () => {
    const t = new FakeTransport();
    const rpc = new ImsgRpc(t, 1_000);
    const p = rpc.send({ to: "+14155551212" }, "hi");
    t.feed({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: "unknown delivery", data: { retry_safe: false } },
    });
    await expect(p).rejects.toBeInstanceOf(RpcError);
    await p.catch((e: RpcError) => {
      expect(e.code).toBe(-32001);
      expect(e.data).toEqual({ retry_safe: false });
    });
  });

  it("fails pending requests when imsg exits", async () => {
    const t = new FakeTransport();
    const rpc = new ImsgRpc(t, 1_000);
    const p = rpc.status();
    t.exit();
    await expect(p).rejects.toThrow(/exited/);
    await expect(rpc.status()).rejects.toThrow(/not running/);
  });

  it("sends through applescript explicitly", () => {
    const t = new FakeTransport();
    const rpc = new ImsgRpc(t, 1_000);
    void rpc.send({ chat_id: 4 }, "hello");
    expect(JSON.parse(t.written[0] as string).params).toEqual({ chat_id: 4, text: "hello", transport: "applescript" });
  });
});
