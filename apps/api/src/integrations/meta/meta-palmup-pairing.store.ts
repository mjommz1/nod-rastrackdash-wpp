import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from "@nestjs/common";
import Redis from "ioredis";
import { INTEGRATION_ENV, type IntegrationEnv } from "../integration.types";

const PAIRING_TTL_SECONDS = 10 * 60;

@Injectable()
export class MetaPalmupPairingStore implements OnModuleDestroy {
  private redis?: Redis;

  constructor(@Inject(INTEGRATION_ENV) private readonly env: IntegrationEnv) {}

  async save(
    workspaceId: string,
    pairingId: string,
    challenge: string,
  ): Promise<void> {
    try {
      const saved = await this.getRedis().set(
        this.key(workspaceId, pairingId),
        challenge,
        "EX",
        PAIRING_TTL_SECONDS,
        "NX",
      );
      if (saved !== "OK") throw new Error("Pairing not saved");
    } catch {
      throw new ServiceUnavailableException(
        "Login social PalmUP temporariamente indisponivel",
      );
    }
  }

  async consume(
    workspaceId: string,
    pairingId: string,
  ): Promise<string | null> {
    try {
      // GETDEL prevents concurrent completions, including across API replicas.
      return await this.getRedis().getdel(this.key(workspaceId, pairingId));
    } catch {
      throw new ServiceUnavailableException(
        "Login social PalmUP temporariamente indisponivel",
      );
    }
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  private key(workspaceId: string, pairingId: string): string {
    return `meta:palmup-connect:${encodeURIComponent(workspaceId)}:${pairingId}`;
  }

  private getRedis(): Redis {
    if (!this.redis) {
      this.redis = new Redis(this.env.REDIS_URL ?? "redis://localhost:6379", {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        connectTimeout: 1000,
      });
      // Command failures are mapped above; connection errors must not log credentials.
      this.redis.on("error", () => {});
    }
    return this.redis;
  }
}
