/**
 * One definition of "lead novo" and "lead que voltou", shared by the Leads
 * page/export and the reports so their numbers always agree.
 *
 * - Lead novo: the person's first contact (Lead.firstMessageAt, or createdAt
 *   when no message time is known) falls inside the period. A person is a lead
 *   novo once ever, on that day; later conversations never make them new again.
 * - Lead que voltou: first contact before the period start and at least one
 *   paid LeadSubmitted (a new CTWA conversation sent to Meta) inside it.
 *
 * Periods are calendar days in the reporting timezone (America/Sao_Paulo).
 */

export type LeadPeriodRange = { gte?: Date; lte?: Date };

/** Lead rows whose first contact falls inside `range`. */
export function leadFirstContactInRangeWhere(range: LeadPeriodRange) {
  return {
    OR: [{ firstMessageAt: range }, { firstMessageAt: null, createdAt: range }],
  };
}

/** Lead rows whose first contact happened before `start`. */
export function leadFirstContactBeforeWhere(start: Date) {
  return {
    OR: [
      { firstMessageAt: { lt: start } },
      { firstMessageAt: null, createdAt: { lt: start } },
    ],
  };
}

/**
 * A new paid conversation: the LeadSubmitted event sent to Meta for each CTWA
 * conversation. Skipped events never count; organic ones are not "por anuncio".
 */
export const paidLeadSubmittedEventWhere = {
  eventName: "LeadSubmitted",
  status: { not: "skipped" },
  businessSource: { not: "organic" },
} as const;

/** Splits large `in` lists so a query never exceeds the bind-parameter limit. */
export function chunked<T>(values: T[], size = 5000): T[][] {
  const chunks: T[][] = [];

  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }

  return chunks;
}

export type LeadAttribution = {
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
};

export type LeadAttributionField = keyof LeadAttribution;

const attributionFields: LeadAttributionField[] = [
  "campaignId",
  "adSetId",
  "adId",
];

type AttributionEvent = LeadAttribution & {
  leadId: string | null;
  eventName?: string | null;
  status?: string | null;
  businessSource?: string | null;
  eventOccurredAt: Date | string;
};

type FindManyClient = {
  conversionEventLog: { findMany(args: unknown): Promise<unknown> };
  lead: { findMany(args: unknown): Promise<unknown> };
};

function hasAnyAttribution(item: LeadAttribution): boolean {
  return Boolean(item.campaignId || item.adSetId || item.adId);
}

function isPaidLeadSubmitted(
  event: Pick<AttributionEvent, "eventName" | "status" | "businessSource">,
): boolean {
  return (
    event.eventName === "LeadSubmitted" &&
    event.status !== "skipped" &&
    event.businessSource?.trim().toLowerCase() !== "organic"
  );
}

/**
 * The ad that brought the person in: the earliest paid LeadSubmitted that
 * names an ad. Fields that event lacks are filled from later events (then
 * the Lead row) only when they agree with what it does name, so a partial
 * first event (e.g. campaign only) never drops the lead from ad set/ad
 * reports nor mixes two hierarchies. Without such an event the Lead row
 * attribution stands. Lead rows keep the LATEST ad (upserts overwrite it),
 * which is why the row alone cannot answer this.
 */
export function firstContactAttribution(
  lead: LeadAttribution,
  events: AttributionEvent[],
): LeadAttribution {
  const withAd = events
    .filter((event) => isPaidLeadSubmitted(event) && hasAnyAttribution(event))
    .sort(
      (left, right) =>
        new Date(left.eventOccurredAt).getTime() -
        new Date(right.eventOccurredAt).getTime(),
    );
  const first = withAd[0];

  if (!first) {
    return {
      campaignId: lead.campaignId,
      adSetId: lead.adSetId,
      adId: lead.adId,
    };
  }

  const result: LeadAttribution = {
    campaignId: first.campaignId ?? null,
    adSetId: first.adSetId ?? null,
    adId: first.adId ?? null,
  };
  const compatible = (candidate: LeadAttribution) =>
    attributionFields.every(
      (field) =>
        !result[field] ||
        !candidate[field] ||
        candidate[field] === result[field],
    );

  for (const candidate of [...withAd.slice(1), lead]) {
    if (attributionFields.every((field) => result[field])) {
      break;
    }

    if (!compatible(candidate)) {
      continue;
    }

    for (const field of attributionFields) {
      result[field] = result[field] ?? candidate[field] ?? null;
    }
  }

  return result;
}

/** First-contact attribution of each lead, loaded in chunks. */
export async function loadFirstContactAttributions(
  client: FindManyClient,
  workspaceId: string,
  leads: Array<LeadAttribution & { id: string }>,
): Promise<Map<string, LeadAttribution>> {
  const eventsByLead = new Map<string, AttributionEvent[]>();

  for (const ids of chunked(leads.map((lead) => lead.id))) {
    const wanted = new Set(ids);
    const events = (await client.conversionEventLog.findMany({
      where: {
        workspaceId,
        ...paidLeadSubmittedEventWhere,
        leadId: { in: ids },
      },
      select: {
        leadId: true,
        eventName: true,
        status: true,
        businessSource: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        eventOccurredAt: true,
      },
    })) as AttributionEvent[];

    for (const event of events) {
      if (!event.leadId || !wanted.has(event.leadId)) {
        continue;
      }

      const list = eventsByLead.get(event.leadId) ?? [];
      list.push(event);
      eventsByLead.set(event.leadId, list);
    }
  }

  return new Map(
    leads.map((lead) => [
      lead.id,
      firstContactAttribution(lead, eventsByLead.get(lead.id) ?? []),
    ]),
  );
}

/** Replaces each lead's campaign/ad set/ad with its first-contact ones. */
export async function withFirstContactAttribution<
  T extends LeadAttribution & { id: string },
>(client: FindManyClient, workspaceId: string, leads: T[]): Promise<T[]> {
  if (leads.length === 0) {
    return leads;
  }

  const attributions = await loadFirstContactAttributions(
    client,
    workspaceId,
    leads,
  );

  return leads.map((lead) => ({ ...lead, ...attributions.get(lead.id) }));
}

/**
 * Leads filter "campaign/ad set/ad = value" by FIRST-contact attribution, the
 * same rule the reports use. Returned as the row filter plus two short
 * corrections (leads whose ad changed since), so the list/count query never
 * carries the whole campaign as an id list.
 */
export async function firstContactScopeWhere(
  client: FindManyClient,
  workspaceId: string,
  field: LeadAttributionField,
  value: string,
) {
  const select = { id: true, campaignId: true, adSetId: true, adId: true };
  const rowLeads = (await client.lead.findMany({
    where: { workspaceId, [field]: value },
    select,
  })) as Array<LeadAttribution & { id: string }>;
  const events = (await client.conversionEventLog.findMany({
    where: {
      workspaceId,
      ...paidLeadSubmittedEventWhere,
      leadId: { not: null },
      [field]: value,
    },
    select: {
      leadId: true,
      eventName: true,
      status: true,
      businessSource: true,
    },
  })) as Array<
    Pick<AttributionEvent, "leadId" | "eventName" | "status" | "businessSource">
  >;
  const rowIds = new Set(rowLeads.map((lead) => lead.id));
  const otherIds = [
    ...new Set(
      events.flatMap((event) =>
        event.leadId && !rowIds.has(event.leadId) && isPaidLeadSubmitted(event)
          ? [event.leadId]
          : [],
      ),
    ),
  ];
  const otherLeads: Array<LeadAttribution & { id: string }> = [];

  for (const ids of chunked(otherIds)) {
    otherLeads.push(
      ...((await client.lead.findMany({
        where: { workspaceId, id: { in: ids } },
        select,
      })) as Array<LeadAttribution & { id: string }>),
    );
  }

  const attributions = await loadFirstContactAttributions(client, workspaceId, [
    ...rowLeads,
    ...otherLeads,
  ]);
  const movedAway = rowLeads
    .filter((lead) => attributions.get(lead.id)?.[field] !== value)
    .map((lead) => lead.id);
  const movedIn = otherLeads
    .filter((lead) => attributions.get(lead.id)?.[field] === value)
    .map((lead) => lead.id);

  return {
    OR: [
      {
        [field]: value,
        ...(movedAway.length ? { id: { notIn: movedAway } } : {}),
      },
      ...(movedIn.length ? [{ id: { in: movedIn } }] : []),
    ],
  };
}

/** A paid conversation reference: the lead it belongs to, or its phone. */
export type ConversationRef = {
  leadId?: string | null;
  phoneHash?: string | null;
};

/**
 * Conversaram mais de uma vez: one rule for the reports and the Leads page.
 * Each conversation counts for its lead; one without a lead id counts for
 * EVERY lead of its phone (like the returning filter, which takes all leads
 * of a phone). A conversation with no lead behind it is not a person.
 * Returns the ids of the leads with two or more conversations.
 */
export function repeatConversationLeadIds(
  conversations: ConversationRef[],
  leadIdsByPhoneHash: ReadonlyMap<string, readonly string[]>,
): string[] {
  const counts = new Map<string, number>();

  for (const conversation of conversations) {
    const leadIds = conversation.leadId
      ? [conversation.leadId]
      : conversation.phoneHash
        ? (leadIdsByPhoneHash.get(conversation.phoneHash) ?? [])
        : [];

    for (const leadId of new Set(leadIds)) {
      counts.set(leadId, (counts.get(leadId) ?? 0) + 1);
    }
  }

  return [...counts]
    .filter(([, count]) => count >= 2)
    .map(([leadId]) => leadId);
}

/**
 * Every lead of each phone hash (the workspace may hold more than one lead per
 * phone), loaded in chunks. Feeds `repeatConversationLeadIds`.
 */
export async function loadLeadIdsByPhoneHash(
  client: FindManyClient,
  workspaceId: string,
  phoneHashes: string[],
): Promise<Map<string, string[]>> {
  const leadIdsByPhoneHash = new Map<string, string[]>();

  for (const hashes of chunked([...new Set(phoneHashes)])) {
    const rows = (await client.lead.findMany({
      where: { workspaceId, phoneHash: { in: hashes } },
      select: { id: true, phoneHash: true },
    })) as Array<{ id: string; phoneHash: string | null }>;

    for (const row of rows) {
      if (!row.phoneHash) {
        continue;
      }

      const ids = leadIdsByPhoneHash.get(row.phoneHash) ?? [];

      if (!ids.includes(row.id)) {
        ids.push(row.id);
      }

      leadIdsByPhoneHash.set(row.phoneHash, ids);
    }
  }

  return leadIdsByPhoneHash;
}

/** Phone hashes of conversations that carry no lead id (to resolve them). */
export function phoneHashesWithoutLeadId(
  conversations: ConversationRef[],
): string[] {
  return [
    ...new Set(
      conversations.flatMap((conversation) =>
        !conversation.leadId && conversation.phoneHash
          ? [conversation.phoneHash]
          : [],
      ),
    ),
  ];
}
