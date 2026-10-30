# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First public release.

### Added

- Setup screens: numbered steps, live tasks with a timer, a progress bar while the agent builds, the agent's
  scenarios and a preview of the contact card in panels, and a summary with the next commands.
- `npx opencontact <website>`: one command from a URL to a live agent. The contact card takes the business's name
  and its logo from the site (Apple touch icon, then favicon, then `og:image`; PNG or JPEG only).
- `opencontact text --name`, passed to Bland as the contact's name; `opencontact forget <number>` to rehearse from scratch.
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
- `opencontact text <number> "why"`: the agent reaches out first. `--list people.csv` reaches out to a whole
  list, with names and other columns passed to the agent as details.
- A live view for `opencontact run`: every conversation in a sidebar with who is driving it (the agent, you,
  or typing dots), the open conversation as chat bubbles, and a composer. Enter writes into the open
  conversation as the owner and pauses the agent there; A hands it back; F follows the latest activity.
  `--log` keeps plain log lines.
- Replies to different conversations run in parallel; each conversation stays in order, and the resume point
  never passes a message still being answered.
- Contact card: a vCard with the business name, logo, and the line's own number, sent once per contact.
- Owner takeover, hourly caps, deduplication, a resumable cursor, a single-instance lock, and a JSONL audit log
  with masked handles.
- `status`, `log`, `doctor`, `stop`, `card`, `only`, `everyone`.
- Skills for any harness that reads them: `opencontact-build-agent`, `opencontact-run`,
  `opencontact-phone-number`, plus a Claude Code plugin manifest.
