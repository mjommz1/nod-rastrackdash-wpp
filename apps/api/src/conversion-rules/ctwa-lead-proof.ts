import type { Prisma } from "@prisma/client";
import { authorizedCtwaDestinationSchema } from "@wpptrack/shared";
import {
  CTWA_DESTINATION_AD_HINT_REASON,
  CTWA_DESTINATION_PROVIDER,
  CTWA_DESTINATION_REASON,
  ctwaDestinationProviderValue,
  ctwaIntentAuthorized,
  type AuthorizedCtwaDestination,
} from "../inbound-webhooks/authorized-ctwa-destination";
/** Require a materialized first-entry receipt for the same lead, click and
 * channel. A CRM phone match, observed event, or shared pixel is insufficient.
 * The click (ctwa_clid) is always required: without it there is no proof. */
export async function resolveCtwaLeadProof(
  client: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    leadId: string;
    phoneHash: string;
    ctwaClid: string;
    channelId?: string;
    connectionId?: string;
  },
): Promise<AuthorizedCtwaDestination | null> {
  const provider = ctwaDestinationProviderValue();
  if (!provider || !input.ctwaClid?.trim()) return null;
  const logs = await client.conversionEventLog.findMany({
    where: {
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      phoneHash: input.phoneHash,
      ctwaClid: input.ctwaClid,
      eventName: "LeadSubmitted",
      sourceTrigger: `inbound_webhook:${CTWA_DESTINATION_PROVIDER}`,
      // A log ad id is accepted only as the hint of an ad-hint entry, proven
      // below against the stored event decision.
    },
    select: { id: true, adId: true, sourcePayload: true },
    take: 501,
  });
  if (logs.length > 500) return null;
  const proofs = new Map<string, AuthorizedCtwaDestination>();
  for (const log of logs) {
    const p = log.sourcePayload;
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const parsed = authorizedCtwaDestinationSchema.safeParse(p.ctwaDestination);
    if (!parsed.success) continue;
    const intent = parsed.data;
    if (
      intent.workspaceId !== input.workspaceId ||
      p.channelId !== intent.channelId ||
      p.connectionId !== intent.connectionId ||
      typeof p.inboundEventId !== "string" ||
      (input.channelId && intent.channelId !== input.channelId) ||
      (input.connectionId && intent.connectionId !== input.connectionId)
    )
      continue;
    const event = await client.inboundWebhookEvent.findFirst({
      where: {
        id: p.inboundEventId,
        workspaceId: input.workspaceId,
        channelId: intent.channelId,
        connectionId: intent.connectionId,
        provider,
        hasCtwa: true,
        ...(log.adId
          ? {
              adId: log.adId,
              classificationReason: CTWA_DESTINATION_AD_HINT_REASON,
            }
          : { adId: null, classificationReason: CTWA_DESTINATION_REASON }),
        OR: [
          {
            productionItem: {
              is: {
                workspaceId: input.workspaceId,
                leadId: input.leadId,
                conversionEventLogId: log.id,
                status: { in: ["materialized", "duplicate"] },
              },
            },
          },
          {
            replayItem: {
              is: {
                workspaceId: input.workspaceId,
                leadId: input.leadId,
                conversionEventLogId: log.id,
                status: { in: ["materialized", "duplicate"] },
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    if (event && (await ctwaIntentAuthorized(client, intent)))
      proofs.set(intent.channelId, intent);
  }
  return proofs.size === 1 ? [...proofs.values()][0]! : null;
}
