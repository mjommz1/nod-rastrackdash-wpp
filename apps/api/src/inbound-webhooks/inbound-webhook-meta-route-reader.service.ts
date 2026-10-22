import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { authorizedInboundMetaDestinationIds } from "./inbound-webhook-meta-route-eligibility";

export type InboundWebhookMetaRouteReason =
  | "route_resolved"
  | "ad_not_found"
  | "ad_account_not_attributed"
  | "reporting_account_not_found"
  | "reporting_account_inactive"
  | "business_connection_not_assigned"
  | "business_connection_not_found"
  | "business_connection_inactive"
  | "credential_inactive"
  | "conversion_destination_missing"
  | "conversion_destination_not_authorized"
  | "ad_destination_unresolved"
  | "ad_destination_mismatch"
  | "conversion_destination_not_configured";

export type InboundWebhookMetaRoutePreview = {
  status: "resolved" | "unresolved";
  reason: InboundWebhookMetaRouteReason;
  reportingAccountId: string | null;
  adAccountId: string | null;
  businessConnectionId: string | null;
  conversionDestinationId: string | null;
  pixelId: string | null;
  pageId: string | null;
};

@Injectable()
export class InboundWebhookMetaRouteReaderService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: Pick<
      Prisma.TransactionClient,
      | "metaAd"
      | "metaReportingAccount"
      | "metaBusinessConnection"
      | "metaConversionDestination"
    >,
  ) {}

  async previewRoute(input: {
    workspaceId: string;
    adId: string;
    reportingAccountId?: string | null;
    businessConnectionId?: string | null;
    conversionDestinationId?: string | null;
  }): Promise<InboundWebhookMetaRoutePreview> {
    const adId = input.adId.trim();
    const reportingAccountId = this.normalizeOptionalIdentifier(
      input.reportingAccountId,
    );
    const businessConnectionId = this.normalizeOptionalIdentifier(
      input.businessConnectionId,
    );
    const conversionDestinationId = this.normalizeOptionalIdentifier(
      input.conversionDestinationId,
    );
    const ad = adId
      ? await this.prisma.metaAd.findFirst({
          where: { workspaceId: input.workspaceId, adId },
          select: {
            adAccountId: true,
            destinationAssignment: {
              select: {
                reportingAccountId: true,
                conversionDestinationId: true,
              },
            },
          },
        })
      : null;

    if (!ad) {
      return this.unresolved("ad_not_found");
    }

    if (!ad.adAccountId) {
      return this.unresolved("ad_account_not_attributed");
    }

    const account = await this.prisma.metaReportingAccount.findFirst({
      where: {
        workspaceId: input.workspaceId,
        adAccountId: ad.adAccountId,
        ...(reportingAccountId !== null ? { id: reportingAccountId } : {}),
      },
      select: {
        id: true,
        adAccountId: true,
        businessConnectionId: true,
        conversionDestinationId: true,
        active: true,
        allowedDestinations: {
          where: { workspaceId: input.workspaceId, active: true },
          select: {
            conversionDestinationId: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!account) {
      return this.unresolved("reporting_account_not_found", {
        adAccountId: ad.adAccountId,
      });
    }

    const accountMetadata = {
      reportingAccountId: account.id,
      adAccountId: account.adAccountId,
    };

    if (!account.active) {
      return this.unresolved("reporting_account_inactive", accountMetadata);
    }

    if (!account.businessConnectionId) {
      return this.unresolved(
        "business_connection_not_assigned",
        accountMetadata,
      );
    }

    if (
      businessConnectionId !== null &&
      businessConnectionId !== account.businessConnectionId
    ) {
      return this.unresolved("business_connection_not_found", accountMetadata);
    }

    const connection = await this.prisma.metaBusinessConnection.findFirst({
      where: {
        id: account.businessConnectionId,
        workspaceId: input.workspaceId,
        credential: { is: { workspaceId: input.workspaceId } },
      },
      select: {
        id: true,
        status: true,
        credential: { select: { status: true } },
      },
    });

    if (!connection) {
      return this.unresolved("business_connection_not_found", accountMetadata);
    }

    const connectionMetadata = {
      ...accountMetadata,
      businessConnectionId: connection.id,
    };

    if (connection.status !== "active") {
      return this.unresolved(
        "business_connection_inactive",
        connectionMetadata,
      );
    }

    if (connection.credential.status !== "active") {
      return this.unresolved("credential_inactive", connectionMetadata);
    }

    const authorizedDestinationIds =
      authorizedInboundMetaDestinationIds(account);
    const assignment =
      ad.destinationAssignment?.reportingAccountId === account.id
        ? ad.destinationAssignment
        : null;

    if (
      conversionDestinationId &&
      !authorizedDestinationIds.includes(conversionDestinationId)
    ) {
      return this.unresolved(
        "conversion_destination_not_authorized",
        connectionMetadata,
      );
    }

    if (
      conversionDestinationId &&
      assignment &&
      assignment.conversionDestinationId !== conversionDestinationId
    ) {
      return this.unresolved("ad_destination_mismatch", connectionMetadata);
    }

    if (
      conversionDestinationId &&
      !assignment &&
      authorizedDestinationIds.length > 1
    ) {
      return this.unresolved("ad_destination_unresolved", connectionMetadata);
    }

    if (
      assignment &&
      !authorizedDestinationIds.includes(assignment.conversionDestinationId)
    ) {
      return this.unresolved(
        "conversion_destination_not_authorized",
        connectionMetadata,
      );
    }

    const destinationId =
      conversionDestinationId ??
      assignment?.conversionDestinationId ??
      (authorizedDestinationIds.length === 1
        ? authorizedDestinationIds[0]
        : null);

    if (!destinationId) {
      return this.unresolved(
        authorizedDestinationIds.length > 1
          ? "ad_destination_unresolved"
          : "conversion_destination_missing",
        connectionMetadata,
      );
    }

    const destination = await this.prisma.metaConversionDestination.findFirst({
      where: {
        id: destinationId,
        workspaceId: input.workspaceId,
        status: "configured",
      },
      select: {
        id: true,
        pixelId: true,
        pageId: true,
      },
    });

    if (!destination) {
      return this.unresolved(
        "conversion_destination_not_configured",
        connectionMetadata,
      );
    }

    return {
      status: "resolved",
      reason: "route_resolved",
      ...connectionMetadata,
      conversionDestinationId: destination.id,
      pixelId: destination.pixelId,
      pageId: destination.pageId,
    };
  }

  private normalizeOptionalIdentifier(
    value: string | null | undefined,
  ): string | null {
    return value === null || value === undefined ? null : value.trim();
  }

  private unresolved(
    reason: Exclude<InboundWebhookMetaRouteReason, "route_resolved">,
    metadata: Partial<
      Omit<InboundWebhookMetaRoutePreview, "status" | "reason">
    > = {},
  ): InboundWebhookMetaRoutePreview {
    return {
      status: "unresolved",
      reason,
      reportingAccountId: null,
      adAccountId: null,
      businessConnectionId: null,
      conversionDestinationId: null,
      pixelId: null,
      pageId: null,
      ...metadata,
    };
  }
}
