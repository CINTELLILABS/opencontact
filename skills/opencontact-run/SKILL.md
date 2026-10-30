---
name: opencontact-run
description: >
  Run a Bland business agent behind the iMessage line already on a Mac, with no phone number to buy
  and no carrier paperwork. Installs imsg, configures the bridge, checks macOS permissions, runs a
  dry-run, then goes live for everyone who texts. Use when someone wants their agent "in iMessage",
  "on my existing number", or "answering texts from my Mac".
---

# Bland iMessage bridge

The bridge is a small daemon on the Mac that is signed into Messages for the business. It watches new
iMessages, relays each one to the Bland agent through API chat, and sends the agent's reply back
through Messages.app. Customers text the number they already have saved; the agent answers from it.
Nothing leaves the Mac except the message text going to Bland.

Package: `opencontact` (`npx opencontact`). Source and docs: https://github.com/CINTELLILABS/opencontact.

## When to use

- The human already created an agent (has an `agent_id`; otherwise run `opencontact-build-agent` first), **or** they
  want a persona agent with their own model: `--brain claude-code` (their Claude Code login), `--brain codex`
  (their ChatGPT login), `--brain ollama` (local), or `--brain anthropic|openai|command` need no Bland account. The
  persona is `~/.config/opencontact/persona.md`; write it with them. Business features (website → agent, memory per
  customer, scenarios, a real number) are Bland-only; say so once, then respect their choice.
- They want it answering on an iMessage line they control, from a Mac they can leave running.
- Text in, text out, plus the contact card. With a non-Bland brain the agent also sees photos people send;
  with Bland it is told one arrived. The agent cannot send images on this path. For media out, tapbacks, and a
  branded sender, see `opencontact-phone-number`.

## Requirements to check first

- macOS 14 or newer, signed into Messages with the Apple ID or phone number customers text.
- Node 24 or newer (`node --version`). `opencontact` installs `imsg` itself from the project's signed release build (no Homebrew or compiler needed).
- A brain: a Bland API key and the agent's UUID (or a website to build one from), Claude Code or Codex logged in,
  Ollama running, or an Anthropic or OpenAI key.
- The human can click through two System Settings prompts: Full Disk Access and Automation → Messages for
  the terminal that will run the bridge.

Recommend a **dedicated Apple ID or line for the business** when the Mac is also someone's personal
machine: by default the agent answers everyone who texts the line, which is what a business line wants and
not what a personal one does. `--only <number>` restricts it while testing.

## Steps

1. **One command does the setup.** Run it non-interactively with everything you already know:
   ```sh
   npx opencontact setup --api-key "$BLAND_API_KEY" --agent <agent-uuid> --yes
   ```
   `--yes` installs `imsg` if it is missing (signed release build, checksum and Developer ID verified; Homebrew only as a fallback) and skips confirmations. Without `--agent` you can
   pass `--website <url>` and `opencontact` builds the agent itself, with a contact card carrying the business's
   name and the logo from its site. Config lands in `~/.config/opencontact/config.json`
   (mode 0600). The agent answers anyone who texts the line. If the owner wants to try it alone first, add
   `--only <owner's own phone>`; `npx opencontact everyone` opens it back up.
2. **Permissions.** `opencontact` probes imsg and prints the exact System Settings path when something is missing:
   - Messages database not readable → Privacy & Security → Full Disk Access → enable the terminal app, then
     quit and reopen the terminal.
   - Send unavailable → Privacy & Security → Automation → allow the terminal to control Messages. macOS shows
     this prompt on the first live send; if it was dismissed, toggle it here.
   Run `npx opencontact doctor` until every line is ✓.
3. **Dry-run.** `npx opencontact run`. Have the owner text the line from their phone. The terminal shows
   `DRY RUN → would send …` with the agent's reply. Nothing is sent. Read it with them.
4. **Go live for the owner only.** Press **L** in the running terminal (or start with `npx opencontact run --live`).
   The owner texts again and the reply lands in Messages. This is the demo moment.
5. **Pick who it answers.** `npx opencontact answer everyone` for a business line, `npx opencontact answer outbound`
   when the agent should only talk to people it texted first (outreach, never strangers), `npx opencontact only
   +1…` for a test line. Group chats stay off unless `"groups": true`. `npx opencontact log` shows what it did and why.
6. **Keep it running.** A terminal left open on a Mac mini, or a `launchd` agent. `opencontact` restarts imsg if it
   exits and resumes from the last handled message, so a restart never replays old texts.

## Reaching out first

`npx opencontact text +14155551212 "follow up on Thursday's cleaning quote"`. The agent writes the opener from the
context and sends it; the reply is answered by the running `opencontact run`. If a restriction list is set, the
number is added to it automatically. `--dry-run` previews the opener.

## Reaching out to a list

`npx opencontact text --list people.csv "why"` texts everyone on a list with a phone column; names and other
columns become details for each person. It refuses more than 50 people unless `--max` is raised. Pair it with
`answer outbound` so the agent only talks to people it reached out to.

## Contact card

Setup asks whether to send one (business name, optional logo); `npx opencontact card "Business" --logo logo.png` sets it
later without re-running setup. After the agent's first reply to a new
customer, it sends the vCard once; the customer taps "Add to Contacts" and sees the business name from then
on. Flags: `--card-name`, `--card-phone`, `--card-logo <png|jpg>`, `--no-card`.

## The live view

`npx opencontact run` opens a window with every conversation in a sidebar. Tell the owner: arrow keys switch
conversations, Enter writes into the open one as themselves (their message goes out from their number and
the agent pauses there), A hands it back to the agent, F follows the latest activity, Q quits.

## Things the owner should know

- **They can take over any time.** When the owner types a reply in Messages, the agent pauses in that chat
  for 30 minutes (`ownerTakeoverMinutes`). The bridge recognizes its own sends and does not pause for them.
- **Speed.** The agent answers in the time its reasoning takes, typically 5 to 20 seconds for an agent that
  reads the website live. If the owner wants faster, lower the agent's reasoning effort in the Bland
  dashboard (or through the MCP agent tools); `opencontact` itself adds well under a second.
- **Caps.** 60 agent replies per hour overall and 20 per customer by default. Raise them in the config once
  volume is understood.
- **Audit log.** `~/.config/opencontact/audit.jsonl` has one line per decision. Phone numbers are
  masked to the last four digits.
- **Handoff.** If the agent hands the conversation to a human (`status: human_handoff`), the log says so;
  the owner replies from Messages.
- **Apple's rules.** Automating Messages.app is not something Apple documents or supports. The bridge uses
  only public AppleScript automation, never private APIs, and never asks to disable SIP. A dedicated line
  for the business is the conservative choice.

## Troubleshooting

- `opencontact is already running (pid N)` → another `opencontact run` is alive, perhaps in a terminal you forgot. `npx opencontact stop`
  ends it. Never run two: each answers every text and reads the other's sends as the owner typing.
- `imsg exited; restarting` repeatedly → run `<imsgPath from opencontact status> chats --limit 3` by hand and read its error.
- Replies arrive from a different number than expected → the Apple ID has several send-from addresses.
  Messages → Settings → iMessage → "Start new conversations from" picks the default.
- `409 CHAT_OPEN_IN_PROGRESS` or `conversation closed; opening a new one` in the log are normal: the
  bridge reopens and resends.
- Nothing happens when a customer texts → `doctor`, then check `status` for a leftover `only` restriction.

## What to tell the human when done

Which line is answering, whether it answers everyone or a restricted list, whether it is live or dry-run, how to pause (`Ctrl-C`, or just
reply yourself in Messages), and that `opencontact-phone-number` is the path to a dedicated number with RCS
branding when they want to turn the Mac off.
