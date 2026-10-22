import { randomBytes } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  metaManualCredentialInputSchema,
  type MetaManualAssetDiscoveryDto,
} from "@wpptrack/shared";
import { z } from "zod";
import { INTEGRATION_ENV, type IntegrationEnv } from "../integration.types";
import { MetaManualConnectionsService } from "./meta-manual-connections.service";
import { MetaPalmupPairingStore } from "./meta-palmup-pairing.store";

export const metaPalmupConnectCompleteSchema = z
  .object({
    pairingId: z
      .string()
      .min(32)
      .max(128)
      .refine((value) => !/[^A-Za-z0-9_-]/.test(value)),
  })
  .strict();

const INVALID_PAIRING_MESSAGE =
  "Conexao PalmUP expirada, invalida ou ja utilizada. Inicie novamente";
const BROKER_FAILURE_MESSAGE =
  "Nao foi possivel concluir o login social PalmUP. Inicie novamente";

export type MetaPalmupConnectStart = {
  pairingId: string;
  challenge: string;
  authorizeUrl: string;
};

@Injectable()
export class MetaPalmupConnectService {
  constructor(
    @Inject(INTEGRATION_ENV) private readonly env: IntegrationEnv,
    @Inject(MetaPalmupPairingStore)
    private readonly pairings: MetaPalmupPairingStore,
    @Inject(MetaManualConnectionsService)
    private readonly manual: MetaManualConnectionsService,
  ) {}

  async start(workspaceId: string): Promise<MetaPalmupConnectStart> {
    const broker = this.requireBrokerOrigin();
    const pairingId = randomBytes(32).toString("base64url");
    const challenge = randomBytes(32).toString("base64url");
    await this.pairings.save(workspaceId, pairingId, challenge);
    const authorizeUrl = new URL(
      "/integrations/meta/student-connect/start",
      broker,
    );
    authorizeUrl.searchParams.set("pairingId", pairingId);
    authorizeUrl.searchParams.set("challenge", challenge);
    return { pairingId, challenge, authorizeUrl: authorizeUrl.toString() };
  }

  async complete(
    workspaceId: string,
    pairingId: string,
    actorUserId: string,
  ): Promise<MetaManualAssetDiscoveryDto> {
    const broker = this.requireBrokerOrigin();
    if (!metaPalmupConnectCompleteSchema.safeParse({ pairingId }).success) {
      throw new BadRequestException("pairingId invalido");
    }
    const challenge = await this.pairings.consume(workspaceId, pairingId);
    if (!challenge) throw new BadRequestException(INVALID_PAIRING_MESSAGE);

    // Consume before the request. A failed/ambiguous redemption requires a new start.
    let response: Response;
    try {
      response = await fetch(
        `${broker}/integrations/meta/student-connect/redeem`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairingId, challenge }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new BadGatewayException(BROKER_FAILURE_MESSAGE);
    }
    if (response.status === 404)
      throw new BadRequestException(INVALID_PAIRING_MESSAGE);
    if (!response.ok) throw new BadGatewayException(BROKER_FAILURE_MESSAGE);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BadGatewayException(BROKER_FAILURE_MESSAGE);
    }
    const input = metaManualCredentialInputSchema.safeParse({
      label: "Login social PalmUP",
      accessToken:
        payload && typeof payload === "object" && "accessToken" in payload
          ? payload.accessToken
          : undefined,
    });
    if (!input.success) throw new BadGatewayException(BROKER_FAILURE_MESSAGE);

    // Keep the existing Meta permission validation, encryption, audit and safe DTO.
    return this.manual.createCredential(workspaceId, input.data, actorUserId);
  }

  private requireBrokerOrigin(): string {
    const configured = this.env.PALMUP_META_BROKER_URL?.trim();
    try {
      if (!configured || !/^https:\/\/[^/?#\\\s]+\/?$/i.test(configured))
        throw new Error();
      const url = new URL(configured);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        throw new Error();
      }
      return url.origin;
    } catch {
      throw new ServiceUnavailableException(
        "Login social PalmUP nao configurado",
      );
    }
  }
}
