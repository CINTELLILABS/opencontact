import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRAIN_PRESETS,
  configSecrets,
  describeConfig,
  resolveConfig,
  saveConfig,
  validateConfig,
} from "../src/config.ts";
import { redact } from "../src/log.ts";

const KEY = "sk-live-0123456789abcdef";
const AGENT = "11111111-1111-4111-8111-111111111111";

describe("resolveConfig", () => {
  it("applies defaults, file, then env", () => {
    const r = resolveConfig({ apiKey: "file", agentId: AGENT, allowFrom: ["(415) 555-1212"] }, { BLAND_API_KEY: KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.apiKey).toBe(KEY);
    expect(r.config.dryRun).toBe(true);
    expect(r.config.allowFrom).toEqual(["+14155551212"]);
    expect(r.config.answer).toBe("list"); // a list with no explicit mode means list (older configs)
    expect(r.config.apiUrl).toBe("https://api.bland.ai");
  });
  it("reports every problem at once", () => {
    const r = validateConfig({
      apiUrl: "ftp://x",
      agentId: "nope",
      allowFrom: "x",
      attachments: "maybe",
      dryRun: "yes",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "apiKey is required",
        expect.stringMatching(/apiUrl/),
        expect.stringMatching(/agentId/),
        "allowFrom must be an array of strings",
        expect.stringMatching(/attachments/),
        "dryRun must be true or false",
      ]),
    );
  });
  it("trims a trailing slash from apiUrl", () => {
    const r = resolveConfig({ apiKey: KEY, agentId: AGENT, apiUrl: "https://example.test/" });
    expect(r.ok && r.config.apiUrl).toBe("https://example.test");
  });
});

describe("brains", () => {
  it("defaults to bland and requires its key and agent", () => {
    const r = validateConfig({
      ...{
        apiUrl: "https://api.bland.ai",
        dryRun: true,
        allowFrom: [],
        groups: false,
        maxSendsPerHour: 1,
        maxSendsPerSenderPerHour: 1,
        ownerTakeoverMinutes: 1,
        attachments: "describe",
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(expect.arrayContaining(["apiKey is required", "agentId is required"]));
  });
  it("needs no Bland key for a persona brain and reads the vendor key from the environment", () => {
    const r = resolveConfig({ brain: { kind: "anthropic" } as never }, { ANTHROPIC_API_KEY: "sk-ant-test-0123456789" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.brain).toMatchObject({
      kind: "anthropic",
      apiKey: "sk-ant-test-0123456789",
      model: "claude-opus-5-5",
      effort: "low",
    });
    expect(r.config.apiKey).toBe("");
    expect(JSON.stringify(describeConfig(r.config))).not.toContain("sk-ant-test-0123456789");
    expect(configSecrets(r.config)).toEqual(["sk-ant-test-0123456789"]);
  });
  it("lets a local OpenAI-compatible endpoint go without a key, and exposes the presets", () => {
    const local = { kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.3" } as never;
    const r = resolveConfig({ brain: local }, {});
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.config.brain).toMatchObject({ kind: "openai", apiKey: "local", baseUrl: "http://127.0.0.1:11434/v1" });
    const remote = { kind: "openai", baseUrl: "https://api.openai.com/v1" } as never;
    expect(resolveConfig({ brain: remote }, {}).ok).toBe(false);
    expect(BRAIN_PRESETS["claude-code"].command).toContain("claude -p");
    expect(BRAIN_PRESETS["claude-code"].command).toContain('--tools "Read,WebSearch,WebFetch"');
    expect(BRAIN_PRESETS.codex.command).toContain("-s read-only");
    expect(BRAIN_PRESETS.ollama.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });
  it("validates the answer mode", () => {
    expect(resolveConfig({ apiKey: KEY, agentId: AGENT, answer: "outbound" }).ok && true).toBe(true);
    const bad = resolveConfig({ apiKey: KEY, agentId: AGENT, answer: "friends" as never });
    expect(bad.ok).toBe(false);
  });
  it("rejects a command brain without a command and an unknown kind", () => {
    expect(validateConfig({ brain: { kind: "command" } })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["brain.command is required for the command brain"]),
    });
    expect(validateConfig({ brain: { kind: "gemini" } })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringMatching(/brain.kind must be/)]),
    });
  });
});

describe("saveConfig", () => {
  it("writes owner-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-"));
    const path = join(dir, "nested", "config.json");
    saveConfig(path, { apiKey: KEY, agentId: AGENT });
    expect(JSON.parse(readFileSync(path, "utf8")).agentId).toBe(AGENT);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("redaction", () => {
  it("never shows the key", () => {
    const r = resolveConfig({ apiKey: KEY, agentId: AGENT });
    if (!r.ok) throw new Error("bad config");
    expect(JSON.stringify(describeConfig(r.config))).not.toContain(KEY);
    expect(redact(`Authorization: Bearer ${KEY}`, [KEY])).toBe("Authorization: Bearer [redacted]");
  });
});
