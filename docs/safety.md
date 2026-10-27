# Safety model

An agent that can text people from a real person's line deserves conservative defaults. These are the
bridge's, and the reasoning behind each. Changing any of them is a deliberate act in the config.

## Defaults

| Setting                     | Default      | Effect                                                                     |
| --------------------------- | ------------ | -------------------------------------------------------------------------- |
| `dryRun`                    | `true` in config; setup asks, and **L** flips it live | Replies are logged with `DRY RUN →` until live. |
| `answer`                    | `everyone`   | `everyone`: anyone who texts. `list`: only `allowFrom`. `outbound`: only people the agent texted first. |
| `allowFrom`                 | `[]`         | The list for `answer: "list"`.                                              |
| `groups`                    | `false`      | Group chats are ignored.                                                   |
| `maxSendsPerHour`           | `60`         | Global cap on agent replies per rolling hour.                              |
| `maxSendsPerSenderPerHour`  | `20`         | Per-customer cap.                                                          |
| `ownerTakeoverMinutes`      | `30`         | After the owner types in a chat, the agent is silent there for 30 minutes. |
| `attachments`               | `"describe"` | Attachments a brain cannot see become a short note in the text it gets.    |
| `contactCard`               | asked in setup | One vCard per contact. Changing the card sends it again on their next reply. |

## Why each exists

- **Dry-run is one keypress away.** Setup asks whether to go live; anyone unsure says no and reads the agent's
  replies on screen first. In a live run, **D** drops back to dry-run instantly.
- **Three answer modes, one word each.** A business line answers everyone who texts it. An outreach line
  (`answer outbound`) talks only to people the agent texted first, so a cold inbound from a stranger is ignored.
  A test line (`only <number>`) talks only to the numbers you list. The run banner and `status` always say which.
- **Caps.** A runaway loop (two bots talking, a customer sending 50 messages) should hit a wall, not a
  phone. Dropped replies are logged as `rate_limited` with the scope.
- **Owner takeover.** The person whose line this is must always win. Typing a reply in Messages pauses the
  agent in that chat; no command needed. The bridge recognizes its own outbound by guid so it does not
  pause itself.
- **No private APIs.** Typing indicators, read receipts, and tapbacks via injection require disabling System
  Integrity Protection. We will not ask users to do that, so those features are out of scope here. They
  exist on Bland numbers through Bland's messaging partner instead.
- **Idempotent relays.** Each inbound's Messages guid is the idempotency key for the Bland turn, and seen
  guids are deduplicated locally. A replayed watch event does not produce a second reply.
- **Resumable cursor.** On restart the bridge continues after the last handled row. It never answers a
  backlog of old messages; a fresh install starts at the tail.

## Bring-your-own brains

With `--brain claude-code|codex|ollama|anthropic|openai|command`, message text goes to that program or vendor
instead of Bland, and a transcript per contact is kept under `~/.config/opencontact/transcripts/` (mode 0600) so
the persona remembers the thread.

The `claude-code` preset runs `claude -p` with only `Read`, `WebSearch`, and `WebFetch`: it can open the photos
people send and look things up, but it cannot write files or run commands. The `codex` preset runs `codex exec`
in its read-only sandbox. opencontact never reads the CLIs' credentials; it only runs them. A `command` brain
runs with your full account; what it can do is whatever the command allows, so give it no more than it needs. The vendor key lives in the config file beside the Bland key and is redacted the same way. The
Anthropic brain sends `fallbacks: "default"`, so a safety decline is re-run on a fallback model inside the same
call; a reply that is still declined is simply not sent.

## Images

When the brain accepts images (every brain except Bland), photos people send are read from
`~/Library/Messages/Attachments` and sent to that brain: to Anthropic or OpenAI as part of the request, or to a
command as file paths. Only JPEG, PNG, GIF, and WebP under 5 MB, at most three per message. Nothing is copied
elsewhere and nothing is sent for messages the agent does not answer.

## What gets installed

`opencontact` installs `imsg` from the project's GitHub release: it downloads `imsg-macos.zip` and `SHA256SUMS`, refuses
the binary unless the hash matches and `codesign` reports the author's Developer ID team (`Y5PE65HELJ`), then
unpacks it to `~/.local/share/opencontact/imsg`. Homebrew is only a fallback, because its formula compiles from source
and needs current Command Line Tools.

## Data handling

- The API key lives in `~/.config/opencontact/config.json`, mode `0600`, and is redacted from
  every log line and from `status` output.
- Message text goes only to the brain you chose. With Bland, attachments are never uploaded and only their type
  is mentioned; other brains receive photos as described under Images.
- The audit log masks handles to the last four characters. It is for the owner's own review and lives
  next to the config, mode `0600`.
- Nothing is sent to any brain for messages that were skipped (outside the answer mode, group chats, the owner's own).

## Apple

Apple does not document or support automating Messages.app. Every open-source iMessage tool, including
`imsg`, works through Full Disk Access to `chat.db` and AppleScript Automation, both of which macOS asks
the user to grant explicitly. We know of no documented account action for this use, and we also cannot
promise there will never be one. Our recommendation, in the skill and the README: run the business's
line on a dedicated Apple ID or phone number, not someone's personal account, and move to a Bland number
when the agent is handling real volume.

## Reporting

Security issues: see [SECURITY.md](../SECURITY.md). Behavior you think is unsafe but not a vulnerability:
open an issue with the audit lines involved (mask what you need to).
