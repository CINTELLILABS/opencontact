# FAQ

**Do I need a Bland account?**
Not for a persona agent. `--brain claude-code` uses the Claude login already on your Mac, `--brain codex` your
ChatGPT login, `--brain ollama` a local model, and `anthropic`, `openai`, or `command` your own key or program.
All keep a persona file and memory of each thread. For a *business* agent (built from your website, memory
per customer, scenarios, a real number), yes, the agent runs at Bland. You do not need one to start. The skills know how to
sign up from inside your agent harness: Bland texts a code to your phone and hands back an API key, no
browser and no card. That free account has trial credits and no phone number, which is exactly what the
iMessage bridge needs.

**Is this for personal use or businesses?**
Both. The default is a business line: a Bland agent built from your website, answering anyone who texts. A
persona brain (`claude-code`, `anthropic`, and the rest) turns it into an assistant on your own number. If you
want one assistant across WhatsApp, Telegram, and Slack as well, OpenClaw
(https://github.com/openclaw/openclaw) is built for that and uses the same `imsg` underneath.

**Why not just use one of the many iMessage MCP servers?**
Those give a model raw read/send access to your Messages. This gives your customers a business agent:
built from your website, with memory per customer, scenarios, handoff rules, dispositions, and a
dashboard, and a path to SMS, RCS, and voice on the same agent. The transport is the small part.

**What does the brain see?**
The text of messages the agent answers, and the transcript of that conversation. Non-Bland brains also get the
photos in those messages. Nothing about skipped messages, and never your contact list. Keys never leave the Mac
except in the request to the service they belong to.

**Can customers tell it is an agent?**
That is up to the agent's instructions. We recommend the agent say so when asked and introduce itself the
first time. Many jurisdictions require disclosure for automated messaging; the agent's prompt is where to
put it.

**What happens when the Mac sleeps?**
Nothing is answered until it wakes; the bridge then resumes from the last message it handled and answers
what came in while it was asleep. For an always-on line, use a Mac mini with sleep disabled, or move to a
Bland number.

**Will Apple ban my Apple ID?**
We know of no documented case for AppleScript automation of Messages with Full Disk Access granted by the
user, which is what every tool in this space does. We also cannot promise anything on Apple's behalf. Use
a dedicated line for the business and move to a Bland number when volume grows. See
[docs/safety.md](safety.md).

**Can it read photos people send?**
With every brain except Bland, yes: JPEG, PNG, GIF, and WebP, up to three per message. iPhones shoot HEIC; Messages
usually converts it on the way in, and when it does not, the agent is told a photo arrived.

**Can it send pictures, menus, or booking links with previews?**
Not from a Mac: sends are plain text, plus the contact card. A Bland number does all of that, plus RCS branding
and iMessage effects through Bland's messaging partner.

**Can I run it on Linux or Windows?**
Only with a Mac somewhere: `imsg` has to run where Messages is signed in. OpenClaw's pattern is an SSH
wrapper to the Mac; the bridge can point `imsgPath` at a script that does that. Not tested by us yet.

**How do I stop it?**
Press **Q** in the running terminal, or run `opencontact stop` from anywhere. To pause it in one conversation,
reply yourself in Messages; it steps back there for 30 minutes.

**Is the agent's output safe to put in front of customers?**
Read it first if you are unsure. Setup asks whether to go live; say no and you get dry-run. `opencontact only <your
number>` limits it to you while you try the questions your customers actually ask. Fix the agent, then
`opencontact everyone`.
