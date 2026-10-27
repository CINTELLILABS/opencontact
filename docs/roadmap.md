# Roadmap

Rough order. Issues welcome on any of these; say which one you are picking up.

## Soon

- **OpenClaw channel plugin.** `openclaw plugins install clawhub:bland/opencontact`: the same relay as
  the bridge, as a channel inside OpenClaw's gateway, so people already running OpenClaw with `imsg` get
  a business agent without a second process. Blocked on reading the current `defineChannelPluginEntry`
  API; see https://docs.openclaw.ai/plugins/building-plugins.
- **Media in for the Bland brain.** Bland's API chat is text-only today; the other brains already see photos. When the chat route accepts attachments, the Bland brain will
  upload photos the customer sends instead of describing them.
- **`launchd` installer.** `opencontact install-service` writing a LaunchAgent plist so the bridge
  survives reboots on a Mac mini.
- **Scoped key.** A `chat:write`-only Bland API key for the bridge so the key on the laptop cannot read
  the whole account.

## Later

- **Mastra / Vercel AI SDK / Spectrum adapters.** Let people who already have an agent framework point it
  at a Bland agent as a tool, or expose the bridge as a platform in those frameworks.
- **Multiple agents on one Mac.** Route by chat (a second line for a second business) from one config.
- **Linux and Windows hosts.** `imsg` runs over SSH to a Mac; the bridge should accept an `imsgPath` that
  is an SSH wrapper, the way OpenClaw does.
- **Inbound from the dashboard.** Show bridge conversations with a channel badge in Bland's Conversations
  list (they appear as `api_chat` today).

## Not planned

- Anything that needs System Integrity Protection disabled (typing indicators, read receipts, tapbacks via
  injection). Those exist on Bland numbers through Bland's messaging partner.
- Running the model locally. The point of this repo is the agent Bland hosts; the channel is what you own.
