# Architecture

One process on the Mac sits between Messages and a brain. Everything it decides is in a few small modules.

```
 ┌──────────────┐  JSON-RPC over stdio  ┌──────────────────────────────┐        ┌──────────────────────┐
 │ Messages.app │ ◀──── imsg rpc ─────▶ │ opencontact                  │ ─────▶ │ brain                │
 │ chat.db      │                       │ policy · state · audit · card│ ◀───── │ Bland · Claude Code  │
 └──────────────┘                       └──────────────────────────────┘        │ Codex · API · local  │
                                                                                 └──────────────────────┘
```

## Modules

All in `packages/opencontact/src`. TypeScript, Node 24, no runtime dependencies.

| Module            | Responsibility                                                                         |
| ----------------- | -------------------------------------------------------------------------------------- |
| `imsg.ts`         | JSON-RPC 2.0 client for `imsg rpc`: `watch.subscribe`, `messages.after`, `chats.list`, `send`. |
| `install-imsg.ts` | Installs `imsg` from its signed release: SHA-256 against `SHA256SUMS`, then `codesign` team check. |
| `bridge.ts`       | Sequences one inbound: skip or answer, deliver replies, send the card, advance the cursor. |
| `policy.ts`       | Answer modes, sliding-hour caps, owner takeover, dedupe, the text a brain sees.         |
| `brain.ts`        | The `Brain` interface and its implementations: `BlandBrain`, `LlmBrain` (Anthropic, OpenAI-compatible), `CommandBrain`. |
| `brains.ts`       | Builds the configured brain.                                                            |
| `attachments.ts`  | Picks the photos a brain may see: JPEG, PNG, GIF, WebP, present on disk, under 5 MB.   |
| `bland.ts`        | Bland's API chat endpoints, agent generation, agent listing.                           |
| `outbound.ts`     | `opencontact text`: the brain writes an opener, it is sent, then the card.              |
| `recipients.ts`   | Reads a CSV list for `text --list`: finds the phone and name columns, keeps the rest as details. |
| `vcard.ts`        | The business card as vCard 3.0, with the line's own number and an optional logo.        |
| `state.ts`        | Cursor (last Messages row handled), conversation per contact, who has the card. Atomic writes. |
| `ledger.ts`       | Message ids opencontact sent, shared on disk, so its own sends are never read as the owner typing. |
| `lock.ts`         | One running instance per Mac.                                                           |
| `audit.ts`        | Append-only JSONL of every decision, handles masked.                                    |
| `handles.ts`      | Normalizes phone numbers and emails, masks them for logs, finds the Mac's own number.  |
| `log.ts`          | Leveled logging with secrets redacted.                                                  |
| `config.ts`       | Defaults, then the file, then the environment; validated; written `0600`.               |
| `login.ts`        | Sign in with Bland: the device flow's code, the approval page, and polling for the key. |
| `site-logo.ts`    | Takes a business's logo from its website for the card: touch icon, favicon, `og:image`. |
| `view.ts`         | The live view: conversations sidebar, chat bubbles, the owner's composer.               |
| `ui.ts`           | Setup's screens: step headers, live tasks with a timer, panels, Bland's colors.         |
| `cli.ts`, `prompt.ts` | Commands, guided setup, prompts that degrade when there is no terminal.             |

## One inbound text

1. `imsg` reports a new row in `chat.db`.
2. Edits, unsends, and duplicates are dropped. A row sent from this Mac is either opencontact's own (its id is in
   the ledger) or the owner typing, which pauses the agent in that chat.
3. Group chats are skipped unless enabled. The answer mode decides the rest: `everyone`, only people the agent
   texted first (`outbound`), or a list.
4. If the brain accepts images, up to three photos are picked from the attachments. The text the brain sees says
   an image is attached, or, for Bland, that one arrived and could not be shown.
5. The brain answers.
   - **Bland** reuses the contact's open conversation or opens one with `POST /v1/chat`, keyed on the phone number
     so memory follows the person. `POST /v1/chat/:id/messages` relays the text with the Messages id as the
     idempotency key. A closed conversation is reopened once.
   - **Anthropic** gets the persona as the system prompt, the contact's transcript as turns, photos as image
     blocks, and the server-side web search tool. A paused turn is continued until the model finishes.
   - **OpenAI-compatible** gets the same thread through Chat Completions, photos as data URLs.
   - **Command** gets one composed prompt on stdin and the contact, text, persona, transcript, and photo paths in
     `OPENCONTACT_*` environment variables. Stdout is the reply. The `claude-code` and `codex` presets are
     commands.
6. Each reply passes the caps, then is logged (dry-run) or sent into the same chat. Its id goes into the ledger.
   After the first reply to a new contact, the card goes out once.
7. The cursor advances and state is saved. A restart resumes from there. If the watch buffer overflows, it pages
   forward with `messages.after` and subscribes again.

## Reaching out first

`opencontact text <number> "why"` runs alongside a live `run`. It asks the brain to open the conversation with
the reason as context, sends the opener, marks the contact as outbound in the shared state, and sends the card.
When the person replies, the running process finds the same conversation and answers.

## What lives where

The Mac holds the config and keys, the cursor, the conversation map, persona transcripts, the ledger, and the
audit log, all under `~/.config/opencontact`. With the Bland brain the agent, its memory, and the conversation
records live at Bland. With every other brain, nothing leaves the Mac except the request to the model you chose.

## Why `imsg`

Reading `chat.db` and sending through AppleScript is solved many times over. `imsg` is the one OpenClaw
standardized on: a stable JSON-RPC surface, signed releases, and the unpleasant parts handled (message body
decoding, filesystem events with a polling fallback, delivery outcomes). Depending on it keeps this repository
about the agent.

## The Mac versus a Bland number

|                           | opencontact on a Mac        | Bland number                        |
| ------------------------- | --------------------------- | ----------------------------------- |
| Number                    | the one you already have    | new or ported                       |
| Needs a Mac awake         | yes                         | no                                  |
| Photos in                 | yes, except the Bland brain | yes                                 |
| Photos and links out      | contact card only           | yes                                 |
| Branding on Android       | no                          | RCS name, logo, verified badge      |
| Voice on the same number  | no                          | yes                                 |
| Cost                      | free, plus your brain       | Bland plan and usage                |
