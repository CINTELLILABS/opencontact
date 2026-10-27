# AGENTS.md

Orientation for coding agents working in this repository.

## What this repo is

Two deliverables, one purpose: put a business's Bland agent behind the iMessage line its customers already text.

1. `skills/` are agent skills (`SKILL.md`) for any harness. They are documentation for an agent, not code.
   They talk to Bland's hosted MCP (`https://api.bland.ai/v1/mcp`) or REST API and never contain secrets.
2. `packages/opencontact/` is a small TypeScript daemon. It drives `imsg rpc` (JSON-RPC over stdio) to
   watch and send iMessages on the Mac it runs on, hands each inbound to a brain (Bland's API chat, Anthropic,
   an OpenAI-compatible server, or a local command such as `claude -p`), and sends the reply back through
   Messages.app. `docs/architecture.md` maps the modules.

## Rules that matter here

- **Safety defaults do not loosen.** Send caps, the owner-takeover pause, dry-run reachable with one key, the
  answer modes, and read-only tools for the CLI presets. Keep them.
- **Zero runtime dependencies in the bridge.** Node 24 has `fetch`, `child_process`, `fs`, `crypto`. Use them.
- **Pin everything.** Exact versions in `package.json`, lockfile committed, Actions pinned to commit SHAs.
- **Never log or print the API key.** Config lives at `~/.config/opencontact/config.json` with mode
  `0600`. Redact it from any error.
- **Do not add private-API features** (typing indicators, read receipts, tapbacks via injection). They need SIP
  disabled and we will not ask users to do that.
- **Skills are read by models.** Write for the model: when to use, numbered steps, what to say to the human.
  Keep each under ~200 lines. Run `pnpm lint:skills`.

## Verify before you claim done

```sh
pnpm install --frozen-lockfile
pnpm check            # lint:skills + typecheck + vitest
```

For a real run you need a Mac signed into Messages, Full Disk Access and Automation granted to your terminal,
and a brain (a Bland key, an API key, or Claude Code or Codex logged in). `opencontact setup` installs `imsg`. `pnpm --filter opencontact dev doctor`
tells you what is missing.

## Where facts about the Bland API come from

`docs/bland-api.md` records the request and response shapes this repo depends on and where they were
verified. If you change what the bridge sends, update that file in the same change.
