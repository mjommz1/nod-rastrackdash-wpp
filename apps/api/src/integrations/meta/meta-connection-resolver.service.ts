import {
  ctwaIntentAuthorized,
  type CtwaIntentAuthorizationOptions,
  type AuthorizedCtwaDestination,
} from "../../inbound-webhooks/authorized-ctwa-destination";
import type { Prisma } from "@prisma/client";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { MetaTokenEncryptionService } from "./meta-token-encryption.service";

type EncryptedCredential = {
  encryptedAccessToken: string;
  tokenIv: string;
  tokenTag: string;
};

type LegacyIntegration = EncryptedCredential & {
  status: string;
  capiAccessTokenEncrypted: string | null;
  capiTokenIv: string | null;
  capiTokenTag: string | null;
  selectedBusinessId: string | null;
  selectedAdAccountId: string | null;
  selectedPixelId: string | null;
  primaryConversionDestinationId: string | null;
  advancedRoutingEnabled: boolean;
};

export type ResolvedMetaReportingRoute = {
  source: "legacy_oauth" | "manual";
  workspaceId: string;
  accessToken: string;
  reportingAccountId: string;
  adAccountId: string;
  businessConnectionId: string | null;
  credentialId: string | null;
};

export type MetaReportingSyncTarget = {
  workspaceId: string;
  businessConnectionId: string | null;
  reportingAccountId: string | null;
};

export type ResolvedMetaCapiRoute = {
  source: "legacy_oauth" | "manual";
  workspaceId: string;
  accessToken: string | null;
  reportingAccountId: string | null;
  adAccountId: string | null;
  businessConnectionId: string | null;
  credentialId: string | null;
  conversionDestinationId: string | null;
  pixelId: string | null;
  pageId: string | null;
};

export type LegacyMetaCompatibilityProjection = {
  source: "legacy_oauth";
  workspaceId: string;
  businessId: string | null;
  adAccountId: string | null;
  pixelId: string | null;
  destinationPixelId: string | null;
  destinationPageId: string | null;
  credentialFingerprint: string;
};

@Injectable()
export class MetaConnectionResolverService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly encryption: MetaTokenEncryptionService,
  ) {}

  /**
   * Token of the business connection that authorizes a CTWA page/pixel
   * destination (lead with ctwa_clid and no known ad). Same credential the
   * Meta login already stored; no WhatsApp Business permission is involved.
   */
  async resolveAuthorizedCtwaDestination(
    intent: AuthorizedCtwaDestination,
    client: Prisma.TransactionClient = this.prisma,
    options: CtwaIntentAuthorizationOptions = {},
  ): Promise<{
    intent: AuthorizedCtwaDestination;
    accessToken: string;
    validUntil: number;
  }> {
    if (!(await ctwaIntentAuthorized(client, intent, options)))
      throw new ConflictException("CTWA destination unavailable");
    const credential = await client.metaCredential.findFirst({
      where: {
        id: intent.credentialId,
        workspaceId: intent.workspaceId,
        status: "active",
      },
    });
    if (
      !credential ||
      credential.workspaceId !== intent.workspaceId ||
      credential.status !== "active" ||
      !credential.lastValidatedAt ||
      credential.fingerprint !== intent.credentialFingerprint ||
      !(await ctwaIntentAuthorized(client, intent, options))
    )
      throw new ConflictException("CTWA credential revoked");
    const validUntil = credential.expiresAt?.getTime() ?? Infinity;
    if (validUntil <= Date.now())
      throw new ConflictException("CTWA authorization expired");
    const accessToken = this.decrypt(credential);
    if (!accessToken.trim())
      throw new ConflictException("CTWA access token unavailable");
    return { intent, accessToken, validUntil };
  }

  async listReportingSyncTargets(
    workspaceId: string,
  ): Promise<MetaReportingSyncTarget[]> {
    if (await this.isNormalizedRoutingEnabled(workspaceId)) {
      const accounts = await this.prisma.metaReportingAccount.findMany({
        where: {
          workspaceId,
          active: true,
          businessConnectionId: { not: null },
          businessConnection: {
            is: {
              status: "active",
              credential: { is: { status: "active" } },
            },
          },
        },
        select: {
          id: true,
          businessConnectionId: true,
        },
        orderBy: { id: "asc" },
      });

      return accounts.flatMap((account) =>
        account.businessConnectionId
          ? [
              {
                workspaceId,
                businessConnectionId: account.businessConnectionId,
                reportingAccountId: account.id,
              },
            ]
          : [],
      );
    }

    const legacy = await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
      select: { status: true },
    });
    const activeAccounts = await this.prisma.metaReportingAccount.count({
      where: { workspaceId, active: true },
    });

    return legacy?.status === "connected" && activeAccounts > 0
      ? [
          {
            workspaceId,
            businessConnectionId: null,
            reportingAccountId: null,
          },
        ]
      : [];
  }

  async resolveReportingRoute(input: {
    workspaceId: string;
    reportingAccountId?: string | null;
    adAccountId?: string | null;
    businessConnectionId?: string | null;
  }): Promise<ResolvedMetaReportingRoute> {
    const account = await this.prisma.metaReportingAccount.findFirst({
      where: {
        workspaceId: input.workspaceId,
        active: true,
        ...(input.reportingAccountId ? { id: input.reportingAccountId } : {}),
        ...(input.adAccountId ? { adAccountId: input.adAccountId } : {}),
      },
      select: {
        id: true,
        adAccountId: true,
        businessConnectionId: true,
      },
    });

    if (!account) {
      throw new NotFoundException("Conta Meta ativa nao encontrada");
    }

    if (
      input.businessConnectionId &&
      account.businessConnectionId !== input.businessConnectionId
    ) {
      throw new NotFoundException("Conta Meta ativa nao encontrada");
    }

    if (
      account.businessConnectionId &&
      (await this.isNormalizedRoutingEnabled(input.workspaceId))
    ) {
      if (
        !input.reportingAccountId ||
        !input.businessConnectionId ||
        account.businessConnectionId !== input.businessConnectionId
      ) {
        throw new ConflictException(
          "A sincronizacao configurada exige a conta e a conexao Meta exatas",
        );
      }

      const connection = await this.prisma.metaBusinessConnection.findFirst({
        where: {
          id: account.businessConnectionId,
          workspaceId: input.workspaceId,
        },
        include: { credential: true },
      });

      if (!connection) {
        throw new NotFoundException("Conexao Meta nao encontrada");
      }

      this.assertNormalizedConnectionActive(connection);

      return {
        source:
          connection.credential.source === "oauth" ? "legacy_oauth" : "manual",
        workspaceId: input.workspaceId,
        accessToken: this.decrypt(connection.credential),
        reportingAccountId: account.id,
        adAccountId: account.adAccountId,
        businessConnectionId: connection.id,
        credentialId: connection.credentialId,
      };
    }

    const legacy = await this.getLegacyIntegration(input.workspaceId);

    return {
      source: "legacy_oauth",
      workspaceId: input.workspaceId,
      accessToken: this.decrypt(legacy),
      reportingAccountId: account.id,
      adAccountId: account.adAccountId,
      businessConnectionId: null,
      credentialId: null,
    };
  }

  async resolveCapiRoute(input: {
    workspaceId: string;
    adId?: string | null;
    campaignId?: string | null;
    metaAccountId?: string | null;
    businessConnectionId?: string | null;
    conversionDestinationId?: string | null;
    requireNormalized?: boolean;
  }): Promise<ResolvedMetaCapiRoute> {
    const adAccountId =
      input.metaAccountId?.trim() ||
      (await this.resolveAttributedAdAccountId(input.workspaceId, input));
    const legacy = await this.prisma.metaIntegration.findUnique({
      where: { workspaceId: input.workspaceId },
    });
    const explicitRoute = Boolean(
      input.requireNormalized ||
      input.businessConnectionId ||
      input.conversionDestinationId,
    );
    const normalizedRequired =
      explicitRoute || Boolean(legacy?.advancedRoutingEnabled) || !legacy;
    // Look up the event's account, including inactive rows. A revoked or paused
    // matching route must block rather than escaping through legacy credentials.
    const account = adAccountId
      ? await this.prisma.metaReportingAccount.findFirst({
          where: { workspaceId: input.workspaceId, adAccountId },
        })
      : normalizedRequired
        ? await this.onlyNormalizedReportingAccount(
            input.workspaceId,
            input.businessConnectionId,
          )
        : null;

    if (account && !account.active)
      throw new ConflictException("Conta Meta inativa");

    if (!normalizedRequired && !account?.businessConnectionId) {
      return this.resolveLegacyCapiRoute(input.workspaceId);
    }

    if (account?.businessConnectionId) {
      if (
        input.businessConnectionId &&
        account.businessConnectionId !== input.businessConnectionId
      ) {
        throw new NotFoundException("Rota Meta nao encontrada");
      }

      const connection = await this.prisma.metaBusinessConnection.findFirst({
        where: {
          id: account.businessConnectionId,
          workspaceId: input.workspaceId,
        },
        include: { credential: true },
      });

      if (!connection) {
        throw new NotFoundException("Rota Meta nao encontrada");
      }

      this.assertNormalizedConnectionActive(connection);
      const adDestinationAssignment = input.adId?.trim()
        ? await this.prisma.metaAd.findFirst({
            where: {
              workspaceId: input.workspaceId,
              adId: input.adId.trim(),
              adAccountId: account.adAccountId,
            },
            select: {
              destinationAssignment: {
                select: {
                  reportingAccountId: true,
                  conversionDestinationId: true,
                },
              },
            },
          })
        : null;
      const currentAdDestinationId =
        adDestinationAssignment?.destinationAssignment?.reportingAccountId ===
        account.id
          ? adDestinationAssignment.destinationAssignment
              .conversionDestinationId
          : null;
      const destinationId =
        currentAdDestinationId ??
        input.conversionDestinationId ??
        account.conversionDestinationId ??
        connection.defaultConversionDestinationId;

      if (!destinationId) {
        throw new ConflictException(
          "Nenhum destino de conversao foi associado a esta conta Meta",
        );
      }

      const destination = await this.prisma.metaConversionDestination.findFirst(
        {
          where: {
            id: destinationId,
            workspaceId: input.workspaceId,
            status: "configured",
          },
        },
      );

      if (!destination) {
        throw new ConflictException(
          "O destino de conversao desta conta precisa ser validado",
        );
      }

      // Explicit destinations need an existing assignment/default or an active
      // account allowlist entry. Workspace membership alone is not authorization.
      if (
        input.conversionDestinationId &&
        input.conversionDestinationId !== destinationId
      )
        throw new ConflictException(
          "O destino explicito difere da rota do anuncio",
        );
      const allowed =
        await this.prisma.metaReportingAccountDestination.findMany({
          where: {
            workspaceId: input.workspaceId,
            reportingAccountId: account.id,
          },
        });
      const destinationAuthorized =
        allowed.length > 0
          ? allowed.some(
              (binding) =>
                binding.active &&
                binding.conversionDestinationId === destinationId,
            )
          : destinationId === account.conversionDestinationId ||
            destinationId === connection.defaultConversionDestinationId;
      if (!destinationAuthorized)
        throw new ConflictException(
          "Destino nao autorizado para esta conta Meta",
        );

      let accessToken = this.decrypt(connection.credential);
      // OAuth retains its dedicated CAPI token only for the matching legacy
      // account/BM. Manual routes always use their own credential.
      if (
        connection.credential.source === "oauth" &&
        legacy &&
        (legacy.selectedAdAccountId === account.adAccountId ||
          (legacy.selectedBusinessId &&
            legacy.selectedBusinessId === connection.businessManagerId)) &&
        legacy.capiAccessTokenEncrypted
      ) {
        if (legacy.status !== "connected")
          throw new ConflictException("Meta nao conectada");
        const dedicated = this.decrypt({
          encryptedAccessToken: legacy.capiAccessTokenEncrypted,
          tokenIv: legacy.capiTokenIv ?? "",
          tokenTag: legacy.capiTokenTag ?? "",
        });
        if (dedicated.trim()) accessToken = dedicated;
      }

      return {
        source:
          connection.credential.source === "oauth" ? "legacy_oauth" : "manual",
        workspaceId: input.workspaceId,
        accessToken,
        reportingAccountId: account.id,
        adAccountId: account.adAccountId,
        businessConnectionId: connection.id,
        credentialId: connection.credentialId,
        conversionDestinationId: destination.id,
        pixelId: destination.pixelId,
        pageId: destination.pageId,
      };
    }

    throw new ConflictException(
      adAccountId
        ? "A conta atribuida ao evento nao possui uma rota Meta ativa"
        : "Nao foi possivel determinar com seguranca qual conexao Meta deve enviar este evento",
    );
  }

  async getLegacyCompatibilityProjection(
    workspaceId: string,
    purpose: "reporting" | "capi" = "capi",
  ): Promise<LegacyMetaCompatibilityProjection> {
    const legacy = await this.getLegacyIntegration(workspaceId);
    const destination = await this.getLegacyDestination(
      workspaceId,
      legacy.primaryConversionDestinationId,
    );
    const encryptedAccessToken =
      purpose === "capi"
        ? (legacy.capiAccessTokenEncrypted ?? legacy.encryptedAccessToken)
        : legacy.encryptedAccessToken;
    const tokenIv =
      purpose === "capi"
        ? (legacy.capiTokenIv ?? legacy.tokenIv)
        : legacy.tokenIv;
    const tokenTag =
      purpose === "capi"
        ? (legacy.capiTokenTag ?? legacy.tokenTag)
        : legacy.tokenTag;
    const credentialFingerprint = this.encryption.fingerprint(
      this.decrypt({ encryptedAccessToken, tokenIv, tokenTag }),
    );

    return {
      source: "legacy_oauth",
      workspaceId,
      businessId: legacy.selectedBusinessId,
      adAccountId: legacy.selectedAdAccountId,
      pixelId: legacy.selectedPixelId,
      destinationPixelId: destination?.pixelId ?? null,
      destinationPageId: destination?.pageId ?? null,
      credentialFingerprint,
    };
  }

  private async resolveLegacyCapiRoute(
    workspaceId: string,
  ): Promise<ResolvedMetaCapiRoute> {
    const legacy = await this.getLegacyIntegration(workspaceId);
    const encryptedAccessToken =
      legacy.capiAccessTokenEncrypted ?? legacy.encryptedAccessToken;
    const tokenIv = legacy.capiTokenIv ?? legacy.tokenIv;
    const tokenTag = legacy.capiTokenTag ?? legacy.tokenTag;
    const destination = await this.getLegacyDestination(
      workspaceId,
      legacy.primaryConversionDestinationId,
    );

    return {
      source: "legacy_oauth",
      workspaceId,
      accessToken: this.decrypt({ encryptedAccessToken, tokenIv, tokenTag }),
      reportingAccountId: null,
      adAccountId: legacy.selectedAdAccountId,
      businessConnectionId: null,
      credentialId: null,
      conversionDestinationId: destination?.id ?? null,
      pixelId: destination?.pixelId ?? legacy.selectedPixelId,
      pageId: destination?.pageId ?? null,
    };
  }

  private async resolveAttributedAdAccountId(
    workspaceId: string,
    input: { adId?: string | null; campaignId?: string | null },
  ): Promise<string | null> {
    if (input.adId) {
      const ad = await this.prisma.metaAd.findFirst({
        where: { workspaceId, adId: input.adId },
        select: { adAccountId: true },
      });

      if (ad?.adAccountId) {
        return ad.adAccountId;
      }
    }

    if (input.campaignId) {
      const campaign = await this.prisma.metaCampaign.findFirst({
        where: { workspaceId, campaignId: input.campaignId },
        select: { adAccountId: true },
      });

      if (campaign?.adAccountId) {
        return campaign.adAccountId;
      }
    }

    return null;
  }

  private async onlyNormalizedReportingAccount(
    workspaceId: string,
    businessConnectionId?: string | null,
  ) {
    const accounts = await this.prisma.metaReportingAccount.findMany({
      where: {
        workspaceId,
        businessConnectionId: businessConnectionId ?? { not: null },
      },
      take: 2,
    });

    return accounts.length === 1 ? accounts[0] : null;
  }

  private async getLegacyIntegration(
    workspaceId: string,
  ): Promise<LegacyIntegration> {
    const legacy = (await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
    })) as LegacyIntegration | null;

    if (!legacy || legacy.status !== "connected") {
      throw new NotFoundException("Meta nao conectada");
    }

    return legacy;
  }

  private async getLegacyDestination(
    workspaceId: string,
    primaryConversionDestinationId: string | null,
  ) {
    if (!primaryConversionDestinationId) {
      return null;
    }

    const destination = await this.prisma.metaConversionDestination.findFirst({
      where: {
        workspaceId,
        id: primaryConversionDestinationId,
        status: "configured",
      },
    });
    if (!destination)
      throw new ConflictException("O destino legado precisa ser validado");
    return destination;
  }

  private async isNormalizedRoutingEnabled(
    workspaceId: string,
  ): Promise<boolean> {
    const [normalizedConnections, legacy] = await Promise.all([
      this.prisma.metaBusinessConnection.count({
        where: { workspaceId },
      }),
      this.prisma.metaIntegration.findUnique({
        where: { workspaceId },
        select: { advancedRoutingEnabled: true },
      }),
    ]);

    if (normalizedConnections === 0) {
      return false;
    }

    return legacy ? legacy.advancedRoutingEnabled : true;
  }

  private assertNormalizedConnectionActive(connection: {
    workspaceId: string;
    status: string;
    credential: {
      workspaceId: string;
      status: string;
      expiresAt?: Date | null;
    };
  }): void {
    if (connection.status !== "active") {
      throw new ConflictException(
        "A conexao Meta desta conta esta pausada ou requer validacao",
      );
    }

    if (
      connection.credential.workspaceId !== connection.workspaceId ||
      connection.credential.status !== "active" ||
      (connection.credential.expiresAt &&
        connection.credential.expiresAt <= new Date())
    ) {
      throw new ConflictException(
        "O token desta conexao Meta esta pausado ou requer validacao",
      );
    }
  }

  private decrypt(input: EncryptedCredential): string {
    try {
      return this.encryption.decrypt(input);
    } catch {
      throw new BadRequestException(
        "Nao foi possivel abrir a credencial Meta armazenada",
      );
    }
  }
}
