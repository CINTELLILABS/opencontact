import type { AuditSink } from "./audit.ts";
import type { Brain } from "./brain.ts";
import type { BridgeConfig } from "./config.ts";
import { isEmailHandle, isPhoneHandle, maskHandle, normalizeHandle } from "./handles.ts";
import type { ImsgRpc } from "./imsg.ts";
import type { SentLedger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import type { StateStore } from "./state.ts";

export interface OutboundDeps {
  config: BridgeConfig;
  brain: Brain;
  imsg: Pick<ImsgRpc, "send" | "sendFile">;
  state: StateStore;
  audit: AuditSink;
  log: Logger;
  sentLedger?: SentLedger | undefined;
  /** The business's .vcf; sent right after the opener unless this customer already has it. */
  contactCardPath?: string | undefined;
  dryRun?: boolean | undefined;
  /** Send the card even if this customer already received one (after changing it, say). */
  resendCard?: boolean | undefined;
}

export interface OutboundResult {
  conversationId: string;
  sent: string[];
  cardSent: boolean;
  /** The card was configured but this customer already had it; pass resendCard to send again. */
  cardAlreadySent: boolean;
}

/**
 * `opencontact text <handle> [context]`: the brain speaks first. The reply thread
 * then continues in the running bridge, which shares state on disk.
 */
export async function startOutbound(deps: OutboundDeps, rawHandle: string, context?: string): Promise<OutboundResult> {
  const { brain, imsg, state, audit, log } = deps;
  const handle = normalizeHandle(rawHandle);
  if (!isPhoneHandle(handle) && !isEmailHandle(handle))
    throw new Error(`"${rawHandle}" is not a phone number or email`);

  const turn = await brain.open(handle, context);
  const replies = turn.texts.filter((t) => t.trim().length > 0);
  if (replies.length === 0)
    throw new Error(`the agent produced no opener (status ${turn.status}${turn.error ? `, ${turn.error}` : ""})`);

  const sent: string[] = [];
  for (const text of replies) {
    if (deps.dryRun) {
      audit.write({
        event: "outbound",
        sender: maskHandle(handle),
        conversation_id: turn.conversationId,
        chars: text.length,
        dry_run: true,
      });
      log.info(`DRY RUN → would text ${maskHandle(handle)}: ${text}`);
      sent.push(text);
      continue;
    }
    const result = await imsg.send({ to: handle }, text);
    deps.sentLedger?.add(result.guid ?? "");
    audit.write({
      event: "outbound",
      sender: maskHandle(handle),
      conversation_id: turn.conversationId,
      chars: text.length,
      dry_run: false,
      ...(result.guid ? { message_guid: result.guid } : {}),
    });
    sent.push(text);
  }

  // Remember that we reached out first: answer mode "outbound" keys on it.
  const marked = state.load();
  marked.conversations[handle] = {
    ...(marked.conversations[handle] ?? {
      conversationId: turn.conversationId,
      agentId: deps.config.agentId,
      openedAt: new Date().toISOString(),
    }),
    outbound: true,
  };
  state.save(marked);

  let cardSent = false;
  const fresh = state.load();
  const cardAlreadySent = fresh.cardSentTo.includes(handle);
  if (deps.contactCardPath && !deps.dryRun && (deps.resendCard || !cardAlreadySent)) {
    try {
      const result = await imsg.sendFile({ to: handle }, deps.contactCardPath);
      deps.sentLedger?.add(result.guid ?? "");
      const again = state.load();
      if (!again.cardSentTo.includes(handle)) again.cardSentTo.push(handle);
      state.save(again);
      audit.write({
        event: "card_sent",
        conversation_id: turn.conversationId,
        chat_id: 0,
        ...(result.guid ? { message_guid: result.guid } : {}),
      });
      cardSent = true;
    } catch (err) {
      log.warn("contact card failed", { error: (err as Error).message });
    }
  }
  return { conversationId: turn.conversationId, sent, cardSent, cardAlreadySent: cardAlreadySent && !cardSent };
}
