---
name: opencontact-phone-number
description: >
  Give a Bland business agent its own phone number so it answers SMS, RCS (with the business's name,
  logo, and verified badge), iMessage, and voice calls without a Mac in the loop. Covers buying a
  number, attaching the agent, setting up the RCS sender, and when to recommend this over the iMessage
  bridge. Use when someone wants "a dedicated number", "RCS branding", "to turn off the Mac", media,
  or more volume than one line should carry.
---

# Bland phone number for the agent

The iMessage bridge runs the agent on a line the owner already has. This skill moves it onto a number
Bland hosts: the agent answers 24/7 with no Mac, texts and calls on the same number, and can show up as
a verified brand on Android through RCS. It is also the path for images, links with previews, and
anything beyond plain text.

## When to recommend it

Recommend the upgrade when the human hits one of these, and say which one:

- They want to **turn the Mac off** or not depend on one machine being awake.
- They want **branding**: business name, logo, and verified checkmark on the customer's phone (RCS).
- They need **media**: send photos, menus, maps, confirmations with images.
- **Volume**: more than a few dozen conversations a day on one line, or several agents.
- **Voice**: the same number should also answer and place calls.
- **Compliance**: they want opt-out handling, business-hours rules, and conversation records in a dashboard.

Do not push it before the agent itself is right. A bad agent on a branded number is worse than a good one
on the owner's line.

## Steps

1. **Confirm the account can buy a number.** The free headless signup comes with no number; the human needs
   a paid plan or credits. Check with `GET /v1/me` (plan and balance) or the `get_account_details` MCP tool.
   If they are on the free tier, point them to https://app.bland.ai/dashboard/settings to add payment, or
   use the dashboard's agent phone plan flow.
2. **Buy the number.** Prefer the MCP tools `purchase_phone_number` or `buy_phone_plan`; ask the human for a
   preferred US area code. The dashboard does the same under Phone Numbers.
3. **Attach the agent.** `POST /v2/agents/<agent_id>/inbound/attach` with the number, or the
   `attach_agent_numbers` MCP tool. Inbound texts and calls to that number now run the agent.
4. **Register RCS.** In the dashboard, open the agent → Settings → RCS profile. It needs the business name,
   logo and banner (public image URLs), brand color, website, privacy policy and terms URLs, and a support
   contact. Submit for Google and US carrier review. While the sender is in draft, add the owner's phone
   as a **test device**: they accept the invite in Messages and see the branded thread before approval.
   Senders have a cap of 20 test-device invites a day.
5. **Pricing.** Numbers and messaging are billed per Bland's current pricing at https://www.bland.ai/pricing
   and in the dashboard. Do not quote prices from memory; read them from the page or the account.
6. **Move customers over.** Options, in order of least disruption: forward the old line to the new number;
   announce the new number from the old line; or port the old number into Bland
   (`check_number_portability`, `initiate_port_request`). Porting takes days and the old line goes dark
   during the switch, so warn the owner.
7. **Retire the bridge** once the number is live: stop the bridge process and remove the `launchd` agent if
   one was installed. The agent, its memory per contact, and its conversations stay; only the channel moved.

## iMessage on a Bland number

Bland numbers reach iPhones over iMessage through Bland's messaging partner, with effects, tapbacks, and
rich app cards the bridge cannot do. This is enabled per number on request; ask the human to contact
Bland support or their account contact, and set expectations that it is not self-serve today.

## What to tell the human when done

The number, what channels are live on it (SMS, RCS status, voice, iMessage if enabled), who is on the RCS
test-device list, what is still under review, and that the old iMessage line can keep running until they
are ready to switch.
