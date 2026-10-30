# opencontact

Put an AI agent behind the iMessage number already on your Mac: a [Bland](https://bland.ai) business agent,
Claude Code, Codex, a local model, or your own API key. People text the number they have saved; the agent
answers from it and sends your contact card.

```sh
npx opencontact
```

That runs the guided setup (installs `imsg`, signs you in to Bland in the browser, builds the agent, walks
through the macOS permissions) and starts. `npx opencontact acme-dental.com` does the same for that website. Scripted:

```sh
npx opencontact setup --api-key "$BLAND_API_KEY" --website https://acme-dental.com --yes   # Bland, dry-run
npx opencontact setup --brain claude-code --name "Alex" --describe "…" --yes              # your Claude login
npx opencontact run --live
```

Zero runtime dependencies. Node 24+. The full story, the skills that drive this for you from Claude Code or
Codex, and the safety model are in the [repository README](https://github.com/CINTELLILABS/opencontact).

## Commands

| Command                        | What it does                                                     |
| ------------------------------ | ---------------------------------------------------------------- |
| `setup`                        | Guided or flag-driven setup; writes `~/.config/opencontact/config.json` (mode 0600). |
| `<website>`                    | Setup that builds the agent, and a card with its name and logo, from this site. |
| `doctor [--json]`              | Check platform, imsg, Full Disk Access, Automation, API key.     |
| `run [--live\|--dry-run]`      | Watch Messages and relay to the agent. L live, D dry-run, Q quit. Restarts imsg if it dies. |
| `text <number> "why"`          | The agent reaches out first, then sends the card. `--name`, `--resend-card`. |
| `text --list people.csv "why"` | Reach out to everyone on a list; other columns become details.  |
| `forget <number>`              | Start a contact over: new conversation, card sent again.         |
| `answer everyone\|outbound`    | Answer anyone, or only people the agent texted first.            |
| `only <handle…>` / `everyone`  | Answer only these handles while testing, or go back.             |
| `brain <name>`                 | Switch who answers.                                              |
| `card "Name" --logo file.png`  | Set the contact card.                                            |
| `status` / `log` / `stop`      | What is configured, recent decisions, stop the running agent.    |

Environment overrides: `BLAND_API_KEY`, `BLAND_AGENT_ID`, `BLAND_API_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`IMSG_PATH`.

## Config

```json
{
  "brain": { "kind": "bland" },
  "answer": "everyone",
  "apiKey": "…",
  "apiUrl": "https://api.bland.ai",
  "agentId": "11111111-1111-4111-8111-111111111111",
  "dryRun": true,
  "allowFrom": [],
  "groups": false,
  "maxSendsPerHour": 60,
  "maxSendsPerSenderPerHour": 20,
  "ownerTakeoverMinutes": 30,
  "attachments": "describe",
  "imsgPath": "imsg",
  "stateDir": "~/.config/opencontact"
}
```

A persona brain looks like `{ "kind": "anthropic", "apiKey": "…", "model": "claude-opus-5-5", "personaPath":
"~/.config/opencontact/persona.md", "personaName": "Alex" }`. State (`state.json`), transcripts, and the audit log
(`audit.jsonl`) live in `stateDir`.

## Programmatic use

```ts
import {
  Bridge, ImsgRpc, spawnImsg, FileStateStore, JsonlAudit, createBrain, createLogger, configSecrets, loadConfig,
} from "opencontact";

const loaded = loadConfig();
if (!loaded.ok) throw new Error(loaded.errors.join("\n"));
const config = loaded.config;
const state = new FileStateStore(`${config.stateDir}/state.json`);
const audit = new JsonlAudit(`${config.stateDir}/audit.jsonl`);
const log = createLogger({ secrets: configSecrets(config) });
const bridge = new Bridge({
  config,
  imsg: new ImsgRpc(spawnImsg(config.imsgPath)),
  brain: createBrain(config, { state, audit, log, userAgent: "my-app" }),
  state,
  audit,
  log,
});
await bridge.start();
```

## License

MIT
