# Bland API surface this repo depends on

Shapes below were read from Bland's API implementation on 2026-10-26. If the bridge or a skill changes
what it sends, update this file in the same change. Public reference: https://docs.bland.ai.

Base URL `https://api.bland.ai`. Auth header `Authorization: Bearer <API key>`. Responses use an envelope
`{ "data": …, "errors": null | [{ "error": "CODE", "message": "…" }] }`.

## API chat (used by the bridge)

A customer-run chat surface on Bland's messaging pipeline. The conversation's channel is `api_chat`;
inactivity timeout, summary, dispositions, memory, webhooks, and human handoff all behave as they do for a
text thread.

### `POST /v1/chat`

Open (or resume) a conversation for an agent and an end user.

Request:

| Field              | Type    | Notes                                                                 |
| ------------------ | ------- | --------------------------------------------------------------------- |
| `agent_id`         | UUID    | required                                                              |
| `end_user_id`      | string  | required, ≤ 255 chars. The bridge uses the normalized handle.        |
| `contact`          | object  | optional `{ phone_number, email, name }`; links memory to the contact. `name` is 1 to 200 characters; the bridge sends it when `opencontact text` knows who it is texting (`--name`, or a list's name column) |
| `metadata`         | object  | optional, returned on the conversation                                |
| `request_data`     | object  | optional variables for the agent                                      |
| `webhook`          | URL     | optional                                                              |
| `time_out`         | number  | optional inactivity timeout                                           |
| `new_conversation` | boolean | optional, end any open one first                                      |

Response `data`:

```json
{
  "conversation_id": "…",
  "agent_id": "…",
  "end_user_id": "+14155551212",
  "status": "active | ended | timeout | human_handoff",
  "ended": false,
  "created_at": "…",
  "summary": null,
  "disposition": null,
  "variables": null,
  "metadata": { "channel": "opencontact" },
  "messages": []
}
```

Errors seen: `409 CHAT_OPEN_IN_PROGRESS` (another open for this end user is racing; retry),
`409 CONTACT_CONFLICT` (phone, email, and end_user_id belong to different contacts), `403` when the agent
is outside the org's boundary.

### `POST /v1/chat/:conversation_id/messages`

Relay one end-user message. The route waits (bounded) for the agent's turn and returns what it produced.

Request: `{ "message": "<≤ 8000 chars>", "idempotency_key": "<optional>" }`. An empty or missing `message`
asks the agent to speak first. The same `idempotency_key` on the same conversation does not run a second
turn.

Response `data`: the conversation object above with `messages` holding the rows the turn produced, each
`{ id, role: "user" | "agent" | "human", text, created_at }`, plus `error` when the turn ran but the
pipeline reported a problem. An empty `messages` means the turn folded into a reply already being
generated, or the status changed (handoff, timeout, end).

`409` with "This conversation has ended; open a new one" when the status is `ended` or `timeout`. The
bridge reopens and retries once.

### `POST /v1/chat/:conversation_id/end` and `GET /v1/chat/:conversation_id`

End with the same post-conversation analysis a text gets; read the conversation and transcript. The
bridge does not call these; the `opencontact-build-agent` skill uses them for testing.

## Agent generation (used by `opencontact setup` and the `opencontact-build-agent` skill)

### `POST /v2/agents/generate`

`{ "website": "https://…", "request_id": "<8–64 chars [A-Za-z0-9_-], optional>" }` → `201` with
`{ agent_id, version_id, name, summary, scenarios, website }`. Reads the site, writes and publishes a v2
agent in reasoning mode for messaging. Same `request_id` returns the first result. Rate limited to 20 per
org per hour. Requires an API key that may edit agents.

A build takes a minute or two, which can outlast the gateway in front of the API: the client then gets a
`504` while the server keeps building. `setup` sends the same `request_id` again on a `502`, `503`, `504` or a
dropped connection, for up to eight minutes; the server answers with the agent once the first build finishes.
Scenarios come back as names (`string[]`), which `setup` lists.

## Sign-in (device flow, used by `opencontact setup`)

Both calls are public; the owner proves who they are in the browser.

### `POST /v1/agent/onboarding/start`

`{ "client_name": "opencontact" }` → `{ device_code, user_code, verification_url, verification_url_complete,
expires_in, interval }`. `user_code` looks like `PVT7-W7TV`; `verification_url_complete` is
`https://app.bland.ai/agent-setup?code=…`, which setup opens. Codes last 15 minutes (`expires_in: 900`) and the
poll interval is 5 seconds. Checked against production on 2026-10-29.

### `POST /v1/agent/onboarding/poll`

`{ "device_code": "…" }` → `{ status: "pending", interval, expires_in }`, `{ status: "expired" }`, or
`{ status: "approved", api_key, org_id, phone_number, plan, client_name }` once, after the owner approves the code
at the URL. Setup keeps the `api_key` and nothing else. Approving needs an admin or owner of the org; an org without
the Agent Phone Plan is offered the plan on the approval page, and can continue without it only when Bland allows
that (the `agent_onboarding_skip_plan` gate).

## Account

### `GET /v1/me`

Returns the caller's account, plan, and balance. The bridge's `doctor` uses it only to confirm the key is
accepted.

## Hosted MCP

`https://api.bland.ai/v1/mcp`, streamable HTTP, `Authorization: Bearer <API key>`. Serves Bland's action
tools (agents, numbers, SMS, RCS, contacts, analytics) plus docs search. An unauthenticated request gets a
401 whose JSON-RPC error body lists how to authenticate, where a human gets a key, and the signup flows an
agent can run itself (below), each only while enabled.

## Agent onboarding without an account (referenced by the skills)

- **Headless**: `POST /v1/agent/onboarding/headless/start` with `owner_phone` (E.164), `owner_email`,
  optional `client_name`, `payment_intent` (`"shared_payment_token"` or `"none"`), `promo_code`,
  `area_code`. Bland texts the owner a code. `POST /v1/agent/onboarding/headless/complete` with the code
  (and payment, for the paid variant) returns `{ api_key, org_id, phone_number, plan, next_steps }`;
  `phone_number` is `null` on the free variant. Both are behind operational gates and answer `503
  FEATURE_DISABLED` or `402 PLAN_REQUIRED` when off.
- **Device code**: `POST /v1/agent/onboarding/start` → show the owner a link and short code, poll for the key.

Docs: https://docs.bland.ai/platform/agent-headless-onboarding, https://docs.bland.ai/platform/connect-your-agent.
