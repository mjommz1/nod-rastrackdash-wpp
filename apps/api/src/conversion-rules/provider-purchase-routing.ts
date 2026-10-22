import type { Prisma } from "@prisma/client";

/** The paid lead's verified origin is a WhatsApp number outside the Payt rule
 * scope: the rule of that other number owns the purchase. Not an error. */
export const PAYT_LEAD_OTHER_CHANNEL_REASON = "payt_lead_other_channel";

const channelSelect = {
  id: true,
  organizationId: true,
  providerChannelId: true,
  status: true,
  productionActivatedAt: true,
  conversionEngineMode: true,
} satisfies Prisma.InboundWebhookChannelSelect;

/** A phone match alone is insufficient: require the actual materialized lead's origin. */
export async function resolvePurchaseChannels(
  client: Pick<
    Prisma.TransactionClient,
    "inboundWebhookEvent" | "conversionEventLog"
  >,
  input: {
    workspaceId: string;
    channelIds: string[];
    phoneHashes: string[];
    leadId: string;
    adId: string | null;
    ctwaClid: string;
    receivedAt: Date;
  },
) {
  const logs = await client.conversionEventLog.findMany({
    where: {
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      adId: input.adId,
      ctwaClid: input.ctwaClid,
      eventName: "LeadSubmitted",
      sourceTrigger: { startsWith: "inbound_webhook:" },
      phoneHash: { in: input.phoneHashes },
    },
    select: { id: true, sourcePayload: true },
    take: 501,
  });
  // Bound work without treating a truncated evidence set as unique.
  if (logs.length > 500) return [];
  const proofs = logs.flatMap((log) => {
    const payload = log.sourcePayload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return [];
    const { inboundEventId, channelId, connectionId } = payload;
    return typeof inboundEventId === "string" &&
      typeof channelId === "string" &&
      typeof connectionId === "string" &&
      input.channelIds.includes(channelId)
      ? [
          {
            id: inboundEventId,
            channelId,
            connectionId,
            OR: [
              {
                productionItem: {
                  is: {
                    workspaceId: input.workspaceId,
                    leadId: input.leadId,
                    conversionEventLogId: log.id,
                    status: {
                      in: ["materialized" as const, "duplicate" as const],
                    },
                  },
                },
              },
              {
                replayItem: {
                  is: {
                    workspaceId: input.workspaceId,
                    leadId: input.leadId,
                    conversionEventLogId: log.id,
                    status: {
                      in: ["materialized" as const, "duplicate" as const],
                    },
                  },
                },
              },
            ],
          },
        ]
      : [];
  });
  const events =
    proofs.length === 0
      ? []
      : await client.inboundWebhookEvent.findMany({
          where: {
            workspaceId: input.workspaceId,
            hasCtwa: true,
            adId: input.adId,
            channelId: { in: input.channelIds },
            contactIdentityHash: { in: input.phoneHashes },
            occurredAt: {
              lte: new Date(input.receivedAt.getTime() + 5 * 60 * 1_000),
            },
            channel: {
              is: {
                workspaceId: input.workspaceId,
                connection: { is: { removedAt: null } },
              },
            },
            OR: proofs,
          },
          distinct: ["channelId"],
          take: 2,
          select: { channel: { select: channelSelect } },
        });
  // A mutable WhatsApp-instance link cannot prove which channel produced this click.
  // UAZAPI has no immutable instance+click receipt today; fail closed instead of using that link.
  return [
    ...new Map(
      events.map((event) => [event.channel.id, event.channel]),
    ).values(),
  ];
}
