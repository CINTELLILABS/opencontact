#!/usr/bin/env node
/**
 * opencontact — Contacts In Your Phone.
 * Put your business's Bland agent behind the iMessage line on this Mac.
 *
 *   opencontact              guided setup the first time, then run
 *   opencontact setup        build or pick an agent, permissions, go live
 *   opencontact run          watch Messages and answer (L live, D dry-run, Q quit)
 *   opencontact doctor       check everything
 *   opencontact only <h>     answer only these handles while testing; opencontact everyone clears it
 *   opencontact status
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JsonlAudit } from "./audit.ts";
import { BlandApiError, BlandClient } from "./bland.ts";
import { detectOllama, FileTranscriptStore, loadPersona } from "./brain.ts";
import { createBrain } from "./brains.ts";
import { BRIDGE_VERSION, Bridge } from "./bridge.ts";
import {
  ANSWER_MODES,
  type AnswerMode,
  BRAIN_PRESETS,
  type BrainConfig,
  type BrainPreset,
  type BridgeConfig,
  CONFIG_DIR,
  type ConfigInput,
  configSecrets,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CONFIG_PATH,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_PERSONA_PATH,
  defaultConfig,
  describeConfig,
  loadConfig,
  OLLAMA_BASE_URL,
  readConfigFile,
  resolveConfig,
  saveConfig,
} from "./config.ts";
import { inferOwnHandle, isPhoneHandle, maskHandle, normalizeHandle } from "./handles.ts";
import { ImsgRpc, spawnImsg } from "./imsg.ts";
import { installedReleaseImsg, installImsgFromRelease } from "./install-imsg.ts";
import { FileSentLedger } from "./ledger.ts";
import { RunLock } from "./lock.ts";
import { createLogger, type Level } from "./log.ts";
import { startOutbound } from "./outbound.ts";
import { ask, askHidden, choose, confirm, interactive, paint, say, spinner } from "./prompt.ts";
import { parseRecipients, recipientContext } from "./recipients.ts";
import { fetchSiteLogo } from "./site-logo.ts";
import { FileStateStore } from "./state.ts";
import { buildVCard, type ContactCard } from "./vcard.ts";
import { formatHandle, LiveView } from "./view.ts";

interface Args {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
  /** Repeatable flags like --allow. */
  multi: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const multi = new Map<string, string[]>();
  const positional: string[] = [];
  let command: string | undefined;
  const push = (k: string, v: string | true) => {
    flags.set(k, v);
    if (typeof v === "string") multi.set(k, [...(multi.get(k) ?? []), v]);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) push(a.slice(2, eq), a.slice(eq + 1));
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          push(a.slice(2), next);
          i++;
        } else push(a.slice(2), true);
      }
    } else if (command === undefined) command = a;
    else positional.push(a);
  }
  return { command, positional, flags, multi };
}

const HELP = `opencontact ${BRIDGE_VERSION} — Contacts In Your Phone
Put your business's AI agent behind the iMessage line on this Mac.

  opencontact                     first run: guided setup, then start
  opencontact <website>           build that business's agent, card and logo from its site, and go live
  opencontact setup               build an agent from your website (or pick one), permissions, go live
  opencontact run [--live]        answer texts in the live view. L live · D dry-run · Q quit. --log for plain logs
  opencontact doctor [--json]     check imsg, permissions, API key, config
  opencontact text <handle> [why]  the agent reaches out first ("follow up on Thursday's quote"); --name, --resend-card
  opencontact text --list people.csv [why]   reach out to everyone on a list (phone[,name][,details…])
  opencontact card "<business>" [--logo file.png] [--phone <handle>]   set the contact card sent to new customers
  opencontact stop                stop a running opencontact
  opencontact forget <handle>     start a contact over (new conversation, card again); for rehearsals
  opencontact brain <who>         switch who answers: bland | claude-code | codex | ollama | anthropic | openai
  opencontact answer everyone     reply to anyone who texts this number (default)
  opencontact answer list         reply only to numbers on the list: opencontact only +1… (repeatable)
  opencontact answer outbound     reply only to people the agent texted first; never talk to strangers
  opencontact only <handle…>      add to the list and switch to list mode
  opencontact everyone            back to everyone
  opencontact log [-n 20]         recent decisions from the audit log
  opencontact status [--json]     what is configured, key redacted

Setup flags (all optional; prompts fill in the rest):
  --brain <who>        bland (default) | claude-code | codex | ollama | anthropic | openai | command
                       claude-code / codex run the official CLIs with your existing login; ollama is local and free
  --api-key <key>  --website <url> | --agent <uuid>              bland: Bland key, build from a site or pick an agent
  --anthropic-key <key> | --openai-key <key>  --model <id>        your own key; persona in ~/.config/opencontact/persona.md
  --command "<cmd>"                           any program: prompt on stdin, reply on stdout (e.g. claude -p "...")
  --persona <file>  --name "<who it speaks for>"
  --only <handle> (repeatable)  --live  --yes
  --card-name <business>  --card-phone <handle>  --card-logo <png|jpg>  --no-card

Options: --config <path>   --api-url <url>   --log-level debug|info|warn|error   --version   --help
Environment: BLAND_API_KEY, BLAND_AGENT_ID, BLAND_API_URL, IMSG_PATH
`;

const flagString = (args: Args, name: string): string | undefined => {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

function fail(message: string, code = 1): never {
  say(paint.red(`error: ${message}`));
  process.exit(code);
}

function imsgVersion(imsgPath: string): string | null {
  try {
    return execFileSync(imsgPath, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function ensureImsg(imsgPath: string, yes: boolean): Promise<string | null> {
  if (imsgVersion(imsgPath)) return imsgPath;
  const already = installedReleaseImsg();
  if (already && imsgVersion(already)) return already;
  if (process.platform !== "darwin") {
    say(paint.yellow("opencontact has to run on the Mac that is signed into Messages."));
    return null;
  }
  say(
    `${paint.bold("imsg")} reads and sends your iMessages. It is open source (github.com/openclaw/imsg), signed by its author.`,
  );
  if (!(yes || (await confirm("Install it now?", true)))) return null;

  // Prefer the project's signed release build: no compiler, no Command Line Tools, ~4 MB.
  const stop = spinner("installing imsg");
  try {
    const r = await installImsgFromRelease({
      report: (step) => process.stderr.write(process.stderr.isTTY ? `\r\x1b[2K⠿ ${step}` : `  ${step}\n`),
    });
    stop(paint.green(`     ✓ ${r.version} (${r.path})`));
    return r.path;
  } catch (err) {
    stop(paint.yellow(`     release download failed: ${(err as Error).message}`));
  }

  // Fall back to Homebrew, which builds from source.
  const hasBrew = spawnSync("brew", ["--version"], { stdio: "ignore" }).status === 0;
  if (!hasBrew) {
    say(
      `Install Homebrew (https://brew.sh) and run ${paint.bold("brew install steipete/tap/imsg")}, or download imsg-macos.zip from github.com/openclaw/imsg/releases.`,
    );
    return null;
  }
  const stop2 = spinner("brew install steipete/tap/imsg (builds from source; may take a few minutes)");
  const r = spawnSync("brew", ["install", "steipete/tap/imsg"], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (r.status !== 0) {
    stop2(paint.red("✗ brew install failed"));
    say(paint.dim((r.stderr ?? "").trim().split("\n").slice(-6).join("\n")));
    return null;
  }
  stop2();
  return imsgVersion(imsgPath) ? imsgPath : null;
}

/** Ask imsg whether it can read the database and send; returns the two booleans. */
async function probeImsg(
  imsgPath: string,
): Promise<{ ready: boolean; canSend: boolean; dbError?: string | undefined }> {
  const rpc = new ImsgRpc(spawnImsg(imsgPath), 15_000);
  try {
    const status = await rpc.status();
    const ready = status.database?.ready !== false;
    const canSend = !Array.isArray(status.methods) || status.methods.includes("send");
    return { ready, canSend, dbError: status.database?.error };
  } catch (err) {
    return { ready: false, canSend: false, dbError: (err as Error).message };
  } finally {
    rpc.close();
  }
}

async function cmdSetup(args: Args, configPath: string): Promise<void> {
  const yes = args.flags.has("yes");
  const existing = readConfigFile(configPath);
  const next: ConfigInput = { ...defaultConfig(), ...existing };
  const imsgPath = flagString(args, "imsg-path") ?? process.env.IMSG_PATH ?? next.imsgPath ?? "imsg";
  next.imsgPath = imsgPath;
  const apiUrl = flagString(args, "api-url") ?? process.env.BLAND_API_URL ?? next.apiUrl ?? "https://api.bland.ai";
  next.apiUrl = apiUrl;

  say();
  say(paint.bold("opencontact — Contacts In Your Phone"));
  say(paint.dim("Your customers already text this Mac's number. Let's put your agent behind it."));
  say();

  // 1. imsg
  say(paint.bold("1/4  imsg"));
  const resolvedImsg = await ensureImsg(imsgPath, yes);
  if (!resolvedImsg) fail("imsg is required. Install it and run `opencontact setup` again.");
  next.imsgPath = resolvedImsg;
  say(paint.green(`     ✓ ${imsgVersion(resolvedImsg)}`));

  // 2. Who answers
  say(paint.bold("2/4  Who answers"));
  type Choice = BrainConfig["kind"] | BrainPreset;
  let choice = (flagString(args, "brain") ??
    next.brain?.label?.match(/^preset:(\S+)/)?.[1] ??
    next.brain?.kind ??
    "") as Choice | "";
  if (choice && !(choice in BRAIN_PRESETS) && !["bland", "anthropic", "openai", "command"].includes(choice)) {
    fail(`--brain must be one of bland, claude-code, codex, ollama, anthropic, openai, command (got ${choice})`);
  }
  if (!choice) {
    if (flagString(args, "website") || flagString(args, "agent") || flagString(args, "api-key")) choice = "bland";
    else if (
      flagString(args, "anthropic-key") ||
      (process.env.ANTHROPIC_API_KEY && !process.env.BLAND_API_KEY && !flagString(args, "api-key"))
    )
      choice = "anthropic";
    else if (flagString(args, "openai-key")) choice = "openai";
    else if (flagString(args, "command")) choice = "command";
    else if (!interactive()) choice = "bland";
    else {
      // Offer what is actually on this Mac, the way OpenClaw's onboarding does.
      const hasClaude = spawnSync("sh", ["-c", "command -v claude"], { stdio: "ignore" }).status === 0;
      const hasCodex = spawnSync("sh", ["-c", "command -v codex"], { stdio: "ignore" }).status === 0;
      const ollamaModels = await detectOllama(OLLAMA_BASE_URL);
      const options: Array<{ k: Choice; label: string }> = [
        {
          k: "bland",
          label:
            "Bland (recommended): a business agent built from your website, memory per customer, and a path to a real number with RCS and iMessage branding. Free to start.",
        },
      ];
      if (hasClaude)
        options.push({
          k: "claude-code",
          label: "Claude Code on this Mac: runs `claude -p` with your existing Claude login. A persona you write.",
        });
      if (hasCodex)
        options.push({
          k: "codex",
          label: "Codex CLI on this Mac: runs `codex exec` with your existing ChatGPT login.",
        });
      if (ollamaModels && ollamaModels.length > 0)
        options.push({
          k: "ollama",
          label: `Ollama, local and free: ${ollamaModels.slice(0, 3).join(", ")}${ollamaModels.length > 3 ? ", …" : ""}`,
        });
      options.push(
        { k: "anthropic", label: "An Anthropic API key" },
        { k: "openai", label: "An OpenAI API key, or any OpenAI-compatible endpoint" },
        { k: "command", label: "Any command: prompt on stdin, reply on stdout (an OpenClaw gateway, your own script)" },
      );
      const pick = await choose("     Who should answer the texts?", options, (o) => o.label);
      choice = pick?.k ?? "bland";
    }
  }
  const preset: BrainPreset | null = choice in BRAIN_PRESETS ? (choice as BrainPreset) : null;
  const brainKind: BrainConfig["kind"] = preset ? BRAIN_PRESETS[preset].kind : (choice as BrainConfig["kind"]);
  let agentName = flagString(args, "name") ?? next.contactCard?.name ?? "";
  // Set when the agent is built from a site, so the card can carry that business's name and logo.
  let builtFrom: string | undefined;
  const personaPath =
    flagString(args, "persona") ??
    (next.brain && "personaPath" in next.brain ? next.brain.personaPath : undefined) ??
    DEFAULT_PERSONA_PATH;

  if (brainKind === "bland") {
    next.brain = { kind: "bland" };
    let apiKey = flagString(args, "api-key") ?? process.env.BLAND_API_KEY ?? existing.apiKey ?? "";
    if (!apiKey) {
      say(
        "     A Bland API key runs the agent. Get one in 30 seconds at " +
          paint.bold("https://app.bland.ai/dashboard/settings"),
      );
      apiKey = await askHidden("     Paste it (hidden)");
      if (!apiKey) fail("no API key. Pass --api-key or set BLAND_API_KEY.");
    }
    const bland = new BlandClient({ apiUrl, apiKey, timeoutMs: 20_000, userAgent: `opencontact/${BRIDGE_VERSION}` });
    {
      const stop = spinner("checking the key");
      try {
        await bland.me();
        stop(paint.green("     ✓ key accepted"));
      } catch (err) {
        stop(paint.red("     ✗ key rejected"));
        fail(err instanceof BlandApiError ? `${err.status} ${err.code}: ${err.message}` : (err as Error).message);
      }
    }
    next.apiKey = apiKey;

    // 3. Agent
    say(paint.bold("3/4  Your agent"));
    let agentId = flagString(args, "agent") ?? process.env.BLAND_AGENT_ID ?? "";
    const website = flagString(args, "website");
    if (!agentId && website) {
      ({ id: agentId, name: agentName } = await buildFromWebsite(bland, website));
      builtFrom = websiteUrl(website);
    } else if (!agentId && !interactive()) {
      if (existing.agentId) agentId = existing.agentId;
      else fail("no terminal to ask in: pass --agent <uuid> or --website <url>.");
    } else if (!agentId) {
      const choice = await ask(
        "     Build one from your website (enter the URL), or type 'pick' to use an existing agent",
        existing.agentId ? "keep current" : "",
      );
      if (choice === "keep current" && existing.agentId) agentId = existing.agentId;
      else if (choice.toLowerCase() === "pick" || choice === "") {
        const stop = spinner("loading your agents");
        const agents = await bland.listAgents().catch(() => []);
        stop(agents.length ? `     ${agents.length} agent(s)` : paint.yellow("     no agents found"));
        if (agents.length === 0) {
          const url = await ask("     Your business website");
          if (!url) fail("need a website or an agent id (--website or --agent).");
          ({ id: agentId, name: agentName } = await buildFromWebsite(bland, url));
          builtFrom = websiteUrl(url);
        } else {
          const picked = await choose("     Which agent should answer?", agents.slice(0, 15), (a) => a.name);
          if (!picked) fail("no agent chosen");
          agentId = picked.id;
          agentName = picked.name;
        }
      } else {
        ({ id: agentId, name: agentName } = await buildFromWebsite(bland, choice));
        builtFrom = websiteUrl(choice);
      }
    }
    next.agentId = agentId;
    say(paint.green(`     ✓ agent ${agentId}`));
  } else {
    // A persona brain: a key or a command, a name, and a persona file the user can edit.
    if (!agentName) agentName = await ask("     Who does it speak for? (a business or a person)", "the business");
    if (brainKind === "anthropic") {
      let key =
        flagString(args, "anthropic-key") ??
        process.env.ANTHROPIC_API_KEY ??
        (next.brain?.kind === "anthropic" ? next.brain.apiKey : "") ??
        "";
      if (!key) key = await askHidden("     Anthropic API key (hidden)");
      if (!key) fail("no Anthropic key. Pass --anthropic-key or set ANTHROPIC_API_KEY.");
      next.brain = {
        kind: "anthropic",
        apiKey: key,
        model: flagString(args, "model") ?? DEFAULT_ANTHROPIC_MODEL,
        effort: flagString(args, "effort") ?? "low",
        personaPath,
        personaName: agentName,
      };
    } else if (brainKind === "openai" && preset === "ollama") {
      const models = (await detectOllama(OLLAMA_BASE_URL)) ?? [];
      let model = flagString(args, "model") ?? "";
      if (!model && models.length > 0)
        model = (await choose("     Which local model?", models, (m) => m)) ?? (models[0] as string);
      if (!model) model = BRAIN_PRESETS.ollama.model;
      if (models.length === 0)
        say(
          paint.yellow(
            `     Ollama is not answering at ${OLLAMA_BASE_URL}. Start it (ollama serve) and pull a model (ollama pull ${model}).`,
          ),
        );
      next.brain = {
        kind: "openai",
        apiKey: BRAIN_PRESETS.ollama.apiKey,
        model,
        baseUrl: BRAIN_PRESETS.ollama.baseUrl,
        personaPath,
        personaName: agentName,
        label: `preset:ollama ${BRAIN_PRESETS.ollama.label}`,
      };
    } else if (brainKind === "openai") {
      let key =
        flagString(args, "openai-key") ??
        process.env.OPENAI_API_KEY ??
        (next.brain?.kind === "openai" ? next.brain.apiKey : "") ??
        "";
      const baseUrl = flagString(args, "base-url") ?? "https://api.openai.com/v1";
      const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseUrl);
      if (!key && !local) key = await askHidden("     OpenAI API key (hidden)");
      if (!key && !local) fail("no OpenAI key. Pass --openai-key or set OPENAI_API_KEY.");
      next.brain = {
        kind: "openai",
        apiKey: key || "local",
        model: flagString(args, "model") ?? DEFAULT_OPENAI_MODEL,
        baseUrl,
        personaPath,
        personaName: agentName,
      };
    } else if (preset === "claude-code" || preset === "codex") {
      const p = BRAIN_PRESETS[preset];
      const model = flagString(args, "model");
      const command = model
        ? `${p.command} ${preset === "codex" ? "-m" : "--model"} ${JSON.stringify(model)}`
        : p.command;
      next.brain = {
        kind: "command",
        command,
        personaPath,
        personaName: agentName,
        label: `preset:${preset} ${p.label}`,
      };
      say(paint.dim(`     ${command}`));
      say(
        paint.dim(
          "     Runs the official CLI with the login already on this Mac. Whether your plan covers that is the vendor's policy; an API key always works.",
        ),
      );
    } else {
      let command = flagString(args, "command") ?? (next.brain?.kind === "command" ? next.brain.command : "") ?? "";
      if (!command)
        command = await ask(
          "     Command to run per message (prompt on stdin, reply on stdout)",
          'claude -p "Reply as the persona. Output only the reply."',
        );
      if (!command) fail("no command. Pass --command.");
      next.brain = { kind: "command", command, personaPath, personaName: agentName };
    }
    const checked = resolveConfig({ ...next, apiKey: next.apiKey ?? "", agentId: next.agentId ?? "" }, {});
    if (!checked.ok) fail(checked.errors.join("\n  "));
    const probe = createBrain(checked.config, {
      state: new FileStateStore(join(checked.config.stateDir, "state.json")),
      audit: { write() {} },
      log: createLogger({ level: "error" }),
      userAgent: `opencontact/${BRIDGE_VERSION}`,
    });
    const stop = spinner(`checking ${brainKind}`);
    const r = await probe.check();
    if (!r.ok) {
      stop(paint.red(`     ✗ ${r.detail}`));
      fail(`${brainKind} is not usable yet`);
    }
    stop(paint.green(`     ✓ ${r.detail}`));
    loadPersona(personaPath, agentName);
    say(paint.bold("3/4  Persona"));
    say(`     ${personaPath}`);
    say(paint.dim("     Edit it any time; it is the whole brief. Replies pick up the change on the next text."));
  }

  // 4. Who it may answer: everyone, unless the user wants to try it alone first.
  say(paint.bold("4/4  Who it answers"));
  const only = [...(args.multi.get("only") ?? []), ...(args.multi.get("allow") ?? []), ...args.positional].map(
    normalizeHandle,
  );
  const answerFlag = flagString(args, "answer") as AnswerMode | undefined;
  if (answerFlag && !ANSWER_MODES.includes(answerFlag)) fail("--answer must be everyone, list, or outbound");
  if (only.length > 0) {
    next.allowFrom = only;
    next.answer = "list";
  } else if (answerFlag) next.answer = answerFlag;
  else if (!next.answer && interactive()) {
    const pick = await choose(
      "     Who should it answer?",
      [
        { m: "everyone" as const, label: "Everyone who texts this number (a business line)" },
        {
          m: "outbound" as const,
          label: "Only people the agent texted first with `opencontact text` (outreach; never talks to strangers)",
        },
        { m: "list" as const, label: "Only numbers I list (testing on a personal line)" },
      ],
      (o) => o.label,
    );
    next.answer = pick?.m ?? "everyone";
    if (next.answer === "list" && (next.allowFrom ?? []).length === 0) {
      const own = await ask("     A number to allow (E.164, like +14155551212)");
      if (own) next.allowFrom = [normalizeHandle(own)];
    }
  } else if (!next.answer) next.answer = (next.allowFrom ?? []).length > 0 ? "list" : "everyone";
  if (args.flags.has("groups")) next.groups = true;
  next.dryRun = !args.flags.has("live");
  const who =
    next.answer === "everyone"
      ? "anyone who texts this number"
      : next.answer === "outbound"
        ? "only people the agent texts first"
        : `only ${(next.allowFrom ?? []).join(", ") || "(nobody: the list is empty)"}`;
  say(paint.green(`     ✓ answers ${who}`));

  // Contact card: the business shows up in the customer's Contacts with a name and logo.
  if (args.flags.has("no-card")) next.contactCard = undefined;
  else {
    const cardName = flagString(args, "card-name");
    const cardPhone = flagString(args, "card-phone");
    const cardLogo = flagString(args, "card-logo");
    if (builtFrom && !cardName && !cardLogo) {
      // A new business: its own name, its own logo from its site, the same line.
      const stop = spinner(`     taking the logo from ${new URL(builtFrom).hostname}`);
      const logo = await fetchSiteLogo(builtFrom, join(CONFIG_DIR, "assets"));
      stop(
        logo
          ? paint.green("     ✓ logo from the website")
          : paint.dim("     no logo on the site; the card goes without one"),
      );
      next.contactCard = {
        name: agentName,
        phone: cardPhone ?? next.contactCard?.phone,
        url: builtFrom,
        photoPath: logo ?? undefined,
      };
    } else if (cardName || cardPhone || cardLogo) {
      next.contactCard = {
        name: cardName ?? next.contactCard?.name ?? agentName ?? "",
        phone: cardPhone ?? next.contactCard?.phone,
        photoPath: cardLogo ?? next.contactCard?.photoPath,
      };
    } else if (!next.contactCard && interactive()) {
      say(paint.bold("+    Contact card"));
      say("     After its first reply, the agent can send a contact card so customers save you by name, with a logo.");
      if (await confirm("     Send one?", true)) {
        const name = await ask("     Business name on the card", agentName || undefined);
        const own = await detectOwnHandle(resolvedImsg);
        const phone = await ask("     Number on the card (the one customers text)", own ?? undefined);
        const logo = await ask("     Logo file (.png or .jpg), or leave blank");
        if (name) next.contactCard = { name, ...(phone ? { phone } : {}), ...(logo ? { photoPath: logo } : {}) };
      }
    }
    if (next.contactCard && !next.contactCard.phone) {
      const own = await detectOwnHandle(resolvedImsg);
      if (own) next.contactCard = { ...next.contactCard, phone: own };
      else
        say(
          paint.yellow(
            "     The card has no number, so Add to Contacts will not attach your line. Set one: opencontact card --phone +1…",
          ),
        );
    }
    if (next.contactCard && !next.contactCard.name) next.contactCard = undefined;
    if (next.contactCard?.photoPath && !existsSync(next.contactCard.photoPath)) {
      say(paint.yellow(`     logo ${next.contactCard.photoPath} not found; card goes out without a photo`));
      next.contactCard = { ...next.contactCard, photoPath: undefined };
    }
    if (next.contactCard)
      say(paint.green(`     ✓ card: ${next.contactCard.name}${next.contactCard.photoPath ? " with logo" : ""}`));
  }

  const check = resolveConfig(next, {});
  if (!check.ok) fail(check.errors.join("\n  "));
  saveConfig(configPath, next);
  if (builtFrom) {
    // A different business: everyone gets its card, not the one they saved before.
    const store = new FileStateStore(join(check.config.stateDir, "state.json"));
    const st = store.load();
    st.cardSentTo = [];
    store.save(st);
  }
  say();
  say(paint.dim(`saved ${configPath} (mode 0600)`));

  // Permissions, with a retry loop so the user can grant them and continue.
  if (!(await ensurePermissions(resolvedImsg, yes))) {
    say();
    say(`Setup is saved. Grant Full Disk Access, reopen the terminal, then run ${paint.bold("opencontact")} to start.`);
    process.exit(1);
  }

  say();
  say(`${paint.bold("Ready.")} Text this Mac's number from your phone.`);
  if (args.flags.has("no-start")) return;
  if (!interactive() || yes) {
    say(`Starting in ${paint.bold(next.dryRun ? "dry-run" : "live")} mode.`);
    await cmdRun(args, configPath);
    return;
  }
  say(
    `${paint.bold("Live")} sends replies now. ${paint.bold("Dry-run")} shows them here first; press ${paint.bold("L")} to go live when you like what you see.`,
  );
  const live = await confirm("Go live now?", true);
  if (!live) say(paint.dim("dry-run it is"));
  if (live) args.flags.set("live", true);
  await cmdRun(args, configPath);
}

function websiteUrl(website: string): string {
  return /^https?:\/\//.test(website) ? website : `https://${website}`;
}

async function buildFromWebsite(bland: BlandClient, website: string): Promise<{ id: string; name: string }> {
  const url = websiteUrl(website);
  const stop = spinner(`reading ${url} and writing your agent (about a minute)`);
  try {
    const agent = await bland.generateAgent(url, randomUUID().replace(/-/g, "").slice(0, 32));
    stop(paint.green(`     ✓ ${agent.name}`));
    say(paint.dim(`     ${agent.summary}`));
    say(
      paint.dim(
        `     ${Array.isArray(agent.scenarios) ? agent.scenarios.length : 0} scenarios · edit any time at https://app.bland.ai`,
      ),
    );
    return { id: agent.agent_id, name: agent.name };
  } catch (err) {
    stop(paint.red("     ✗ could not build the agent"));
    fail(err instanceof BlandApiError ? `${err.status} ${err.code}: ${err.message}` : (err as Error).message);
  }
}

async function ensurePermissions(imsgPath: string, yes: boolean): Promise<boolean> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const p = await probeImsg(imsgPath);
    if (p.ready) {
      say(paint.green("✓ Messages database readable"));
      if (!p.canSend)
        say(
          paint.yellow(
            "! Sending is not confirmed yet. macOS will ask for Automation → Messages on the first live send; click Allow.",
          ),
        );
      return true;
    }
    say();
    say(paint.yellow("macOS needs one permission before opencontact can read your Messages:"));
    say("  System Settings → Privacy & Security → Full Disk Access → enable your terminal app");
    say(paint.dim("  (then quit and reopen the terminal if it still fails)"));
    if (p.dbError) say(paint.dim(`  imsg: ${p.dbError}`));
    if (yes || !interactive()) return false;
    if (!(await confirm("Granted it? Check again", true))) return false;
  }
  return false;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string | undefined;
}

async function cmdDoctor(args: Args, configPath: string): Promise<void> {
  const checks: Check[] = [];
  checks.push({
    name: "platform",
    ok: process.platform === "darwin",
    detail: process.platform,
    hint: "opencontact sends through Messages.app, so it runs on the Mac signed into iMessage.",
  });
  const loaded = loadConfig(configPath);
  checks.push({
    name: "config",
    ok: loaded.ok,
    detail: loaded.ok ? configPath : existsSync(configPath) ? loaded.errors.join("; ") : "not set up yet",
    hint: loaded.ok ? undefined : "Run `opencontact setup`.",
  });
  const config = loaded.ok ? loaded.config : null;
  let imsgPath = config?.imsgPath ?? process.env.IMSG_PATH ?? "imsg";
  if (!imsgVersion(imsgPath) && installedReleaseImsg()) imsgPath = installedReleaseImsg() as string;

  const v = imsgVersion(imsgPath);
  checks.push({
    name: "imsg",
    ok: v !== null,
    detail: v ?? `${imsgPath} not found`,
    hint: v ? undefined : "Run `opencontact setup` to install the signed release build, or set IMSG_PATH.",
  });
  if (v) {
    const p = await probeImsg(imsgPath);
    checks.push({
      name: "messages database",
      ok: p.ready,
      detail: p.ready ? "readable" : (p.dbError ?? "not readable"),
      hint: p.ready
        ? undefined
        : "System Settings → Privacy & Security → Full Disk Access → enable your terminal, then reopen it.",
    });
    checks.push({
      name: "send",
      ok: p.canSend,
      detail: p.canSend ? "available" : "unavailable",
      hint: p.canSend
        ? undefined
        : "System Settings → Privacy & Security → Automation → allow your terminal to control Messages.",
    });
  }
  if (config) {
    const brain = createBrain(config, {
      state: new FileStateStore(join(config.stateDir, "state.json")),
      audit: { write() {} },
      log: createLogger({ level: "error", secrets: configSecrets(config) }),
      userAgent: `opencontact/${BRIDGE_VERSION}`,
    });
    const r = await brain.check();
    checks.push({
      name: `brain: ${config.brain.kind}`,
      ok: r.ok,
      detail: r.detail,
      hint: r.ok
        ? undefined
        : config.brain.kind === "bland"
          ? "Check the key at https://app.bland.ai/dashboard/settings, or set BLAND_API_KEY."
          : "Check the key or command in `opencontact status`, or run `opencontact setup` again.",
    });
    checks.push({ name: "mode", ok: true, detail: config.dryRun ? "dry-run (nothing is sent)" : "LIVE" });
    checks.push({
      name: "answers",
      ok: true,
      detail: describeAnswer(config),
    });
  }

  if (args.flags.has("json")) process.stdout.write(`${JSON.stringify({ version: BRIDGE_VERSION, checks }, null, 2)}\n`);
  else
    for (const c of checks) {
      process.stdout.write(`${c.ok ? paint.green("✓") : paint.red("✗")} ${c.name.padEnd(18)} ${c.detail}\n`);
      if (!c.ok && c.hint) process.stdout.write(`    ${c.hint}\n`);
    }
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

async function cmdRun(args: Args, configPath: string): Promise<void> {
  const loaded = loadConfig(configPath);
  if (!loaded.ok) fail(`config is not usable:\n  ${loaded.errors.join("\n  ")}\nRun \`opencontact setup\` first.`);
  const config: BridgeConfig = { ...loaded.config };
  if (args.flags.has("live")) config.dryRun = false;
  if (args.flags.has("dry-run")) config.dryRun = true;
  const answerOverride = flagString(args, "answer") as AnswerMode | undefined;
  if (answerOverride) {
    if (!ANSWER_MODES.includes(answerOverride)) fail("--answer must be everyone, list, or outbound");
    config.answer = answerOverride;
  }

  const level = (flagString(args, "log-level") as Level | undefined) ?? "info";
  let current: { bridge: Bridge; rpc: ImsgRpc } | null = null;
  let shutdown: () => Promise<void> = async () => {};
  const state = new FileStateStore(join(config.stateDir, "state.json"));
  const audit = new JsonlAudit(join(config.stateDir, "audit.jsonl"));
  const names = new Map<string, string>();
  const nameOf = (h: string) => state.load().conversations[h]?.name ?? names.get(h) ?? formatHandle(h);
  // The live view takes the screen in a terminal; --log keeps plain log lines (and anything piped).
  const view =
    process.stdout.isTTY && !args.flags.has("log")
      ? new LiveView({
          title: "opencontact",
          brain: describeBrain(config),
          answers: describeAnswer(config).replace(/^only /, "only "),
          cardName: config.contactCard?.name,
          dryRun: config.dryRun,
          nameOf,
          actions: {
            send: async (handle, text) => {
              if (!current) throw new Error("not connected to Messages");
              const result = await current.rpc.send({ to: handle }, text);
              current.bridge.markOwnSend(result.guid);
              audit.write({
                event: "owner_sent",
                sender: maskHandle(handle),
                chars: text.length,
                ...(result.guid ? { message_guid: result.guid } : {}),
              });
            },
            setManual: (handle, on) => {
              if (on) manualHandles.add(handle);
              else manualHandles.delete(handle);
              current?.bridge.setManual(handle, on);
            },
            setDryRun: (value) => {
              config.dryRun = value;
              current?.bridge.setDryRun(value);
              view?.setDryRun(value);
            },
            quit: () => void shutdown(),
          },
        })
      : null;
  // Conversations a person has taken over survive an imsg restart.
  const manualHandles = new Set<string>();
  const log = view
    ? createLogger({
        level: "warn",
        secrets: configSecrets(config),
        write: (line) => view.note(line.replace(/^\S+\s+/, ""), /ERROR/.test(line) ? "error" : "warn"),
      })
    : createLogger({ level, secrets: configSecrets(config) });
  const brain = createBrain(config, { state, audit, log, userAgent: `opencontact/${BRIDGE_VERSION}` });
  const sentLedger = new FileSentLedger(join(config.stateDir, "sent-guids.txt"));
  const contactCardPath = writeContactCard(config);
  const lock = new RunLock(join(config.stateDir, "run.pid"));
  try {
    lock.acquire();
  } catch (err) {
    fail((err as Error).message);
  }

  if (!view) say();
  if (!view)
    say(
      `${paint.bold("opencontact")} ${BRIDGE_VERSION} · brain: ${describeBrain(config)}${contactCardPath ? ` · card: ${config.contactCard?.name}` : ""}`,
    );
  if (!view) say(`answers: ${describeAnswer(config)}`);
  if (view) view.start();
  else if (config.dryRun)
    say(
      `${paint.yellow("DRY RUN")} · replies are shown here, nothing is sent · press ${paint.bold("L")} to go live, ${paint.bold("Q")} to quit`,
    );
  else
    say(
      `${paint.green("LIVE")} · replies go out through Messages · press ${paint.bold("D")} for dry-run, ${paint.bold("Q")} to quit`,
    );
  if (!view) say();

  let backoffMs = 1_000;
  let stopping = false;

  shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    if (current) {
      await current.bridge.stop();
      current.rpc.close();
    }
    lock.release();
    view?.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      if (view) {
        view.key(key);
        return;
      }
      const k = key.toLowerCase();
      if (k === "q" || key === "\u0003") void shutdown();
      else if (k === "l" && current) {
        config.dryRun = false;
        current.bridge.setDryRun(false);
      } else if (k === "d" && current) {
        config.dryRun = true;
        current.bridge.setDryRun(true);
      }
    });
  }

  while (!stopping) {
    const rpc = new ImsgRpc(spawnImsg(config.imsgPath));
    rpc.on("stderr", (text) => log.debug("imsg", { stderr: text.trim() }));
    const bridge = new Bridge({
      config,
      imsg: rpc,
      brain,
      state,
      audit,
      log,
      sentLedger,
      contactCardPath: contactCardPath ?? undefined,
      events: view
        ? {
            inbound: (e) => {
              if (e.name) names.set(e.handle, e.name);
              view.inbound(e.handle, e.text);
            },
            thinking: (e) => view.thinking(e.handle),
            reply: (e) => view.reply(e.handle, e.text, e.dryRun),
            card: (e) => view.card(e.handle, e.dryRun),
            ownSend: (e) =>
              e.card ? view.card(e.handle, false) : e.text ? view.reply(e.handle, e.text, false, true) : undefined,
            skipped: (e) => {
              view.done(e.handle);
              if (e.reason === "owner_takeover") view.note(`${nameOf(e.handle)}: you have this one, agent stays quiet`);
            },
            takeover: (e) => {
              if (e.text) view.you(e.handle, e.text);
              view.driver(e.handle, "paused");
              view.note(
                `you replied to ${nameOf(e.handle)} from Messages: the agent steps back for ${config.ownerTakeoverMinutes} min`,
              );
            },
            error: (e) => view.note(`${e.where}: ${e.message}`, "error"),
          }
        : undefined,
    });
    current = { bridge, rpc };
    for (const h of manualHandles) bridge.setManual(h, true);
    const exited = new Promise<void>((resolve) => rpc.once("exit", () => resolve()));
    try {
      await bridge.start();
      backoffMs = 1_000;
      await exited;
      if (!stopping) log.warn("imsg exited; restarting");
    } catch (err) {
      log.error("could not start", { error: (err as Error).message });
      rpc.close();
      if (/Full Disk Access|Automation/.test((err as Error).message)) {
        view?.stop();
        say(paint.red(`error: ${(err as Error).message}`));
        process.exit(1);
      }
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }
}

function describeBrain(config: BridgeConfig): string {
  const b = config.brain;
  if (b.label) return `${b.label.replace(/^preset:\S+\s*/, "")}${"personaName" in b ? ` as ${b.personaName}` : ""}`;
  switch (b.kind) {
    case "bland":
      return `Bland agent ${config.agentId}`;
    case "anthropic":
    case "openai":
      return `${b.kind} ${b.model} as ${b.personaName}`;
    case "command":
      return `command \`${b.command}\` as ${b.personaName}`;
  }
}

/** Ask imsg which handle this Mac texts from; null when imsg cannot say. */
async function detectOwnHandle(imsgPath: string): Promise<string | null> {
  const rpc = new ImsgRpc(spawnImsg(imsgPath), 10_000);
  try {
    return inferOwnHandle(await rpc.chats(40));
  } catch {
    return null;
  } finally {
    rpc.close();
  }
}

/** Materialize the configured contact card as a .vcf next to the state; null when none is configured. */
function writeContactCard(config: BridgeConfig): string | null {
  if (!config.contactCard) return null;
  const card: ContactCard = { ...config.contactCard };
  if (card.photoPath && !existsSync(card.photoPath)) card.photoPath = undefined;
  const path = join(config.stateDir, "contact-card.vcf");
  writeFileSync(path, buildVCard(card), { mode: 0o600 });
  return path;
}

async function cmdText(args: Args, configPath: string): Promise<void> {
  const listPath = flagString(args, "list");
  const handle = listPath ? undefined : args.positional[0];
  if (!listPath && !handle)
    fail('usage: opencontact text <phone-or-email> ["why"]   or   opencontact text --list people.csv ["why"]');
  const why = (listPath ? args.positional : args.positional.slice(1)).join(" ").trim() || undefined;
  const loaded = loadConfig(configPath);
  if (!loaded.ok) fail(`config is not usable:\n  ${loaded.errors.join("\n  ")}\nRun \`opencontact setup\` first.`);
  const config = loaded.config;
  const dryRun = args.flags.has("dry-run");
  const log = createLogger({
    level: (flagString(args, "log-level") as Level | undefined) ?? "warn",
    secrets: configSecrets(config),
  });

  let recipients: Array<{ handle: string; name?: string | undefined; context?: string | undefined }>;
  if (listPath) {
    if (!existsSync(listPath)) fail(`no such file: ${listPath}`);
    const parsed = parseRecipients(readFileSync(listPath, "utf8"));
    const max = Number(flagString(args, "max") ?? "50");
    if (parsed.recipients.length === 0) fail(`no phone numbers or emails found in ${listPath}`);
    if (parsed.recipients.length > max)
      fail(`${parsed.recipients.length} recipients is more than --max ${max}. Raise --max if you mean it.`);
    for (const row of parsed.skipped) say(paint.yellow(`  skipping a row with no usable number: ${row}`));
    recipients = parsed.recipients.map((r) => ({ handle: r.handle, name: r.name, context: recipientContext(why, r) }));
    say(
      `${paint.bold(`texting ${recipients.length} ${recipients.length === 1 ? "person" : "people"}`)}${dryRun ? paint.yellow("  (dry run)") : ""}`,
    );
  } else {
    const name = flagString(args, "name");
    const one = { handle: normalizeHandle(handle as string), name, details: {} };
    recipients = [{ handle: one.handle, name, context: recipientContext(why, one) || undefined }];
  }

  // A restriction list must include everyone we are about to text, or their replies would be ignored.
  if (config.answer === "list") {
    const existing = readConfigFile(configPath);
    const have = new Set((existing.allowFrom ?? []).map(normalizeHandle));
    const added = recipients.map((r) => r.handle).filter((h) => !have.has(h));
    if (added.length > 0) {
      saveConfig(configPath, { ...existing, allowFrom: [...have, ...added] });
      say(paint.dim(`added ${added.length} number(s) to the list so the agent can answer their replies`));
    }
  }

  const rpc = new ImsgRpc(spawnImsg(config.imsgPath));
  const state = new FileStateStore(join(config.stateDir, "state.json"));
  const audit = new JsonlAudit(join(config.stateDir, "audit.jsonl"));
  const brain = createBrain(config, { state, audit, log, userAgent: `opencontact/${BRIDGE_VERSION}` });
  const sentLedger = new FileSentLedger(join(config.stateDir, "sent-guids.txt"));
  const contactCardPath = writeContactCard(config) ?? undefined;
  const cols = process.stdout.columns ?? 100;
  let sent = 0;
  let failed = 0;
  let cards = 0;
  try {
    for (const [i, r] of recipients.entries()) {
      const who = r.name ? `${r.name} ${paint.dim(formatHandle(r.handle))}` : formatHandle(r.handle);
      const stop = spinner(`writing to ${r.name ?? formatHandle(r.handle)}`);
      try {
        const result = await startOutbound(
          {
            config,
            brain,
            imsg: rpc,
            state,
            audit,
            log,
            sentLedger,
            contactCardPath,
            dryRun,
            resendCard: args.flags.has("resend-card"),
            name: r.name,
          },
          r.handle,
          r.context,
        );
        sent += 1;
        if (result.cardSent) cards += 1;
        stop(`${dryRun ? paint.yellow("○") : paint.green("✓")} ${who}${result.cardSent ? paint.dim("  + card") : ""}`);
        for (const t of result.sent) {
          const line = `    ${paint.dim("→")} ${t}`;
          say(listPath && line.length > cols - 2 ? `${line.slice(0, cols - 3)}…` : line);
        }
        if (!listPath && result.cardAlreadySent)
          say(paint.dim("  card not sent: this number already has it. `--resend-card` sends the current one."));
      } catch (err) {
        failed += 1;
        stop(`${paint.red("✗")} ${who}  ${paint.dim((err as Error).message)}`);
      }
      // Space out a list so it reads like a person texting, and stays inside the send caps.
      if (listPath && i < recipients.length - 1) await new Promise((res) => setTimeout(res, 1_200));
    }
  } finally {
    rpc.close();
  }
  if (listPath)
    say(
      `${paint.bold(`${sent} sent`)}${failed ? paint.red(` · ${failed} failed`) : ""}${cards ? ` · ${cards} cards` : ""}`,
    );
  say(paint.dim("Replies are answered by `opencontact run`; keep it running."));
  if (failed > 0 && sent === 0) process.exit(1);
}

async function cmdCard(args: Args, configPath: string): Promise<void> {
  if (!existsSync(configPath)) fail(`no config at ${configPath}; run \`opencontact setup\` first`);
  const existing = readConfigFile(configPath);
  if (args.flags.has("off")) {
    saveConfig(configPath, { ...existing, contactCard: undefined });
    process.stdout.write("contact card off\n");
    return;
  }
  const name = args.positional[0] ?? existing.contactCard?.name;
  if (!name)
    fail(
      'usage: opencontact card "Business name" [--logo file.png] [--phone +1…] [--url https://…]   (opencontact card --off to disable)',
    );
  const logo = flagString(args, "logo") ?? existing.contactCard?.photoPath;
  if (logo && !existsSync(logo)) fail(`logo not found: ${logo}`);
  let phone = flagString(args, "phone") ?? existing.contactCard?.phone;
  if (!phone) {
    const loaded = loadConfig(configPath);
    phone = (loaded.ok ? await detectOwnHandle(loaded.config.imsgPath) : null) ?? undefined;
    if (phone) say(paint.dim(`using this Mac's line, ${phone}, as the number on the card`));
    else say(paint.yellow("no number on the card: Add to Contacts will not attach your line. Pass --phone +1…"));
  }
  const card: ContactCard = {
    name,
    phone,
    url: flagString(args, "url") ?? existing.contactCard?.url,
    photoPath: logo,
  };
  saveConfig(configPath, { ...existing, contactCard: card });
  // A changed card should reach everyone again.
  const loadedForState = loadConfig(configPath);
  if (loadedForState.ok) {
    const store = new FileStateStore(join(loadedForState.config.stateDir, "state.json"));
    const st = store.load();
    const had = st.cardSentTo.length;
    st.cardSentTo = [];
    store.save(st);
    if (had > 0) say(paint.dim(`${had} contact(s) will get the new card on their next reply`));
  }
  process.stdout.write(
    `contact card: ${card.name}${card.photoPath ? " with logo" : ""}${card.phone ? ` · ${card.phone}` : ""}. New customers get it after the first reply; \`opencontact text\` sends it with the opener.\n`,
  );
}

function cmdStop(configPath: string): void {
  const loaded = loadConfig(configPath);
  const stateDir = loaded.ok ? loaded.config.stateDir : defaultConfig().stateDir;
  const lock = new RunLock(join(stateDir, "run.pid"));
  const pid = lock.holder();
  if (pid === null) {
    process.stdout.write("opencontact is not running\n");
    return;
  }
  process.kill(pid, "SIGTERM");
  process.stdout.write(`stopped opencontact (pid ${pid})\n`);
}

/** Start a contact over: new conversation, card sent again, local transcript gone. For rehearsing a demo. */
function cmdForget(args: Args, configPath: string): void {
  const raw = args.positional[0];
  if (!raw) fail("usage: opencontact forget <phone-or-email>");
  const handle = normalizeHandle(raw);
  const loaded = loadConfig(configPath);
  const stateDir = loaded.ok ? loaded.config.stateDir : defaultConfig().stateDir;
  const store = new FileStateStore(join(stateDir, "state.json"));
  const state = store.load();
  const had = Boolean(state.conversations[handle]) || state.cardSentTo.includes(handle);
  delete state.conversations[handle];
  state.cardSentTo = state.cardSentTo.filter((h) => h !== handle);
  store.save(state);
  const transcript = new FileTranscriptStore(join(stateDir, "transcripts")).forget(handle);
  say(
    had || transcript
      ? `${paint.green("✓")} forgot ${formatHandle(handle)}: the next text opens a new conversation and sends the card again`
      : `nothing kept for ${formatHandle(handle)}`,
  );
  if (loaded.ok && loaded.config.brain.kind === "bland")
    say(paint.dim("  Bland still remembers this contact; reset its memory at app.bland.ai if you want a stranger."));
}

function cmdOnly(args: Args, configPath: string): void {
  const handles = args.positional.filter((h): h is string => Boolean(h));
  if (handles.length === 0) fail("usage: opencontact only <phone-or-email> [more…]   (opencontact everyone to clear)");
  if (!existsSync(configPath)) fail(`no config at ${configPath}; run \`opencontact setup\` first`);
  const existing = readConfigFile(configPath);
  const set = new Set((existing.allowFrom ?? []).map(normalizeHandle));
  for (const h of handles) {
    const n = normalizeHandle(h);
    if (!isPhoneHandle(n) && !n.includes("@"))
      say(paint.yellow(`"${n}" does not look like a phone number or email; adding it anyway`));
    set.add(n);
  }
  saveConfig(configPath, { ...existing, allowFrom: [...set], answer: "list" });
  process.stdout.write(`answer mode: list · the agent now answers only: ${[...set].join(", ")}\n`);
}

function cmdEveryone(configPath: string): void {
  setAnswer(configPath, "everyone");
}

function cmdAnswer(args: Args, configPath: string): void {
  const mode = args.positional[0] as AnswerMode | undefined;
  if (!mode || !ANSWER_MODES.includes(mode)) {
    const loaded = loadConfig(configPath);
    if (loaded.ok) process.stdout.write(`answer mode: ${loaded.config.answer} · ${describeAnswer(loaded.config)}\n`);
    fail("usage: opencontact answer everyone | list | outbound", mode ? 2 : 0);
  }
  setAnswer(configPath, mode);
}

function setAnswer(configPath: string, mode: AnswerMode): void {
  if (!existsSync(configPath)) fail(`no config at ${configPath}; run \`opencontact setup\` first`);
  const existing = readConfigFile(configPath);
  saveConfig(configPath, { ...existing, answer: mode });
  const loaded = loadConfig(configPath);
  process.stdout.write(`answer mode: ${mode} · ${loaded.ok ? describeAnswer(loaded.config) : ""}\n`);
  if (mode === "list" && (existing.allowFrom ?? []).length === 0)
    say(paint.yellow("the list is empty, so nobody is answered. Add numbers: opencontact only +1…"));
}

function describeAnswer(config: BridgeConfig): string {
  switch (config.answer) {
    case "everyone":
      return "anyone who texts this number";
    case "outbound":
      return "only people the agent texted first";
    case "list":
      return config.allowFrom.length === 0 ? "nobody (the list is empty)" : `only ${config.allowFrom.join(", ")}`;
  }
}

function cmdLog(args: Args, configPath: string): void {
  const loaded = loadConfig(configPath);
  const stateDir = loaded.ok ? loaded.config.stateDir : defaultConfig().stateDir;
  const path = join(stateDir, "audit.jsonl");
  if (!existsSync(path)) {
    process.stdout.write("no audit log yet\n");
    return;
  }
  // `-n 20` arrives as a positional pair since the parser only knows --flags.
  const nIdx = args.positional.indexOf("-n");
  const n = Number(
    flagString(args, "n") ?? flagString(args, "lines") ?? (nIdx >= 0 ? args.positional[nIdx + 1] : undefined) ?? "20",
  );
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .slice(-(Number.isFinite(n) ? n : 20));
  for (const line of lines) {
    const e = JSON.parse(line) as Record<string, unknown>;
    const ts = String(e.ts ?? "")
      .replace("T", " ")
      .slice(5, 19);
    const rest = Object.entries(e)
      .filter(([k]) => k !== "ts" && k !== "event" && k !== "guid")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    process.stdout.write(`${ts}  ${String(e.event).padEnd(14)} ${rest}\n`);
  }
}

function cmdStatus(args: Args, configPath: string): void {
  const loaded = loadConfig(configPath);
  if (!loaded.ok) fail(loaded.errors.join("\n"));
  const c = loaded.config;
  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ configPath, ...describeConfig(c) }, null, 2)}\n`);
    return;
  }
  const card = c.contactCard
    ? `${c.contactCard.name}${c.contactCard.phone ? ` · ${c.contactCard.phone}` : ""}${c.contactCard.photoPath ? " · logo" : ""}`
    : 'none (opencontact card "Business" --logo logo.png)';
  const lines = [
    `brain      ${describeBrain(c)}`,
    `answers    ${describeAnswer(c)}`,
    `mode       ${c.dryRun ? "dry-run (opencontact run --live, or press L)" : "live"}`,
    `card       ${card}`,
    `caps       ${c.maxSendsPerHour}/hour overall · ${c.maxSendsPerSenderPerHour}/hour per contact · owner takeover ${c.ownerTakeoverMinutes} min`,
    `config     ${configPath}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("version")) return void process.stdout.write(`${BRIDGE_VERSION}\n`);
  if (args.flags.has("help") || args.command === "help") return void process.stdout.write(HELP);
  const configPath = flagString(args, "config") ?? DEFAULT_CONFIG_PATH;

  if (args.command === undefined) {
    // Bare `opencontact`: set up the first time, run after that.
    return loadConfig(configPath).ok ? cmdRun(args, configPath) : cmdSetup(args, configPath);
  }
  if (/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(args.command)) {
    // `npx opencontact acmedental.com`: build that business's agent and go live.
    args.flags.set("website", args.command);
    return cmdSetup(args, configPath);
  }
  switch (args.command) {
    case "setup":
    case "init":
      return cmdSetup(args, configPath);
    case "doctor":
      return cmdDoctor(args, configPath);
    case "run":
      return cmdRun(args, configPath);
    case "text":
      return cmdText(args, configPath);
    case "card":
      return cmdCard(args, configPath);
    case "stop":
      return cmdStop(configPath);
    case "forget":
      return cmdForget(args, configPath);
    case "only":
    case "allow":
      return cmdOnly(args, configPath);
    case "everyone":
      return cmdEveryone(configPath);
    case "brain": {
      const who = args.positional[0];
      if (!who) {
        const loaded = loadConfig(configPath);
        if (loaded.ok) process.stdout.write(`brain: ${describeBrain(loaded.config)}\n`);
        fail("usage: opencontact brain bland | claude-code | codex | ollama | anthropic | openai | command", 2);
      }
      if (!existsSync(configPath)) fail("run `opencontact setup` first");
      args.flags.set("brain", who);
      args.flags.set("no-start", true);
      args.positional = [];
      await cmdSetup(args, configPath);
      const after = loadConfig(configPath);
      if (after.ok) say(`${paint.green("✓")} brain: ${describeBrain(after.config)}`);
      return;
    }
    case "answer":
      return cmdAnswer(args, configPath);
    case "log":
      return cmdLog(args, configPath);
    case "status":
      return cmdStatus(args, configPath);
    default:
      fail(`unknown command "${args.command}". Try --help.`, 2);
  }
}

main().catch((err: unknown) => {
  say(paint.red(`error: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
