import { createPublicKey, type KeyLike } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, RUNTIME_FETCH, type RuntimeEnv, type RuntimeFetch } from "../common/runtime/runtime.module";
import { verifyCompactToken } from "./compact-token";
import { computeFingerprint } from "./fingerprint";
import { LicenseAccountMismatchError } from "./license-client-errors";
import {
  DEFAULT_LICENSE_SERVER_URL,
  LICENSE_GRACE_WINDOW_MS,
  LICENSE_STATE_ID,
} from "./license-client.constants";
import type {
  LicenseActionResult,
  LicenseLockReason,
  LicenseLockState,
  LicensePublicKeyResult,
  LicenseRuntimeState,
} from "./license-client.types";

function unlicensedState(reason: LicenseLockReason, interval: string | null): LicenseRuntimeState {
  return {
    status: "unlicensed",
    softLock: true,
    hardLock: true,
    usable: false,
    expiresAt: null,
    validUntil: null,
    source: "cache",
    reason,
    interval,
  };
}

/**
 * Client for the private PalmUP license server. Talks over HTTP only — this
 * public template contains no license-issuing logic. See
 * .claude-task-f4-1-license-client.md for the server contract this was built
 * against.
 */
@Injectable()
export class LicenseClientService {
  private readonly logger = new Logger(LicenseClientService.name);
  private publicKeyCache: KeyLike | null = null;
  /**
   * Set when the most recent activation attempt failed with a key present,
   * cleared on the next success. Process-local on purpose: LicenseState has
   * no column for it and this template must not add a migration, so a restart
   * degrades the lock reason from "activation_failed" back to the equally
   * locked "license_required".
   */
  private lastActivationError: string | null = null;
  /** Subscription period from the last verified server response, when it reports one. */
  private lastKnownInterval: string | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv = process.env,
    @Optional() @Inject(RUNTIME_FETCH) private readonly fetchFn: RuntimeFetch = fetch,
  ) {}

  /** True once LICENSE_KEY + LICENSE_ACCOUNT_IDENTITY are set — gates the scheduler and activation. */
  isConfigured(): boolean {
    return Boolean(this.env.LICENSE_KEY?.trim() && this.env.LICENSE_ACCOUNT_IDENTITY?.trim());
  }

  getFingerprint(): string {
    const appOrigin = this.env.APP_ORIGIN?.trim() || this.env.WEB_ORIGIN?.trim() || this.env.API_PUBLIC_URL?.trim() || "";
    return computeFingerprint(appOrigin);
  }

  async activate(options?: { key?: string; appVersion?: string; deployLabel?: string }): Promise<LicenseRuntimeState> {
    const key = options?.key?.trim() || this.env.LICENSE_KEY?.trim();
    const accountIdentity = this.env.LICENSE_ACCOUNT_IDENTITY?.trim();
    if (!key || !accountIdentity) {
      throw new Error("license_client_not_configured");
    }

    const fingerprint = this.getFingerprint();
    try {
      const response = await this.fetchFn(this.serverUrl("/license/activate"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          fingerprint,
          accountIdentity,
          appVersion: options?.appVersion,
          deployLabel: options?.deployLabel,
        }),
      });
      if (!response.ok) {
        // The private license server responds 403/409 specifically when the
        // key is already bound to a different accountIdentity — single
        // attempt, no retry loop (see .claude-task-f4-2-softlock.md #3).
        if (response.status === 403 || response.status === 409) {
          throw new LicenseAccountMismatchError();
        }
        throw new Error(`license_activate_failed:${response.status}`);
      }
      const result = (await response.json()) as LicenseActionResult;
      const state = await this.persistVerifiedResult(result, fingerprint, accountIdentity);
      this.lastActivationError = null;
      return state;
    } catch (error) {
      // Fail closed: a key that is configured but never activated cleanly
      // must not leave the install usable (see .claude-task-license-hard-lock.md #2).
      this.lastActivationError = error instanceof Error ? error.message : "license_activate_failed";
      this.logger.warn(`license_activate_error:${this.lastActivationError}`);
      throw error;
    }
  }

  /**
   * True when licensing is switched off entirely: no LICENSE_SERVER_URL
   * configured (local development of this template). With a server
   * configured, an install that never activated is LOCKED, not inert — the
   * student edition is unusable until a license is activated.
   */
  async isInert(): Promise<boolean> {
    return !this.env.LICENSE_SERVER_URL?.trim();
  }

  /**
   * Single source of truth for "may this install write?", shared by the
   * soft-lock guard and the public status endpoint.
   */
  async getLockState(
    client?: Pick<Prisma.TransactionClient, "licenseState">,
  ): Promise<LicenseLockState> {
    if (await this.isInert()) {
      return {
        inert: true,
        locked: false,
        reason: null,
        state: unlicensedState("license_required", this.lastKnownInterval),
      };
    }

    const state = await this.getState(client);
    if (state.usable) {
      return { inert: false, locked: false, reason: null, state };
    }
    return { inert: false, locked: true, reason: state.reason ?? "revoked", state };
  }

  async heartbeat(): Promise<LicenseRuntimeState> {
    const key = this.env.LICENSE_KEY?.trim();
    if (!key) {
      throw new Error("license_client_not_configured");
    }

    const existing = await this.prisma.licenseState.findUnique({ where: { id: LICENSE_STATE_ID } });
    const fingerprint = existing?.fingerprint ?? this.getFingerprint();

    try {
      const response = await this.fetchFn(this.serverUrl("/license/heartbeat"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, fingerprint }),
      });
      if (!response.ok) {
        throw new Error(`license_heartbeat_failed:${response.status}`);
      }
      const result = (await response.json()) as LicenseActionResult;
      const accountIdentity = existing?.accountIdentity ?? this.env.LICENSE_ACCOUNT_IDENTITY?.trim() ?? "";
      return await this.persistVerifiedResult(result, fingerprint, accountIdentity);
    } catch (error) {
      // Network/verification failure never turns into a status change here.
      // We fail OPEN (grace, derived from cached data) rather than blocking a
      // student out for a transient outage; only a *verified* server
      // response is allowed to set status to "blocked".
      const message = error instanceof Error ? error.message : "unknown_license_heartbeat_error";
      this.logger.warn(`license_heartbeat_error:${message}`);
      if (existing) {
        await this.prisma.licenseState.update({
          where: { id: LICENSE_STATE_ID },
          data: { lastError: message },
        });
      }
      return this.getState();
    }
  }

  /** Verify a compact cacheToken against the server's published Ed25519 public key. */
  async verifyCache(token: string) {
    const publicKey = await this.getPublicKey();
    return verifyCompactToken(token, publicKey);
  }

  async getState(
    client: Pick<Prisma.TransactionClient, "licenseState"> = this.prisma,
  ): Promise<LicenseRuntimeState> {
    const row = await client.licenseState.findUnique({ where: { id: LICENSE_STATE_ID } });
    if (!row) {
      // Never activated: a configured key whose activation failed is reported
      // separately so the UI can tell "activate it" from "fix the key".
      return unlicensedState(
        this.lastActivationError ? "activation_failed" : "license_required",
        this.lastKnownInterval,
      );
    }

    const { status, reason } = this.deriveStatus(row.status, row.expiresAt, row.cacheValidUntil, row.lastCheckedAt);
    return {
      status,
      softLock: status !== "active",
      hardLock: status === "blocked" || status === "unlicensed",
      usable: status === "active" || status === "grace",
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      validUntil: row.cacheValidUntil ? row.cacheValidUntil.toISOString() : null,
      source: "cache",
      reason,
      interval: this.lastKnownInterval,
    };
  }

  /**
   * Grace algorithm: a *verified* blocked verdict from the server is
   * fail-closed and sticks until a future successful activate/heartbeat
   * overrides it. Otherwise, an unexpired cache is trusted as-is; once it
   * expires we fail open into "grace" for up to 72h since the last
   * confirmed server contact, then fail closed to "blocked".
   */
  private deriveStatus(
    storedStatus: string,
    expiresAt: Date | null,
    cacheValidUntil: Date | null,
    lastCheckedAt: Date | null,
  ): { status: LicenseRuntimeState["status"]; reason: LicenseLockReason | null } {
    const now = Date.now();
    if (storedStatus === "blocked") {
      const reason: LicenseLockReason = expiresAt && expiresAt.getTime() <= now ? "expired" : "revoked";
      return { status: "blocked", reason };
    }
    if (cacheValidUntil && cacheValidUntil.getTime() > now) {
      return { status: isLicenseStatus(storedStatus) ? storedStatus : "active", reason: null };
    }
    if (!lastCheckedAt) {
      return { status: "blocked", reason: "expired" };
    }
    const elapsedSinceLastCheck = now - lastCheckedAt.getTime();
    if (elapsedSinceLastCheck <= LICENSE_GRACE_WINDOW_MS) {
      return { status: "grace", reason: null };
    }
    return { status: "blocked", reason: "grace_exceeded" };
  }

  private async persistVerifiedResult(
    result: LicenseActionResult,
    fingerprint: string,
    accountIdentity: string,
  ): Promise<LicenseRuntimeState> {
    const publicKey = await this.getPublicKey();
    const verification = verifyCompactToken(result.cacheToken, publicKey);
    if (!verification.valid) {
      throw new Error(`license_cache_token_invalid:${verification.reason ?? "unknown"}`);
    }

    if (result.interval !== undefined) {
      this.lastKnownInterval = result.interval;
    }

    const data = {
      fingerprint,
      accountIdentity,
      licenseKeyPrefix: result.keyPrefix,
      signedCache: result.cacheToken,
      cacheValidUntil: new Date(result.validUntil),
      lastCheckedAt: new Date(),
      lastError: null,
      status: result.status,
      expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
      bound: result.bound,
    };
    await this.prisma.licenseState.upsert({
      where: { id: LICENSE_STATE_ID },
      create: { id: LICENSE_STATE_ID, ...data },
      update: data,
    });

    const reason: LicenseLockReason | null =
      result.status === "blocked"
        ? result.expiresAt && new Date(result.expiresAt).getTime() <= Date.now()
          ? "expired"
          : "revoked"
        : null;
    return {
      status: result.status,
      softLock: result.softLock,
      hardLock: result.hardLock,
      usable: result.usable,
      expiresAt: result.expiresAt ?? null,
      validUntil: result.validUntil,
      source: "server",
      reason,
      interval: this.lastKnownInterval,
    };
  }

  private serverUrl(path: string): string {
    const base = (this.env.LICENSE_SERVER_URL?.trim() || DEFAULT_LICENSE_SERVER_URL).replace(/\/$/, "");
    return `${base}${path}`;
  }

  private async getPublicKey(): Promise<KeyLike> {
    if (this.publicKeyCache) {
      return this.publicKeyCache;
    }
    const response = await this.fetchFn(this.serverUrl("/license/public-key"));
    if (!response.ok) {
      throw new Error(`license_public_key_fetch_failed:${response.status}`);
    }
    const body = (await response.json()) as LicensePublicKeyResult;
    if (body.alg !== "Ed25519") {
      throw new Error(`license_public_key_unsupported_alg:${body.alg}`);
    }
    // Assumes the server delivers the key as a PEM-encoded SPKI string (the
    // most self-describing option); adjust here if the private server ships
    // raw base64 DER bytes instead.
    this.publicKeyCache = createPublicKey(body.publicKey);
    return this.publicKeyCache;
  }
}

function isLicenseStatus(value: string): value is LicenseRuntimeState["status"] {
  return value === "active" || value === "grace" || value === "blocked" || value === "unlicensed";
}
