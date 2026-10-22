import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";

type DestinationCandidate = {
  id: string;
  pixelId: string;
  pageId: string;
};

export type MetaAdDestinationReconciliation = {
  examinedCount: number;
  assignedCount: number;
  unresolvedCount: number;
  manualCount: number;
};

@Injectable()
export class MetaAdDestinationRoutingService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  destinationCandidates<T extends DestinationCandidate>(
    destinations: T[],
    pixelIds: string[],
    pageIds: string[],
  ): T[] {
    const normalizedPageIds = new Set(pageIds.filter(Boolean));

    if (normalizedPageIds.size > 0) {
      return destinations.filter((destination) =>
        normalizedPageIds.has(destination.pageId),
      );
    }

    const normalizedPixelIds = new Set(pixelIds.filter(Boolean));

    if (normalizedPixelIds.size === 0) {
      return [];
    }

    return destinations.filter((destination) =>
      normalizedPixelIds.has(destination.pixelId),
    );
  }

  async reconcileReportingAccount(input: {
    workspaceId: string;
    reportingAccountId: string;
    adIds?: string[];
  }): Promise<MetaAdDestinationReconciliation> {
    const account = await this.prisma.metaReportingAccount.findFirst({
      where: {
        id: input.reportingAccountId,
        workspaceId: input.workspaceId,
      },
      select: {
        adAccountId: true,
        conversionDestinationId: true,
        businessConnection: {
          select: { defaultConversionDestinationId: true },
        },
        allowedDestinations: {
          where: { active: true },
          select: {
            destination: {
              select: {
                id: true,
                pixelId: true,
                pageId: true,
                status: true,
              },
            },
          },
        },
      },
    });

    if (!account) {
      return this.emptyResult();
    }

    let destinations = account.allowedDestinations
      .map((record) => record.destination)
      .filter((destination) => destination.status === "configured");

    if (destinations.length === 0) {
      const legacyDestinationId =
        account.conversionDestinationId ??
        account.businessConnection?.defaultConversionDestinationId ??
        null;

      destinations = legacyDestinationId
        ? await this.prisma.metaConversionDestination.findMany({
            where: {
              id: legacyDestinationId,
              workspaceId: input.workspaceId,
              status: "configured",
            },
            select: {
              id: true,
              pixelId: true,
              pageId: true,
              status: true,
            },
          })
        : [];
    }

    const requestedAdIds = input.adIds
      ? [...new Set(input.adIds.map((adId) => adId.trim()).filter(Boolean))]
      : null;
    const ads = await this.prisma.metaAd.findMany({
      where: {
        workspaceId: input.workspaceId,
        adAccountId: account.adAccountId,
        ...(requestedAdIds ? { adId: { in: requestedAdIds } } : {}),
      },
      select: {
        adId: true,
        detectedPixelIds: true,
        detectedPageIds: true,
      },
    });

    if (ads.length === 0) {
      return this.emptyResult();
    }

    const adIds = ads.map((ad) => ad.adId);
    const manualAssignments =
      await this.prisma.metaAdDestinationAssignment.findMany({
        where: {
          workspaceId: input.workspaceId,
          reportingAccountId: input.reportingAccountId,
          adId: { in: adIds },
          source: "manual",
        },
        select: { adId: true },
      });
    const manuallyAssignedAdIds = new Set(
      manualAssignments.map((assignment) => assignment.adId),
    );

    const automaticAssignments = ads.flatMap((ad) => {
      if (manuallyAssignedAdIds.has(ad.adId)) {
        return [];
      }

      // A sole configured destination is already an unambiguous account-level
      // decision. Page/pixel matching remains required whenever the account
      // has multiple destinations.
      const candidates =
        destinations.length === 1
          ? destinations
          : this.destinationCandidates(
              destinations,
              ad.detectedPixelIds,
              ad.detectedPageIds,
            );

      if (candidates.length !== 1) {
        return [];
      }

      const destination = candidates[0];

      return [
        {
          workspaceId: input.workspaceId,
          adId: ad.adId,
          reportingAccountId: input.reportingAccountId,
          conversionDestinationId: destination.id,
          source: "automatic" as const,
          detectedPixelId: destination.pixelId,
          detectedPageId: destination.pageId,
        },
      ];
    });

    await this.prisma.$transaction(async (transaction) => {
      await transaction.metaAdDestinationAssignment.deleteMany({
        where: {
          workspaceId: input.workspaceId,
          reportingAccountId: input.reportingAccountId,
          adId: { in: adIds },
          source: "automatic",
        },
      });

      if (automaticAssignments.length > 0) {
        await transaction.metaAdDestinationAssignment.createMany({
          data: automaticAssignments,
          skipDuplicates: true,
        });
      }
    });

    return {
      examinedCount: ads.length,
      assignedCount: automaticAssignments.length,
      unresolvedCount:
        ads.length - automaticAssignments.length - manuallyAssignedAdIds.size,
      manualCount: manuallyAssignedAdIds.size,
    };
  }

  private emptyResult(): MetaAdDestinationReconciliation {
    return {
      examinedCount: 0,
      assignedCount: 0,
      unresolvedCount: 0,
      manualCount: 0,
    };
  }
}
