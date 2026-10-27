# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First public release.

### Added

- `npx opencontact`: guided setup on the Mac signed into Messages. Installs `imsg` from its signed release
  (SHA-256 and Developer ID checked), asks who should answer, walks through Full Disk Access and Automation,
  and starts.
- Brains: `bland` (a business agent built from your website), `claude-code` and `codex` (the official CLIs with
  the login already on the Mac), `anthropic` and `openai` (your key, with any OpenAI-compatible server),
  `ollama` (local, auto-detected), and `command` (any program, prompt on stdin, reply on stdout).
  `opencontact brain <name>` switches between them.
- Photos people send reach every brain except Bland. Web search for the Anthropic brain and the Claude Code
  preset.
- Answer modes: `everyone`, `outbound` (only people the agent texted first), and a list for testing.
- `opencontact text <number> "why"`: the agent reaches out first.
- Contact card: a vCard with the business name, logo, and the line's own number, sent once per contact.
- Owner takeover, hourly caps, deduplication, a resumable cursor, a single-instance lock, and a JSONL audit log
  with masked handles.
- `status`, `log`, `doctor`, `stop`, `card`, `only`, `everyone`.
- Skills for any harness that reads them: `opencontact-build-agent`, `opencontact-run`,
  `opencontact-phone-number`, plus a Claude Code plugin manifest.
