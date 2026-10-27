# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting: the
**Security** tab of this repository → **Report a vulnerability**. Include a description, steps to reproduce,
and the version or commit affected. You will get an acknowledgement within two business days and a fix or
mitigation plan within 30 days for confirmed issues.

## Scope

- The `opencontact` package and anything under `packages/`
- The skills under `skills/` (for example, a skill that could trick an agent into exfiltrating a key)
- This repository's CI and release configuration

Issues in the Bland platform itself (api.bland.ai, the dashboard) are in scope for Bland's main program; the
same address reaches it.

## What the bridge touches

Reviewers should know what the bridge can reach on a machine, so the threat model is explicit:

- **Reads** the Messages database (`~/Library/Messages/chat.db`) through `imsg`, which needs Full Disk Access.
- **Sends** through Messages.app via `imsg`, which needs Automation permission. Sends are gated by a dry-run
  mode, an optional restriction list, and per-hour caps. See [docs/safety.md](docs/safety.md).
- **Holds** a Bland API key in its config file (`0600`). It never logs the key and never sends it anywhere
  except `api.bland.ai` (or the `apiUrl` you configure).
- **Writes** an append-only audit log of every inbound it acted on and every outbound it sent or would have
  sent.

It does not disable System Integrity Protection, does not use Apple private APIs, and has no runtime
dependencies beyond Node itself.

## Supported versions

Only the latest published minor of `opencontact` receives fixes.
