import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  leadLifecycleLabel,
  leadSourceLabel,
  type LeadDetailDto,
  type LeadListItemDto,
  type LeadListPageDto,
  type LeadListQueryDto,
  type LeadStatusDto,
} from "@wpptrack/shared";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  hashPhoneIdentity,
  normalizePhoneIdentity,
} from "../common/phone/phone-identity";
import { dateRangeInTimezone } from "../external-data/external-event-policy";
import {
  chunked,
  firstContactScopeWhere,
  leadFirstContactBeforeWhere,
  leadFirstContactInRangeWhere,
  loadLeadIdsByPhoneHash,
  paidLeadSubmittedEventWhere,
  phoneHashesWithoutLeadId,
  repeatConversationLeadIds,
  withFirstContactAttribution,
  type LeadAttributionField,
  type LeadPeriodRange,
} from "./lead-cohort";
import {
  leadExportMaxRows,
  maskedLeadAd,
  maskedLeadAdSet,
  maskedLeadCampaign,
  maskedLeadName,
  maskedLeadPhone,
  type LeadExportRow,
} from "./leads-export";

const leadPeriodTimezone = "America/Sao_Paulo";
const leadExportBatchSize = 1000;

type LeadRecord = {
  id: string;
  workspaceId: string;
  name: string | null;
  phoneDisplay: string | null;
  phoneHash: string;
  status: LeadStatusDto;
  source: string | null;
  labels: string[];
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ctwaClid: string | null;
  ctwaSourceUrl: string | null;
  ctwaThumbnailUrl: string | null;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ConversionLogRecord = {
  id?: string;
  leadId: string | null;
  phoneHash?: string | null;
  sourceTrigger?: string;
  eventName: string;
  status?: string;
  pixelId?: string | null;
  campaignId?: string | null;
  adSetId?: string | null;
  adId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  eventOccurredAt: Date;
  sentAt?: Date | null;
  createdAt: Date;
};

type CampaignRecord = {
  campaignId: string;
  name: string;
};

type AdSetRecord = {
  adSetId: string;
  name: string;
};

type AdRecord = {
  adId: string;
  campaignId: string;
  adSetId: string;
  name: string;
};

type AdHierarchyRecord = {
  adId: string;
  campaignId: string;
  adSetId: string;
};

type WebhookLogRecord = {
  id: string;
  source: string;
  eventType: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  receivedAt: Date;
  processedAt: Date | null;
};

export type UpsertWhatsappLeadInput = {
  workspaceId: string;
  whatsappInstanceId?: string;
  name?: string;
  phone?: string;
  phoneHash?: string;
  source?: string;
  labels?: string[];
  campaignId?: string;
  adSetId?: string;
  adId?: string;
  ctwaClid?: string;
  ctwaSourceUrl?: string;
  ctwaThumbnailUrl?: string;
  occurredAt?: Date;
  firstMessageAt?: Date;
  lastMessageAt?: Date;
  recordMessageTimestamps?: boolean;
  preserveExistingSource?: boolean;
  preserveEarliestFirstMessageAt?: boolean;
  /** Fill `name` only while the lead has none; never overwrite an existing one. */
  preserveExistingName?: boolean;
};

@Injectable()
export class LeadsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listLeads(
    workspaceId: string,
    query: LeadListQueryDto,
  ): Promise<LeadListItemDto[]> {
    const page = await this.listLeadsPage(workspaceId, query);

    return page.items;
  }

  async listLeadsPage(
    workspaceId: string,
    query: LeadListQueryDto,
  ): Promise<LeadListPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? query.limit ?? 50;
    const buildWhere = await this.leadWhereBuilder(workspaceId, query);
    const where = buildWhere(query.attribution);

    if (!where) {
      return {
        items: [],
        pagination: { page, pageSize, totalItems: 0, totalPages: 0 },
      };
    }

    // Same filters without the origin one, split paid/organic, so the page can
    // show organic leads as their own count. Issued before the list count so
    // that one stays the last count of the request.
    const paidWhere = buildWhere("paid");
    const organicWhere = buildWhere("organic");
    const [paidCount, organicCount, pageLeads, totalItems] = (await Promise.all(
      [
        paidWhere ? this.prisma.lead.count({ where: paidWhere }) : 0,
        organicWhere ? this.prisma.lead.count({ where: organicWhere }) : 0,
        this.prisma.lead.findMany({
          where,
          orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.lead.count({ where }),
      ],
    )) as [unknown, unknown, LeadRecord[], number];
    // Campaign/ad shown = the one of the first contact, like the reports.
    const leads = await withFirstContactAttribution(
      this.prisma,
      workspaceId,
      pageLeads,
    );
    const attributionCounts =
      typeof paidCount === "number" && typeof organicCount === "number"
        ? { paid: paidCount, organic: organicCount }
        : null;
    const leadIds = leads.map((lead) => lead.id);
    const adIds = Array.from(
      new Set(leads.map((lead) => lead.adId).filter(Boolean)),
    ) as string[];
    const [conversionLogs, adHierarchy] = await Promise.all([
      leadIds.length
        ? (this.prisma.conversionEventLog.findMany({
            where: {
              workspaceId,
              leadId: { in: leadIds },
            },
            orderBy: [{ eventOccurredAt: "desc" }, { createdAt: "desc" }],
            select: {
              leadId: true,
              eventName: true,
              eventOccurredAt: true,
              createdAt: true,
            },
          }) as Promise<ConversionLogRecord[]>)
        : Promise.resolve([]),
      adIds.length
        ? (this.prisma.metaAd.findMany({
            where: {
              workspaceId,
              adId: { in: adIds },
            },
            select: {
              adId: true,
              campaignId: true,
              adSetId: true,
            },
          }) as Promise<AdHierarchyRecord[]>)
        : Promise.resolve([]),
    ]);
    const hierarchyByAdId = new Map(adHierarchy.map((ad) => [ad.adId, ad]));
    const resolvedLeads = leads.map((lead) => {
      const hierarchy = lead.adId ? hierarchyByAdId.get(lead.adId) : undefined;

      return hierarchy
        ? {
            ...lead,
            campaignId: hierarchy.campaignId,
            adSetId: hierarchy.adSetId,
          }
        : lead;
    });
    const campaignIds = Array.from(
      new Set(resolvedLeads.map((lead) => lead.campaignId).filter(Boolean)),
    ) as string[];
    const campaigns = campaignIds.length
      ? ((await this.prisma.metaCampaign.findMany({
          where: {
            workspaceId,
            campaignId: { in: campaignIds },
          },
          select: {
            campaignId: true,
            name: true,
          },
        })) as CampaignRecord[])
      : [];
    const eventsByLead = new Map<string, Set<string>>();
    const campaignNameById = new Map(
      campaigns.map((campaign) => [campaign.campaignId, campaign.name]),
    );

    for (const log of conversionLogs) {
      if (log.leadId) {
        const events = eventsByLead.get(log.leadId) ?? new Set<string>();
        events.add(log.eventName);
        eventsByLead.set(log.leadId, events);
      }
    }

    return {
      items: resolvedLeads.map((lead) =>
        this.toDto(
          lead,
          this.currentLifecycleEvent(lead, eventsByLead.get(lead.id)),
          lead.campaignId
            ? (campaignNameById.get(lead.campaignId) ?? null)
            : null,
        ),
      ),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: totalItems > 0 ? Math.ceil(totalItems / pageSize) : 0,
      },
      ...(attributionCounts ? { attributionCounts } : {}),
    };
  }

  /**
   * The one place that turns the Leads filters into a query, shared by the
   * list and the export so both always agree. `null` means nothing can match.
   */
  private async buildLeadWhere(
    workspaceId: string,
    query: Omit<LeadListQueryDto, "page" | "pageSize" | "limit">,
  ) {
    return (await this.leadWhereBuilder(workspaceId, query))(query.attribution);
  }

  /**
   * Resolves every lookup once and returns a builder that only varies the
   * origin (attribution) filter, so the list and its paid/organic split share
   * one set of queries.
   */
  private async leadWhereBuilder(
    workspaceId: string,
    query: Omit<LeadListQueryDto, "page" | "pageSize" | "limit">,
  ) {
    const conversationPeriodRange = this.conversationPeriodRange(query);
    const eventLeadIds = query.eventName
      ? await this.leadIdsForEvent(workspaceId, query.eventName)
      : null;
    const searchPhoneHash = this.phoneHashForSearch(query.search);
    const attributionWhere = (attribution: LeadListQueryDto["attribution"]) =>
      attribution === "paid"
        ? {
            OR: [
              { campaignId: { not: null } },
              { adSetId: { not: null } },
              { adId: { not: null } },
              { ctwaClid: { not: null } },
            ],
          }
        : attribution === "organic"
          ? {
              campaignId: null,
              adSetId: null,
              adId: null,
              ctwaClid: null,
            }
          : null;
    const searchFilter = query.search
      ? {
          OR: [
            {
              name: {
                contains: query.search,
                mode: "insensitive" as const,
              },
            },
            {
              phoneDisplay: {
                contains: query.search,
                mode: "insensitive" as const,
              },
            },
            ...(searchPhoneHash ? [{ phoneHash: searchPhoneHash }] : []),
          ],
        }
      : null;
    // Campaign/ad set/ad drill-downs follow the FIRST-contact attribution, the
    // same rule the reports use, so a report link opens a list of the same size.
    const scopeFilters = await Promise.all(
      (["campaignId", "adSetId", "adId"] as LeadAttributionField[]).flatMap(
        (field) => {
          const value = query[field];

          return value
            ? [firstContactScopeWhere(this.prisma, workspaceId, field, value)]
            : [];
        },
      ),
    );
    const returning = query.base === "returning";
    const repeat = query.base === "repeat";
    // "Voltaram no periodo" needs a period start: without it nobody is "before".
    // "Mais de uma conversa" counts conversations inside a period, new or not.
    const baseFilter = returning
      ? await this.returningLeadFilter(workspaceId, conversationPeriodRange)
      : repeat
        ? await this.repeatConversationLeadFilter(
            workspaceId,
            conversationPeriodRange,
          )
        : null;
    const periodFilter =
      conversationPeriodRange && !returning && !repeat
        ? leadFirstContactInRangeWhere(conversationPeriodRange)
        : null;

    if (
      (eventLeadIds && eventLeadIds.length === 0) ||
      ((returning || repeat) && !baseFilter)
    ) {
      return () => null;
    }

    return (attribution: LeadListQueryDto["attribution"]) => {
      const attributionFilter = attributionWhere(attribution);

      return {
        workspaceId,
        ...(eventLeadIds ? { id: { in: eventLeadIds } } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.label ? { labels: { has: query.label } } : {}),
        ...(attributionFilter ||
        searchFilter ||
        periodFilter ||
        baseFilter ||
        scopeFilters.length
          ? {
              AND: [
                ...scopeFilters,
                ...(attributionFilter ? [attributionFilter] : []),
                ...(searchFilter ? [searchFilter] : []),
                ...(periodFilter ? [periodFilter] : []),
                ...(baseFilter ?? []),
              ],
            }
          : {}),
      };
    };
  }

  /**
   * Leads que voltaram: a paid LeadSubmitted (new CTWA conversation) inside
   * the period, from someone whose first contact was before it. Events without
   * a lead id are matched by phone hash, like the reports do.
   */
  private async returningLeadFilter(
    workspaceId: string,
    range: LeadPeriodRange | null,
  ) {
    if (!range?.gte) {
      return null;
    }

    const events = (await this.prisma.conversionEventLog.findMany({
      where: {
        workspaceId,
        ...paidLeadSubmittedEventWhere,
        eventOccurredAt: range,
      },
      select: { leadId: true, phoneHash: true },
    })) as Array<{ leadId: string | null; phoneHash: string | null }>;
    const leadIds = Array.from(
      new Set(events.flatMap((event) => (event.leadId ? [event.leadId] : []))),
    );
    const phoneHashes = Array.from(
      new Set(
        events.flatMap((event) =>
          !event.leadId && event.phoneHash ? [event.phoneHash] : [],
        ),
      ),
    );

    // Resolved here in chunks, so the list/count queries only carry the people
    // who actually came back (never every lead with a conversation).
    const returningIds = new Set<string>();
    const idChunks = chunked(leadIds);
    const hashChunks = chunked(phoneHashes);

    for (
      let index = 0;
      index < Math.max(idChunks.length, hashChunks.length);
      index += 1
    ) {
      const ids = idChunks[index] ?? [];
      const hashes = hashChunks[index] ?? [];
      const rows = (await this.prisma.lead.findMany({
        where: {
          workspaceId,
          AND: [
            {
              OR: [
                ...(ids.length ? [{ id: { in: ids } }] : []),
                ...(hashes.length ? [{ phoneHash: { in: hashes } }] : []),
              ],
            },
            leadFirstContactBeforeWhere(range.gte),
          ],
        },
        select: { id: true },
      })) as Array<{ id: string }>;

      rows.forEach((row) => returningIds.add(row.id));
    }

    return returningIds.size ? [{ id: { in: [...returningIds] } }] : null;
  }

  /**
   * Conversaram mais de uma vez: two or more paid LeadSubmitted (new CTWA
   * conversations sent to Meta) inside the period, leads novos included.
   * Events without a lead id count for every lead of their phone, with the
   * same helper the reports use.
   */
  private async repeatConversationLeadFilter(
    workspaceId: string,
    range: LeadPeriodRange | null,
  ) {
    if (!range) {
      return null;
    }

    const events = (await this.prisma.conversionEventLog.findMany({
      where: {
        workspaceId,
        ...paidLeadSubmittedEventWhere,
        eventOccurredAt: range,
      },
      select: { leadId: true, phoneHash: true },
    })) as Array<{ leadId: string | null; phoneHash: string | null }>;
    // Same rule as the reports (shared helper): a conversation without a lead
    // id counts for every lead of its phone.
    const leadIdsByPhoneHash = await loadLeadIdsByPhoneHash(
      this.prisma,
      workspaceId,
      phoneHashesWithoutLeadId(events),
    );
    const repeatIds = repeatConversationLeadIds(events, leadIdsByPhoneHash);

    return repeatIds.length ? [{ id: { in: repeatIds } }] : null;
  }

  /**
   * Every lead that matches the Leads filters, in the order of the list, for
   * the spreadsheet export. Refuses (before anything is sent) when the filters
   * match more than the limit, so a file is never silently cut short.
   *
   * The matching ids are fixed up front, so leads that receive a message while
   * the file is being built can neither repeat nor go missing.
   */
  async prepareLeadExport(
    workspaceId: string,
    query: Omit<LeadListQueryDto, "page" | "pageSize" | "limit"> & {
      maskSensitive?: boolean;
    },
  ): Promise<{ totalItems: number; batches: AsyncGenerator<LeadExportRow[]> }> {
    const where = await this.buildLeadWhere(workspaceId, query);
    const totalItems = where ? await this.prisma.lead.count({ where }) : 0;

    if (!where || totalItems === 0) {
      return {
        totalItems: 0,
        batches: this.leadExportBatches(workspaceId, [], false),
      };
    }

    this.assertExportWithinLimit(totalItems);

    const snapshot = (await this.prisma.lead.findMany({
      where,
      orderBy: [
        { lastMessageAt: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: { id: true },
      take: leadExportMaxRows + 1,
    })) as Array<{ id: string }>;

    this.assertExportWithinLimit(snapshot.length);

    return {
      totalItems: snapshot.length,
      batches: this.leadExportBatches(
        workspaceId,
        snapshot.map((lead) => lead.id),
        query.maskSensitive === true,
      ),
    };
  }

  private assertExportWithinLimit(count: number): void {
    if (count > leadExportMaxRows) {
      throw new UnprocessableEntityException(
        `Esta busca tem ${count.toLocaleString("pt-BR")} leads e o limite da exportação é ${leadExportMaxRows.toLocaleString("pt-BR")}. Use um período menor ou mais filtros e exporte de novo.`,
      );
    }
  }

  private async *leadExportBatches(
    workspaceId: string,
    leadIds: string[],
    maskSensitive: boolean,
  ): AsyncGenerator<LeadExportRow[]> {
    for (let start = 0; start < leadIds.length; start += leadExportBatchSize) {
      const ids = leadIds.slice(start, start + leadExportBatchSize);
      const found = (await this.prisma.lead.findMany({
        where: { workspaceId, id: { in: ids } },
      })) as LeadRecord[];
      const byId = new Map(found.map((lead) => [lead.id, lead]));
      // Keep the snapshot order; a lead deleted meanwhile is simply skipped.
      const leads = ids.flatMap((id) => {
        const lead = byId.get(id);

        return lead ? [lead] : [];
      });

      if (leads.length > 0) {
        yield await this.toExportRows(workspaceId, leads, maskSensitive);
      }
    }
  }

  private async toExportRows(
    workspaceId: string,
    rowLeads: LeadRecord[],
    maskSensitive: boolean,
  ): Promise<LeadExportRow[]> {
    // Campaign/ad set/ad of the first contact, the same as the list and reports.
    const leads = await withFirstContactAttribution(
      this.prisma,
      workspaceId,
      rowLeads,
    );
    const leadIds = leads.map((lead) => lead.id);
    const adIds = Array.from(
      new Set(leads.map((lead) => lead.adId).filter(Boolean)),
    ) as string[];
    const [conversionLogs, ads] = await Promise.all([
      this.prisma.conversionEventLog.findMany({
        where: { workspaceId, leadId: { in: leadIds } },
        select: { leadId: true, eventName: true },
      }) as Promise<Array<{ leadId: string | null; eventName: string }>>,
      adIds.length
        ? (this.prisma.metaAd.findMany({
            where: { workspaceId, adId: { in: adIds } },
            select: { adId: true, campaignId: true, adSetId: true, name: true },
          }) as Promise<Array<AdHierarchyRecord & { name: string | null }>>)
        : Promise.resolve([]),
    ]);
    const adById = new Map(ads.map((ad) => [ad.adId, ad]));
    // Same rule as the list: the ad decides campaign and ad set when known.
    const resolved = leads.map((lead) => {
      const ad = lead.adId ? adById.get(lead.adId) : undefined;

      return {
        lead,
        campaignId: ad?.campaignId ?? lead.campaignId,
        adSetId: ad?.adSetId ?? lead.adSetId,
        adName: ad?.name ?? null,
      };
    });
    const campaignIds = Array.from(
      new Set(resolved.map((row) => row.campaignId).filter(Boolean)),
    ) as string[];
    const adSetIds = Array.from(
      new Set(resolved.map((row) => row.adSetId).filter(Boolean)),
    ) as string[];
    const [campaigns, adSets] = await Promise.all([
      campaignIds.length
        ? (this.prisma.metaCampaign.findMany({
            where: { workspaceId, campaignId: { in: campaignIds } },
            select: { campaignId: true, name: true },
          }) as Promise<CampaignRecord[]>)
        : Promise.resolve([]),
      adSetIds.length
        ? (this.prisma.metaAdSet.findMany({
            where: { workspaceId, adSetId: { in: adSetIds } },
            select: { adSetId: true, name: true },
          }) as Promise<AdSetRecord[]>)
        : Promise.resolve([]),
    ]);
    const campaignNameById = new Map(
      campaigns.map((campaign) => [campaign.campaignId, campaign.name]),
    );
    const adSetNameById = new Map(
      adSets.map((adSet) => [adSet.adSetId, adSet.name]),
    );
    const eventsByLead = new Map<string, Set<string>>();

    for (const log of conversionLogs) {
      if (log.leadId) {
        const events = eventsByLead.get(log.leadId) ?? new Set<string>();
        events.add(log.eventName);
        eventsByLead.set(log.leadId, events);
      }
    }

    return resolved.map(({ lead, campaignId, adSetId, adName }) => {
      const item = this.toDto(
        lead,
        this.currentLifecycleEvent(lead, eventsByLead.get(lead.id)),
        null,
      );
      const campaignName = campaignId
        ? (campaignNameById.get(campaignId) ?? null)
        : null;

      return {
        name: maskSensitive ? maskedLeadName : (lead.name ?? "Lead sem nome"),
        phone: maskSensitive ? maskedLeadPhone : (lead.phoneDisplay ?? ""),
        // Same first-contact rule as the cohort: legacy leads without a
        // message time entered when the row was created.
        enteredAt: lead.firstMessageAt ?? lead.createdAt,
        lastActivityAt: lead.lastMessageAt,
        campaign: maskSensitive
          ? maskedLeadCampaign
          : (campaignName ?? "Campanha nao resolvida"),
        adSet: maskSensitive
          ? maskedLeadAdSet
          : adSetId
            ? (adSetNameById.get(adSetId) ?? "")
            : "",
        ad: maskSensitive ? maskedLeadAd : (adName ?? ""),
        source: leadSourceLabel(lead.source, lead.adId),
        stage: leadLifecycleLabel(item),
        // The ids point straight at the hidden campaign, so they go too.
        campaignId: maskSensitive ? "" : (campaignId ?? ""),
        adSetId: maskSensitive ? "" : (adSetId ?? ""),
        adId: maskSensitive ? "" : (lead.adId ?? ""),
      };
    });
  }

  private async leadIdsForEvent(
    workspaceId: string,
    eventName: string,
  ): Promise<string[]> {
    const [events, inferredConversations] = await Promise.all([
      this.prisma.conversionEventLog.findMany({
        where: {
          workspaceId,
          eventName,
          leadId: { not: null },
        },
        select: { leadId: true },
        distinct: ["leadId"],
      }) as Promise<Array<{ leadId: string | null }>>,
      eventName === "LeadSubmitted"
        ? (this.prisma.lead.findMany({
            where: { workspaceId, firstMessageAt: { not: null } },
            select: { id: true },
          }) as Promise<Array<{ id: string }>>)
        : Promise.resolve([]),
    ]);

    return Array.from(
      new Set([
        ...events.flatMap((event) => (event.leadId ? [event.leadId] : [])),
        ...inferredConversations.map((lead) => lead.id),
      ]),
    );
  }

  async getLeadDetail(
    workspaceId: string,
    leadId: string,
  ): Promise<LeadDetailDto> {
    const lead = (await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        workspaceId,
      },
    })) as LeadRecord | null;

    if (!lead) {
      throw new NotFoundException("Lead nao encontrado");
    }

    const [conversionLogs, webhookLogs, campaigns, adSets, ads] =
      await Promise.all([
        this.prisma.conversionEventLog.findMany({
          where: {
            workspaceId,
            OR: [{ leadId: lead.id }, { phoneHash: lead.phoneHash }],
          },
          orderBy: [{ eventOccurredAt: "desc" }, { createdAt: "desc" }],
          select: {
            id: true,
            leadId: true,
            phoneHash: true,
            sourceTrigger: true,
            eventName: true,
            status: true,
            pixelId: true,
            campaignId: true,
            adSetId: true,
            adId: true,
            errorCode: true,
            errorMessage: true,
            eventOccurredAt: true,
            sentAt: true,
            createdAt: true,
          },
        }) as Promise<ConversionLogRecord[]>,
        this.prisma.webhookLog.findMany({
          where: {
            workspaceId,
            OR: [{ leadId: lead.id }, { phoneHash: lead.phoneHash }],
          },
          orderBy: { receivedAt: "desc" },
          select: {
            id: true,
            source: true,
            eventType: true,
            status: true,
            errorCode: true,
            errorMessage: true,
            receivedAt: true,
            processedAt: true,
          },
        }) as Promise<WebhookLogRecord[]>,
        lead.campaignId
          ? (this.prisma.metaCampaign.findMany({
              where: {
                workspaceId,
                campaignId: { in: [lead.campaignId] },
              },
              select: {
                campaignId: true,
                name: true,
              },
            }) as Promise<CampaignRecord[]>)
          : Promise.resolve([]),
        lead.adSetId
          ? (this.prisma.metaAdSet.findMany({
              where: {
                workspaceId,
                adSetId: { in: [lead.adSetId] },
              },
              select: {
                adSetId: true,
                name: true,
              },
            }) as Promise<AdSetRecord[]>)
          : Promise.resolve([]),
        lead.adId
          ? (this.prisma.metaAd.findMany({
              where: {
                workspaceId,
                adId: { in: [lead.adId] },
              },
              select: {
                adId: true,
                campaignId: true,
                adSetId: true,
                name: true,
              },
            }) as Promise<AdRecord[]>)
          : Promise.resolve([]),
      ]);
    const ad = ads[0];
    const resolvedLead = ad
      ? {
          ...lead,
          campaignId: ad.campaignId,
          adSetId: ad.adSetId,
        }
      : lead;
    const [resolvedCampaigns, resolvedAdSets] = await Promise.all([
      ad && ad.campaignId !== lead.campaignId
        ? (this.prisma.metaCampaign.findMany({
            where: { workspaceId, campaignId: { in: [ad.campaignId] } },
            select: { campaignId: true, name: true },
          }) as Promise<CampaignRecord[]>)
        : Promise.resolve(campaigns),
      ad && ad.adSetId !== lead.adSetId
        ? (this.prisma.metaAdSet.findMany({
            where: { workspaceId, adSetId: { in: [ad.adSetId] } },
            select: { adSetId: true, name: true },
          }) as Promise<AdSetRecord[]>)
        : Promise.resolve(adSets),
    ]);
    const campaignName = resolvedCampaigns[0]?.name ?? null;
    const currentEventName = this.currentLifecycleEvent(
      resolvedLead,
      new Set(conversionLogs.map((event) => event.eventName)),
    );

    return {
      lead: this.toDto(resolvedLead, currentEventName, campaignName),
      attribution: {
        campaignName,
        adSetName: resolvedAdSets[0]?.name ?? null,
        adName: ads[0]?.name ?? null,
        creative: {
          thumbnailUrl: this.publicHttpUrl(lead.ctwaThumbnailUrl),
          destinationUrl: this.publicHttpUrl(lead.ctwaSourceUrl),
        },
      },
      conversionEvents: conversionLogs.map((event) => ({
        id: event.id ?? "",
        eventName: event.eventName,
        status: event.status ?? "unknown",
        sourceTrigger: event.sourceTrigger ?? "unknown",
        pixelId: event.pixelId ?? null,
        campaignId: event.campaignId ?? null,
        adSetId: event.adSetId ?? null,
        adId: event.adId ?? null,
        errorCode: event.errorCode ?? null,
        errorMessage: event.errorMessage ?? null,
        occurredAt: event.eventOccurredAt.toISOString(),
        sentAt: event.sentAt?.toISOString() ?? null,
        createdAt: event.createdAt.toISOString(),
      })),
      webhookEvents: webhookLogs.map((event) => ({
        id: event.id,
        source: event.source,
        eventType: event.eventType,
        status: event.status,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        receivedAt: event.receivedAt.toISOString(),
        processedAt: event.processedAt?.toISOString() ?? null,
      })),
    };
  }

  async upsertFromWhatsappWebhook(
    input: UpsertWhatsappLeadInput,
    client: Pick<Prisma.TransactionClient, "lead"> = this.prisma,
  ): Promise<{ id: string } | null> {
    const normalizedPhone = input.phone
      ? normalizePhoneIdentity(input.phone)
      : undefined;
    const phoneHash = input.phoneHash ?? hashPhoneIdentity(input.phone);

    if (!phoneHash || (input.phone && !normalizedPhone)) {
      return null;
    }

    const occurredAt = input.occurredAt ?? new Date();
    const recordMessageTimestamps = input.recordMessageTimestamps !== false;
    const firstMessageAt = input.firstMessageAt ?? occurredAt;
    const lastMessageAt = input.lastMessageAt ?? occurredAt;
    const labels = this.normalizeLabels(input.labels);
    const lead = await client.lead.upsert({
      where: {
        workspaceId_phoneHash: {
          workspaceId: input.workspaceId,
          phoneHash,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        whatsappInstanceId: input.whatsappInstanceId ?? null,
        name: input.name ?? null,
        phoneDisplay: this.formatPhone(input.phone) ?? null,
        phoneHash,
        status: "active",
        source: input.source ?? "uazapi",
        labels: labels ?? [],
        campaignId: input.campaignId ?? null,
        adSetId: input.adSetId ?? null,
        adId: input.adId ?? null,
        ctwaClid: input.ctwaClid ?? null,
        ctwaSourceUrl: input.ctwaSourceUrl ?? null,
        ctwaThumbnailUrl: input.ctwaThumbnailUrl ?? null,
        firstMessageAt: recordMessageTimestamps ? firstMessageAt : null,
        lastMessageAt: recordMessageTimestamps ? lastMessageAt : null,
      },
      update: {
        whatsappInstanceId: input.whatsappInstanceId ?? undefined,
        name: input.preserveExistingName ? undefined : (input.name ?? undefined),
        phoneDisplay: this.formatPhone(input.phone) ?? undefined,
        source: input.preserveExistingSource
          ? undefined
          : (input.source ?? undefined),
        labels: labels ?? undefined,
        campaignId: input.campaignId ?? undefined,
        adSetId: input.adSetId ?? undefined,
        adId: input.adId ?? undefined,
        ctwaClid: input.ctwaClid ?? undefined,
        ctwaSourceUrl: input.ctwaSourceUrl ?? undefined,
        ctwaThumbnailUrl: input.ctwaThumbnailUrl ?? undefined,
        firstMessageAt:
          recordMessageTimestamps &&
          input.firstMessageAt &&
          !input.preserveEarliestFirstMessageAt
            ? firstMessageAt
            : undefined,
        lastMessageAt: recordMessageTimestamps ? lastMessageAt : undefined,
      },
      select: {
        id: true,
      },
    });

    if (input.preserveExistingName && input.name) {
      await client.lead.updateMany({
        where: {
          id: lead.id,
          workspaceId: input.workspaceId,
          OR: [{ name: null }, { name: "" }],
        },
        data: { name: input.name },
      });
    }

    if (
      recordMessageTimestamps &&
      input.preserveEarliestFirstMessageAt &&
      input.firstMessageAt
    ) {
      await client.lead.updateMany({
        where: {
          id: lead.id,
          workspaceId: input.workspaceId,
          OR: [
            { firstMessageAt: null },
            { firstMessageAt: { gt: firstMessageAt } },
          ],
        },
        data: {
          firstMessageAt,
        },
      });
    }

    return lead;
  }

  private toDto(
    lead: LeadRecord,
    lastEventName: string | null,
    campaignName: string | null,
  ): LeadListItemDto {
    const resolvedLastEventName =
      lastEventName ?? this.inferredLastEventName(lead);

    return {
      id: lead.id,
      workspaceId: lead.workspaceId,
      name: lead.name,
      phoneDisplay: lead.phoneDisplay,
      phoneHash: lead.phoneHash,
      status: this.statusFromEvent(lead.status, resolvedLastEventName),
      source: lead.source,
      labels: lead.labels,
      campaignId: lead.campaignId,
      campaignName,
      adSetId: lead.adSetId,
      adId: lead.adId,
      lastEventName: resolvedLastEventName,
      firstMessageAt: lead.firstMessageAt?.toISOString() ?? null,
      lastMessageAt: lead.lastMessageAt?.toISOString() ?? null,
      createdAt: lead.createdAt.toISOString(),
      updatedAt: lead.updatedAt.toISOString(),
    };
  }

  private publicHttpUrl(value: string | null): string | null {
    if (!value) {
      return null;
    }

    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.toString()
        : null;
    } catch {
      return null;
    }
  }

  private conversationPeriodRange(
    query: Pick<LeadListQueryDto, "since" | "until">,
  ): { gte?: Date; lte?: Date } | null {
    if (!query.since && !query.until) {
      return null;
    }

    return dateRangeInTimezone(query.since, query.until, leadPeriodTimezone);
  }

  private statusFromEvent(
    status: LeadStatusDto,
    eventName: string | null,
  ): LeadStatusDto {
    if (eventName === "Purchase") {
      return "converted";
    }

    if (eventName === "QualifiedLead") {
      return "qualified";
    }

    return status;
  }

  private inferredLastEventName(lead: LeadRecord): string | null {
    if (lead.status === "converted") {
      return "Purchase";
    }

    if (lead.status === "qualified") {
      return "QualifiedLead";
    }

    return lead.firstMessageAt ? "LeadSubmitted" : null;
  }

  private currentLifecycleEvent(
    lead: LeadRecord,
    eventNames?: ReadonlySet<string>,
  ): string | null {
    const stages = new Set(eventNames ?? []);

    if (lead.firstMessageAt) {
      stages.add("LeadSubmitted");
    }

    if (lead.status === "qualified") {
      stages.add("QualifiedLead");
    }

    if (lead.status === "converted") {
      stages.add("Purchase");
    }

    for (const eventName of ["Purchase", "QualifiedLead", "LeadSubmitted"]) {
      if (stages.has(eventName)) {
        return eventName;
      }
    }

    return eventNames?.values().next().value ?? null;
  }

  private phoneHashForSearch(search?: string): string | undefined {
    const normalized = normalizePhoneIdentity(search);

    return normalized ? hashPhoneIdentity(normalized) : undefined;
  }

  private formatPhone(phone?: string): string | undefined {
    const normalized = this.normalizePhone(phone);

    if (!normalized) {
      return undefined;
    }

    if (!normalized.startsWith("55") || normalized.length < 12) {
      return `+${normalized}`;
    }

    const area = normalized.slice(2, 4);
    const subscriber = normalized.slice(4);
    const prefix = subscriber.slice(0, -4);
    const suffix = subscriber.slice(-4);

    return `+55 ${area} ${prefix}-${suffix}`;
  }

  private normalizePhone(phone?: string): string | undefined {
    return normalizePhoneIdentity(phone);
  }

  private normalizeLabels(labels?: string[]): string[] | undefined {
    if (!labels) {
      return undefined;
    }

    const normalized = labels.map((label) => label.trim()).filter(Boolean);

    return Array.from(new Set(normalized));
  }
}
