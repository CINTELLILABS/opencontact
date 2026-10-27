---
name: opencontact-build-agent
description: >
  Create, test, and edit a Bland business agent that answers customers over text (iMessage, SMS, RCS)
  and voice. Builds the agent from the company's website, with per-customer memory and scenarios.
  Use when someone wants "an AI agent for my business", "a bot that texts my customers back", or asks
  to change how their Bland agent behaves. Works with or without an existing Bland account.
---

# Bland business agent

Bland hosts the agent. You, the harness, talk to Bland through its MCP server or REST API and never run
the model yourself. The agent you create here answers on any channel Bland attaches to it: the iMessage
line on the owner's Mac (see `opencontact-run`), a Bland phone number with SMS and RCS
(see `opencontact-phone-number`), or an in-app chat.

## When to use

- The human wants an agent for a business and has a website for it.
- The human wants to change an existing agent: tone, scenarios, what it may promise, when it hands off.
- The human wants to test an agent in a chat before putting it in front of customers.

## Connect to Bland

1. **Prefer the MCP server.** URL `https://api.bland.ai/v1/mcp`, header `Authorization: Bearer <BLAND_API_KEY>`.
   Claude Code: `claude mcp add --transport http bland https://api.bland.ai/v1/mcp --header "Authorization: Bearer $BLAND_API_KEY"`.
   Other clients: see https://docs.bland.ai/integrations/mcp/clients. The same key works for the REST
   API at `https://api.bland.ai`.
2. **No key yet?** Do not stop. The MCP server's 401 response body describes two signup flows an agent
   can run itself:
   - **Headless** (`POST /v1/agent/onboarding/headless/start` with `owner_phone` in E.164 and `owner_email`):
     Bland texts the owner a code; relay it to `/headless/complete` and receive `{ api_key, org_id, phone_number, plan }`.
     The free variant needs no card and comes with trial credits and **no phone number**; that is fine for
     the iMessage bridge, which uses the owner's existing line.
   - **Device code** (`POST /v1/agent/onboarding/start`): show the owner a link and short code, they sign
     up or in and approve in a browser, you poll for the key.
   Docs: https://docs.bland.ai/platform/agent-headless-onboarding and https://docs.bland.ai/platform/connect-your-agent.
3. Store the key where the harness keeps secrets (environment variable `BLAND_API_KEY`, keychain, the
   plugin's user config). Never paste it into chat, a skill, or a commit.

## Build the agent from the website

1. Ask for the company website if it was not given. Confirm the business name you see there.
2. Call `POST /v2/agents/generate` with `{ "website": "https://acme-dental.com", "request_id": "<random 8-64 chars>" }`
   (or the equivalent MCP tool if the server lists one). Bland reads the site, writes the role, voice,
   facts, deep links, 4 to 8 scenarios with captures, and a memory schema, then publishes a v2 agent in
   reasoning mode for messaging. The response is `{ agent_id, version_id, name, summary, scenarios, website }`.
   Repeating the same `request_id` returns the same agent instead of making another. The route is
   limited to 20 generations per org per hour.
3. Read the `summary` and `scenarios` back to the human in two or three sentences. Ask what is wrong
   before anything else: hours, services it should not promise, the handoff rule.
4. Save the `agent_id`. The bridge and the phone-number skill both need it.

## Test it in a chat before customers see it

Use API chat, which runs the exact pipeline a text does:

1. `POST /v1/chat` with `{ "agent_id": "<id>", "end_user_id": "test-<your-name>" }` → `{ conversation_id, status, messages }`.
2. `POST /v1/chat/<conversation_id>/messages` with `{ "message": "Do you take Delta Dental?" }`. The agent's
   replies come back in `messages` (role `agent`). An empty `message` asks the agent to open.
3. Try the edge cases the human cares about: a question the site does not answer, a request to speak to a
   person, something out of scope. Note where it over-promises.
4. `POST /v1/chat/<conversation_id>/end` when done so the conversation gets its summary and disposition.

## Edit the agent

- Use the MCP tools for agents (`get_agent`, `save_agent_version`, `publish_agent`) or the dashboard. Change
  the system prompt or scenarios, save a version, test again with API chat, then publish.
- Keep changes small and named: "softer greeting", "never quote prices", "hand off on 'cancel'".
- The dashboard at https://app.bland.ai shows conversations, dispositions, and memory per contact.

## What to tell the human when done

- The agent's name, one line on what it does, and its `agent_id`.
- Where it is reachable now (nowhere yet, or the channel you attached).
- Two next steps, in order: run it behind their own iMessage line with `opencontact-run`, and when
  they want a dedicated number with RCS branding and no Mac involved, `opencontact-phone-number`.

## Do not

- Do not invent facts about the business. Everything the agent says should trace to the site or the owner.
- Do not go live in front of real customers without the owner saying so; `opencontact` asks, and `--only` exists for testing.
- Do not log, echo, or commit the API key.
