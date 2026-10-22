import { ConflictException } from "@nestjs/common";
import type { RuntimeEnv } from "../common/runtime/runtime.module";
import { MetaCloudV1Parser } from "./providers/meta-cloud/meta-cloud-v1.parser";
import { InboundWebhookParserRegistry } from "./providers/inbound-webhook-parser.registry";

type Release = { provider: string; version: string; status: string };
const builtInRegistry = new InboundWebhookParserRegistry();

/** Product validation applies only to this shipped implementation and exact version.
 * Persisted observation_only is kept intact on upgrades; retired always wins.
 * This is eligibility, never automatic activation or historical authorization.
 */
export function inboundParserProductionEligible(
  release: Release,
  registry: InboundWebhookParserRegistry = builtInRegistry,
): boolean {
  if (!["certified", "observation_only"].includes(release.status)) return false;
  // Existing per-release certification contracts (including automation parsers)
  // remain unchanged. No new built-in trust is granted to other providers.
  if (release.provider !== "meta_cloud")
    return (
      [
        "umbler",
        "gupshup",
        "data_crazy",
        "waha",
        "zapi",
        "uazapi",
        // Fase 4a: Payt sale parsers (certified by migration).
        "payt",
        // Fase 4b: Unnichat entry and automation parsers (certified by migration).
        "unnichat",
      ].includes(release.provider) && release.status === "certified"
    );
  try {
    const parser = registry.resolve({
      provider: release.provider,
      parserVersion: release.version,
      parserReleaseStatus: release.status,
    });
    return (
      release.provider === "meta_cloud" &&
      release.version === "v1" &&
      parser.constructor === MetaCloudV1Parser
    );
  } catch {
    return false;
  }
}

export function effectiveInboundParserStatus<T extends Release>(
  release: T,
): T["status"] {
  return inboundParserProductionEligible(release)
    ? "certified"
    : release.status;
}

export const missingMetaSigningSecretMessage =
  "Configure META_APP_SECRET do seu proprio app Meta no ambiente da API antes de enviar. Nao use o segredo PalmUP nem cole segredos no chat.";

export function assertMetaCloudSigningConfigured(
  provider: string,
  env: RuntimeEnv,
): void {
  if (provider === "meta_cloud" && !env.META_APP_SECRET?.trim()) {
    throw new ConflictException(missingMetaSigningSecretMessage);
  }
}
