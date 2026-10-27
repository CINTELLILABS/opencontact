import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeHandle } from "./handles.ts";
import type { ContactCard } from "./vcard.ts";

/** Who answers. Bland is the default and the only brain with business features. */
export type BrainConfig =
  | { kind: "bland"; label?: string | undefined }
  | {
      kind: "anthropic";
      apiKey: string;
      model: string;
      effort: string;
      personaPath: string;
      personaName: string;
      label?: string | undefined;
    }
  | {
      kind: "openai";
      apiKey: string;
      model: string;
      baseUrl: string;
      personaPath: string;
      personaName: string;
      label?: string | undefined;
    }
  | { kind: "command"; command: string; personaPath: string; personaName: string; label?: string | undefined };

/**
 * Presets that expand to one of the four kinds. The official CLIs run as
 * subprocesses with the user's own login; opencontact never reads a token.
 */
export const BRAIN_PRESETS = {
  "claude-code": {
    kind: "command",
    label: "Claude Code (claude -p with your Claude login)",
    command: 'claude -p --no-session-persistence --output-format text --tools "Read,WebSearch,WebFetch"',
  },
  codex: {
    kind: "command",
    label: "Codex CLI (codex exec with your ChatGPT login)",
    command: "codex exec --skip-git-repo-check --ephemeral -s read-only --color never",
  },
  ollama: {
    kind: "openai",
    label: "Ollama (local, 127.0.0.1:11434)",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    model: "llama3.3",
  },
} as const;
export type BrainPreset = keyof typeof BRAIN_PRESETS;
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export type AnswerMode = "everyone" | "list" | "outbound";
export const ANSWER_MODES: readonly AnswerMode[] = ["everyone", "list", "outbound"];

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export const DEFAULT_OPENAI_MODEL = "gpt-5";

export interface BridgeConfig {
  brain: BrainConfig;
  /** Bland API key (brain = bland). Never logged. */
  apiKey: string;
  /** Bland API base URL. */
  apiUrl: string;
  /** The Bland v2 agent that answers (brain = bland). */
  agentId: string;
  /** Log what would be sent instead of sending. Default true. */
  dryRun: boolean;
  /**
   * Who gets answered. everyone: anyone who texts. list: only `allowFrom`.
   * outbound: only people the agent texted first (`opencontact text`), so it never talks to strangers.
   */
  answer: AnswerMode;
  /** The list for `answer: "list"`. */
  allowFrom: string[];
  /** Reply inside group chats. Default false. */
  groups: boolean;
  /** Global outbound cap per rolling hour. */
  maxSendsPerHour: number;
  /** Outbound cap per recipient per rolling hour. */
  maxSendsPerSenderPerHour: number;
  /** After the owner replies from Messages, the agent stays quiet in that chat for this long. */
  ownerTakeoverMinutes: number;
  /** What to do with attachment-only inbound. */
  attachments: "describe" | "ignore";
  /** Path or command name for imsg. */
  imsgPath: string;
  /** Where state and the audit log live. */
  stateDir: string;
  /** Sent once to each new customer so they can save the business with its name and logo. */
  contactCard?: ContactCard | undefined;
}

export type ConfigInput = Partial<BridgeConfig>;

export const CONFIG_DIR = join(homedir(), ".config", "opencontact");
export const DEFAULT_CONFIG_PATH = join(CONFIG_DIR, "config.json");

export const DEFAULT_PERSONA_PATH = join(CONFIG_DIR, "persona.md");

export function defaultConfig(): Omit<BridgeConfig, "apiKey" | "agentId" | "answer"> & { answer?: AnswerMode } {
  return {
    brain: { kind: "bland" },
    apiUrl: "https://api.bland.ai",
    dryRun: true,
    allowFrom: [],
    groups: false,
    maxSendsPerHour: 60,
    maxSendsPerSenderPerHour: 20,
    ownerTakeoverMinutes: 30,
    attachments: "describe",
    imsgPath: "imsg",
    stateDir: CONFIG_DIR,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type Validation = { ok: true; config: BridgeConfig } | { ok: false; errors: string[] };

/** Merge defaults, a parsed file, and environment overrides; then validate. */
export function resolveConfig(file: ConfigInput, env: NodeJS.ProcessEnv = {}): Validation {
  const merged: Record<string, unknown> = { ...defaultConfig(), ...stripUndefined(file) };
  if (env.BLAND_API_KEY) merged.apiKey = env.BLAND_API_KEY;
  if (env.BLAND_AGENT_ID) merged.agentId = env.BLAND_AGENT_ID;
  if (env.BLAND_API_URL) merged.apiUrl = env.BLAND_API_URL;
  if (env.IMSG_PATH) merged.imsgPath = env.IMSG_PATH;
  const brain = merged.brain as Record<string, unknown> | undefined;
  if (brain && typeof brain === "object") {
    if (brain.kind === "anthropic" && env.ANTHROPIC_API_KEY && !brain.apiKey)
      merged.brain = { ...brain, apiKey: env.ANTHROPIC_API_KEY };
    if (brain.kind === "openai" && env.OPENAI_API_KEY && !brain.apiKey)
      merged.brain = { ...brain, apiKey: env.OPENAI_API_KEY };
  }
  return validateConfig(merged);
}

export function validateConfig(raw: unknown): Validation {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["config must be an object"] };
  const r = raw as Record<string, unknown>;

  const str = (k: string, required = true): string | undefined => {
    const v = r[k];
    if (v === undefined || v === "") {
      if (required) errors.push(`${k} is required`);
      return undefined;
    }
    if (typeof v !== "string") {
      errors.push(`${k} must be a string`);
      return undefined;
    }
    return v;
  };
  const bool = (k: string): boolean => {
    const v = r[k];
    if (typeof v !== "boolean") {
      errors.push(`${k} must be true or false`);
      return false;
    }
    return v;
  };
  const posInt = (k: string): number => {
    const v = r[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      errors.push(`${k} must be a non-negative integer`);
      return 0;
    }
    return v;
  };

  const brain = parseBrain(r.brain, errors);
  const usesBland = brain.kind === "bland";
  const apiKey = str("apiKey", usesBland) ?? "";
  const apiUrl = str("apiUrl") ?? "";
  if (apiUrl && !/^https?:\/\//.test(apiUrl)) errors.push("apiUrl must start with http:// or https://");
  const agentId = str("agentId", usesBland) ?? "";
  if (agentId && !UUID.test(agentId))
    errors.push("agentId must be a UUID (copy it from the agent's URL in the Bland dashboard)");

  const allowFromRaw = r.allowFrom;
  let allowFrom: string[] = [];
  if (!Array.isArray(allowFromRaw) || allowFromRaw.some((x) => typeof x !== "string")) {
    errors.push("allowFrom must be an array of strings");
  } else {
    allowFrom = (allowFromRaw as string[]).map(normalizeHandle).filter((h) => h.length > 0);
  }

  const attachments = r.attachments;
  if (attachments !== "describe" && attachments !== "ignore") errors.push('attachments must be "describe" or "ignore"');

  // Older configs had no `answer`: a non-empty list meant "list", otherwise everyone.
  let answer: AnswerMode = allowFrom.length > 0 ? "list" : "everyone";
  if (r.answer !== undefined) {
    if (typeof r.answer === "string" && (ANSWER_MODES as readonly string[]).includes(r.answer))
      answer = r.answer as AnswerMode;
    else errors.push("answer must be everyone, list, or outbound");
  }

  let contactCard: ContactCard | undefined;
  if (r.contactCard !== undefined && r.contactCard !== null) {
    const c = r.contactCard;
    if (typeof c !== "object") errors.push("contactCard must be an object");
    else {
      const cc = c as Record<string, unknown>;
      if (typeof cc.name !== "string" || cc.name.trim().length === 0) errors.push("contactCard.name is required");
      for (const k of ["phone", "email", "url", "photoPath"]) {
        if (cc[k] !== undefined && typeof cc[k] !== "string") errors.push(`contactCard.${k} must be a string`);
      }
      if (typeof cc.name === "string") {
        contactCard = {
          name: cc.name.trim(),
          phone: typeof cc.phone === "string" && cc.phone ? normalizeHandle(cc.phone) : undefined,
          email: typeof cc.email === "string" && cc.email ? cc.email.trim() : undefined,
          url: typeof cc.url === "string" && cc.url ? cc.url.trim() : undefined,
          photoPath: typeof cc.photoPath === "string" && cc.photoPath ? cc.photoPath : undefined,
        };
      }
    }
  }

  const config: BridgeConfig = {
    brain,
    apiKey,
    apiUrl: apiUrl.replace(/\/+$/, ""),
    agentId,
    dryRun: bool("dryRun"),
    answer,
    allowFrom,
    groups: bool("groups"),
    maxSendsPerHour: posInt("maxSendsPerHour"),
    maxSendsPerSenderPerHour: posInt("maxSendsPerSenderPerHour"),
    ownerTakeoverMinutes: posInt("ownerTakeoverMinutes"),
    attachments: attachments === "ignore" ? "ignore" : "describe",
    imsgPath: str("imsgPath") ?? "imsg",
    stateDir: str("stateDir") ?? CONFIG_DIR,
    contactCard,
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config };
}

function parseBrain(raw: unknown, errors: string[]): BrainConfig {
  if (raw === undefined || raw === null) return { kind: "bland" };
  if (typeof raw !== "object") {
    errors.push('brain must be an object like { "kind": "bland" }');
    return { kind: "bland" };
  }
  const b = raw as Record<string, unknown>;
  const optStr = (k: string): string | undefined =>
    typeof b[k] === "string" && (b[k] as string).length > 0 ? (b[k] as string) : undefined;
  const personaPath = optStr("personaPath") ?? DEFAULT_PERSONA_PATH;
  const personaName = optStr("personaName") ?? "the business";
  switch (b.kind) {
    case undefined:
    case "bland":
      return { kind: "bland" };
    case "anthropic": {
      const apiKey = optStr("apiKey");
      if (!apiKey) errors.push("brain.apiKey is required for the anthropic brain (or set ANTHROPIC_API_KEY)");
      return {
        kind: "anthropic",
        apiKey: apiKey ?? "",
        model: optStr("model") ?? DEFAULT_ANTHROPIC_MODEL,
        effort: optStr("effort") ?? "low",
        personaPath,
        personaName,
        label: optStr("label"),
      };
    }
    case "openai": {
      const baseUrl = optStr("baseUrl") ?? "https://api.openai.com/v1";
      const local = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(baseUrl);
      // Local OpenAI-compatible servers (Ollama, LM Studio) accept any string as the key.
      const apiKey = optStr("apiKey") ?? (local ? "local" : undefined);
      if (!apiKey) errors.push("brain.apiKey is required for the openai brain (or set OPENAI_API_KEY)");
      return {
        kind: "openai",
        apiKey: apiKey ?? "",
        model: optStr("model") ?? DEFAULT_OPENAI_MODEL,
        baseUrl,
        personaPath,
        personaName,
        label: optStr("label"),
      };
    }
    case "command": {
      const command = optStr("command");
      if (!command) errors.push("brain.command is required for the command brain");
      return { kind: "command", command: command ?? "", personaPath, personaName, label: optStr("label") };
    }
    default:
      errors.push(`brain.kind must be bland, anthropic, openai, or command (got ${String(b.kind)})`);
      return { kind: "bland" };
  }
}

/** Every secret in the config, for log redaction. */
export function configSecrets(config: BridgeConfig): string[] {
  const out = [config.apiKey];
  if ("apiKey" in config.brain) out.push(config.brain.apiKey);
  return out.filter((s) => s.length > 0);
}

export function readConfigFile(path: string): ConfigInput {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${path} must contain a JSON object`);
  return parsed as ConfigInput;
}

export function loadConfig(path: string = DEFAULT_CONFIG_PATH, env: NodeJS.ProcessEnv = process.env): Validation {
  return resolveConfig(readConfigFile(path), env);
}

/** Write the config with owner-only permissions. */
export function saveConfig(path: string, config: ConfigInput): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The config as it is safe to print. */
export function describeConfig(config: BridgeConfig): Record<string, unknown> {
  const mask = (k: string) => (k ? `${k.slice(0, 4)}…[redacted]` : "(missing)");
  return {
    ...config,
    apiKey: config.brain.kind === "bland" ? mask(config.apiKey) : config.apiKey ? mask(config.apiKey) : "(not used)",
    brain: "apiKey" in config.brain ? { ...config.brain, apiKey: mask(config.brain.apiKey) } : config.brain,
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
