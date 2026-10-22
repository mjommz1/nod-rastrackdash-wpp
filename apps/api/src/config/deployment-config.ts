import { z } from "zod";

const metaConnectionModes = ["oauth", "manual"] as const;
const emailAddressSchema = z.string().email();
const inboundWebhookEncryptionKeyPattern = /^[A-Za-z0-9+/]{43}=$/;

export const INBOUND_WEBHOOK_RAW_RETENTION_DAYS = 7 as const;

type Environment = Readonly<Record<string, string | undefined>>;

export type MetaConnectionMode = (typeof metaConnectionModes)[number];

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromAddress: string;
  replyTo: string;
}

export type EmailConfig =
  | {
      provider: "";
      smtp: null;
    }
  | {
      provider: "smtp";
      smtp: SmtpConfig;
    };

export type InboundWebhooksConfig =
  | {
      enabled: false;
      replayEnabled: false;
      productionEnabled: false;
      conversionRulesEnabled: false;
      conversionProductionEnabled: false;
      apiPublicUrl: null;
      encryptionKey: null;
      rawPayloadRetentionDays: typeof INBOUND_WEBHOOK_RAW_RETENTION_DAYS;
    }
  | {
      enabled: true;
      replayEnabled: boolean;
      productionEnabled: boolean;
      conversionRulesEnabled: boolean;
      conversionProductionEnabled: boolean;
      apiPublicUrl: string;
      encryptionKey: Buffer;
      rawPayloadRetentionDays: typeof INBOUND_WEBHOOK_RAW_RETENTION_DAYS;
    };

export interface DeploymentConfig {
  authGoogleEnabled: boolean;
  metaConnectionModes: MetaConnectionMode[];
  email: EmailConfig;
  inboundWebhooks: InboundWebhooksConfig;
  webOrigin: string;
}

export class DeploymentConfigError extends Error {
  constructor(field: string, expectation: string) {
    super(`Invalid ${field}: ${expectation}`);
    this.name = "DeploymentConfigError";
  }
}

function invalid(field: string, expectation: string): never {
  throw new DeploymentConfigError(field, expectation);
}

function requiredValue(
  env: Environment,
  field: string,
  preserveWhitespace = false,
): string {
  const value = env[field];

  if (value === undefined || value.trim() === "") {
    invalid(field, "required when EMAIL_PROVIDER=smtp");
  }

  return preserveWhitespace ? value : value.trim();
}

function parseBoolean(
  field: string,
  value: string | undefined,
  fallback?: boolean,
): boolean {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    if (fallback !== undefined) {
      return fallback;
    }

    invalid(field, "required when EMAIL_PROVIDER=smtp");
  }

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return invalid(field, "expected true or false");
}

function isMetaConnectionMode(value: string): value is MetaConnectionMode {
  return metaConnectionModes.includes(value as MetaConnectionMode);
}

function parseMetaConnectionMode(value: string): MetaConnectionMode {
  if (isMetaConnectionMode(value)) {
    return value;
  }

  return invalid(
    "META_CONNECTION_MODES",
    "expected a comma-separated list containing only oauth and manual",
  );
}

function parseMetaConnectionModes(
  value: string | undefined,
): MetaConnectionMode[] {
  const normalized = value?.trim();

  if (!normalized) {
    return ["oauth"];
  }

  const values = normalized.split(",").map((mode) => mode.trim().toLowerCase());
  const modes: MetaConnectionMode[] = [];

  for (const value of values) {
    const mode = parseMetaConnectionMode(value);

    if (!modes.includes(mode)) {
      modes.push(mode);
    }
  }

  return modes;
}

function parseSmtpPort(value: string): number {
  if (!/^\d+$/.test(value)) {
    invalid("SMTP_PORT", "expected an integer between 1 and 65535");
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    invalid("SMTP_PORT", "expected an integer between 1 and 65535");
  }

  return parsed;
}

function parseEmailAddress(env: Environment, field: string): string {
  const value = requiredValue(env, field);

  if (!emailAddressSchema.safeParse(value).success) {
    invalid(field, "expected a valid email address");
  }

  return value;
}

function parseEmailConfig(env: Environment): EmailConfig {
  const provider = env.EMAIL_PROVIDER?.trim().toLowerCase() ?? "";

  if (provider === "") {
    return { provider: "", smtp: null };
  }

  if (provider !== "smtp") {
    invalid("EMAIL_PROVIDER", "expected empty or smtp");
  }

  const smtp = {
    host: requiredValue(env, "SMTP_HOST"),
    port: parseSmtpPort(requiredValue(env, "SMTP_PORT")),
    secure: parseBoolean("SMTP_SECURE", env.SMTP_SECURE),
    user: requiredValue(env, "SMTP_USER"),
    password: requiredValue(env, "SMTP_PASSWORD", true),
    fromName: requiredValue(env, "EMAIL_FROM_NAME"),
    fromAddress: parseEmailAddress(env, "EMAIL_FROM_ADDRESS"),
    replyTo: parseEmailAddress(env, "EMAIL_REPLY_TO"),
  };

  assertProductionBrevoConfig(env, smtp);

  return {
    provider,
    smtp,
  };
}

function assertProductionBrevoConfig(env: Environment, smtp: SmtpConfig): void {
  if (env.NODE_ENV?.trim().toLowerCase() !== "production") {
    return;
  }

  if (smtp.host.toLowerCase() !== "smtp-relay.brevo.com") {
    invalid("SMTP_HOST", "expected smtp-relay.brevo.com in production");
  }

  if (smtp.port !== 587) {
    invalid("SMTP_PORT", "expected port 587 for Brevo STARTTLS in production");
  }

  if (smtp.secure) {
    invalid("SMTP_SECURE", "expected false for Brevo STARTTLS on port 587");
  }

  if (smtp.fromAddress.toLowerCase() !== "noreply@rastrack.app") {
    invalid(
      "EMAIL_FROM_ADDRESS",
      "expected noreply@rastrack.app in production",
    );
  }

  if (smtp.replyTo.toLowerCase() !== "suporte@rastrack.app") {
    invalid("EMAIL_REPLY_TO", "expected suporte@rastrack.app in production");
  }
}

function isLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function parseWebOrigin(env: Environment): string {
  const value = env.WEB_ORIGIN?.trim();

  if (!value) {
    invalid("WEB_ORIGIN", "required as an absolute URL");
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    invalid("WEB_ORIGIN", "expected an absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    invalid("WEB_ORIGIN", "expected an absolute HTTP or HTTPS URL");
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    invalid("WEB_ORIGIN", "expected an origin without path or credentials");
  }

  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  const localHttpAllowed =
    parsed.protocol === "http:" &&
    (nodeEnv === "development" || nodeEnv === "test") &&
    isLocalhost(parsed.hostname);

  if (parsed.protocol !== "https:" && !localHttpAllowed) {
    invalid(
      "WEB_ORIGIN",
      "expected HTTPS, except HTTP localhost in development or test",
    );
  }

  return parsed.origin;
}

function parseApiPublicUrl(env: Environment): string {
  const value = env.API_PUBLIC_URL?.trim();

  if (!value) {
    invalid("API_PUBLIC_URL", "required when INBOUND_WEBHOOKS_ENABLED=true");
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    invalid("API_PUBLIC_URL", "expected an absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    invalid("API_PUBLIC_URL", "expected an absolute HTTP or HTTPS URL");
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    invalid("API_PUBLIC_URL", "expected an origin without path or credentials");
  }

  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  const localHttpAllowed =
    parsed.protocol === "http:" &&
    (nodeEnv === "development" || nodeEnv === "test") &&
    isLocalhost(parsed.hostname);

  if (parsed.protocol !== "https:" && !localHttpAllowed) {
    invalid(
      "API_PUBLIC_URL",
      "expected HTTPS, except HTTP localhost in development or test",
    );
  }

  return parsed.origin;
}

function parseInboundWebhookEncryptionKey(env: Environment): Buffer {
  const value = env.INBOUND_WEBHOOK_ENCRYPTION_KEY?.trim();

  if (!value) {
    invalid(
      "INBOUND_WEBHOOK_ENCRYPTION_KEY",
      "required when INBOUND_WEBHOOKS_ENABLED=true",
    );
  }

  if (!inboundWebhookEncryptionKeyPattern.test(value)) {
    invalid(
      "INBOUND_WEBHOOK_ENCRYPTION_KEY",
      "expected a Base64-encoded 32-byte key",
    );
  }

  const key = Buffer.from(value, "base64");

  if (key.length !== 32) {
    invalid(
      "INBOUND_WEBHOOK_ENCRYPTION_KEY",
      "expected a Base64-encoded 32-byte key",
    );
  }

  return key;
}

export function parseInboundWebhooksConfig(
  env: Environment,
): InboundWebhooksConfig {
  const enabled = parseBoolean(
    "INBOUND_WEBHOOKS_ENABLED",
    env.INBOUND_WEBHOOKS_ENABLED,
    false,
  );

  if (!enabled) {
    return {
      enabled: false,
      replayEnabled: false,
      productionEnabled: false,
      conversionRulesEnabled: false,
      conversionProductionEnabled: false,
      apiPublicUrl: null,
      encryptionKey: null,
      rawPayloadRetentionDays: INBOUND_WEBHOOK_RAW_RETENTION_DAYS,
    };
  }

  const conversionRulesEnabled = parseBoolean(
    "INBOUND_CONVERSION_RULES_ENABLED",
    env.INBOUND_CONVERSION_RULES_ENABLED,
    false,
  );
  const conversionProductionEnabled = parseBoolean(
    "INBOUND_CONVERSION_PRODUCTION_ENABLED",
    env.INBOUND_CONVERSION_PRODUCTION_ENABLED,
    false,
  );

  if (conversionProductionEnabled && !conversionRulesEnabled) {
    invalid(
      "INBOUND_CONVERSION_PRODUCTION_ENABLED",
      "requires INBOUND_CONVERSION_RULES_ENABLED=true",
    );
  }

  return {
    enabled: true,
    replayEnabled: parseBoolean(
      "INBOUND_WEBHOOK_REPLAY_ENABLED",
      env.INBOUND_WEBHOOK_REPLAY_ENABLED,
      false,
    ),
    productionEnabled: parseBoolean(
      "INBOUND_WEBHOOK_PRODUCTION_ENABLED",
      env.INBOUND_WEBHOOK_PRODUCTION_ENABLED,
      false,
    ),
    conversionRulesEnabled,
    conversionProductionEnabled,
    apiPublicUrl: parseApiPublicUrl(env),
    encryptionKey: parseInboundWebhookEncryptionKey(env),
    rawPayloadRetentionDays: INBOUND_WEBHOOK_RAW_RETENTION_DAYS,
  };
}

/**
 * PIPEDRIVE_CRM_ENCRYPTION_KEY (optional): 32 random bytes in canonical
 * base64 (`openssl rand -base64 32`), used only to seal Pipedrive API tokens.
 * Returns null when it is unset or invalid; the Pipedrive service then refuses
 * to connect. It must never reuse the Kommo key.
 */
export function pipedriveCrmEncryptionKey(env: Environment): Buffer | null {
  const value = env.PIPEDRIVE_CRM_ENCRYPTION_KEY?.trim();
  if (!value || !inboundWebhookEncryptionKeyPattern.test(value)) return null;
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) return null;
  if (value === env.KOMMO_CRM_ENCRYPTION_KEY?.trim()) return null;
  return key;
}

/**
 * Boot check of the optional Pipedrive key: an installation without the
 * variable boots exactly as before; a value that is set must be valid and
 * different from KOMMO_CRM_ENCRYPTION_KEY.
 */
function validatePipedriveCrmEncryptionKey(env: Environment): void {
  const value = env.PIPEDRIVE_CRM_ENCRYPTION_KEY?.trim();
  if (!value) return;
  if (value === env.KOMMO_CRM_ENCRYPTION_KEY?.trim())
    invalid(
      "PIPEDRIVE_CRM_ENCRYPTION_KEY",
      "must differ from KOMMO_CRM_ENCRYPTION_KEY",
    );
  if (!pipedriveCrmEncryptionKey(env))
    invalid(
      "PIPEDRIVE_CRM_ENCRYPTION_KEY",
      "expected a Base64-encoded 32-byte key (openssl rand -base64 32)",
    );
}

export function parseDeploymentConfig(
  env: Environment = process.env,
): DeploymentConfig {
  validatePipedriveCrmEncryptionKey(env);
  return {
    authGoogleEnabled: parseBoolean(
      "AUTH_GOOGLE_ENABLED",
      env.AUTH_GOOGLE_ENABLED,
      false,
    ),
    metaConnectionModes: parseMetaConnectionModes(env.META_CONNECTION_MODES),
    email: parseEmailConfig(env),
    inboundWebhooks: parseInboundWebhooksConfig(env),
    webOrigin: parseWebOrigin(env),
  };
}
