# The 90-second demo

For the person recording a video, the influencer, or the founder showing a friend. Everything here is
real; nothing is staged. Adjust the business and the question to the viewer.

## Before you record

- A Mac signed into Messages with a line you are happy to show on camera (a second Apple ID is ideal).
- An iPhone in frame that is **not** that line, to text it from.
- Node 24 and a Bland API key in `BLAND_API_KEY`. `opencontact` installs `imsg` itself.
- Pick a real small business website you have permission to use, or your own.
- Terminal font large. Messages window on the Mac visible, or the iPhone screen mirrored.

## The take

**0:00 Hook.** On camera: "This is my business's text line. Watch it answer a customer by itself in about
a minute, with nothing but my Mac."

**0:10 One command.** In the terminal:

```
npx opencontact
```

Say: "That's the install." It asks for your Bland key (paste it, hidden), then your website.

**0:25 Build the agent from the website.** Type `acme-dental.com`. A spinner runs for about a minute while
Bland reads the site and writes the agent. Narrate what it prints back: the agent's name, the one-line
summary, the scenario count. "It found the hours, the insurance page, the booking link." It asks whether it
should answer everyone; say yes. Then it asks whether to go live or watch first; say watch, for the next beat.

*Variant for the coding-agent crowd:* `npx skills add CINTELLILABS/opencontact`, then tell Claude Code or Codex
"build a Bland agent for acme-dental.com and run it on this Mac's iMessage, only answer my number." Same
result, from inside the harness, and it can keep editing the agent afterwards.

**0:55 Approve the permissions.** macOS asks for Full Disk Access and Automation → Messages. Click
through. Say: "That's macOS asking if my terminal may read and send texts. Yes."

**1:05 Dry-run.** From the iPhone, text the line: "do you take Delta Dental?" The terminal prints
`DRY RUN → would send …` with the answer. Read it. "Nothing sent yet. I get to see what it would say."

**1:15 Go live.** Press **L** in the terminal. The banner flips from DRY RUN to LIVE.
Text again: "can I come in Thursday after 4?" The reply lands in Messages on the iPhone, from the
business's line, in a few seconds.

**1:25 Takeover.** Type a reply yourself from the Mac's Messages. Say: "If I answer, it steps back for
half an hour. My line, my rules."

**1:30 Close.** "That's a real agent on a real iMessage line, in 90 seconds, free. When I want it to run
without my Mac, with my logo on Android and a real phone number, that's one more command." Show
`opencontact-phone-number` in the skill list. Cut.

## Lines that land

- "No new number. No carrier forms. It answers from the number my customers already have saved."
- "Everything it says comes from my website. If my site is wrong, it's wrong, and I fix it in one place."
- "I can read every reply before anyone else does. Dry-run is the default."

## Things that go wrong on camera

- **Permission prompt never appears.** The Automation prompt only shows on the first real send. Trigger it
  before recording with `imsg send --to <your number> --text test`, so the take is not interrupted.
- **Reply came from an email address, not the phone number.** Messages → Settings → iMessage → "Start new
  conversations from". Pick the number.
- **Agent says something you do not love.** Good: that is the edit moment. "Make it shorter and never
  quote prices" → the harness edits and republishes. Thirty extra seconds, very convincing.
