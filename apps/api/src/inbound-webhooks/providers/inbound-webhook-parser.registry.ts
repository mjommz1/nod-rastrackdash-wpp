import type { InboundWebhookParser } from "./inbound-webhook-parser";
import { DataCrazyV1Parser } from "./data-crazy/data-crazy-v1.parser";
import { GupshupV1Parser } from "./gupshup/gupshup-v1.parser";
import { MetaCloudV1Parser } from "./meta-cloud/meta-cloud-v1.parser";
import { UmblerV1Parser } from "./umbler/umbler-v1.parser";
import { UnnichatV1Parser } from "./unnichat/unnichat-v1.parser";
import { WahaV1Parser } from "./waha/waha-v1.parser";
import { ZapiV1Parser } from "./zapi/zapi-v1.parser";

export type InboundWebhookParserSelector = {
  provider: string;
  parserVersion: string;
  parserReleaseStatus?: string;
  parserRelease?: {
    status: string;
  };
};

export type InboundWebhookParserResolutionErrorCode =
  | "inbound_webhook_parser_not_found"
  | "inbound_webhook_parser_retired"
  | "inbound_webhook_parser_duplicate";

const resolutionErrorMessages: Record<
  InboundWebhookParserResolutionErrorCode,
  string
> = {
  inbound_webhook_parser_not_found: "Inbound webhook parser is not registered",
  inbound_webhook_parser_retired: "Inbound webhook parser release is retired",
  inbound_webhook_parser_duplicate:
    "Inbound webhook parser is registered more than once",
};

export class InboundWebhookParserResolutionError extends Error {
  readonly code: InboundWebhookParserResolutionErrorCode;

  constructor(code: InboundWebhookParserResolutionErrorCode) {
    super(resolutionErrorMessages[code]);
    this.name = "InboundWebhookParserResolutionError";
    this.code = code;
  }
}

function parserKey(provider: string, parserVersion: string): string {
  return JSON.stringify([provider, parserVersion]);
}

function defaultParsers(): InboundWebhookParser[] {
  return [
    new UmblerV1Parser(),
    new GupshupV1Parser(),
    new MetaCloudV1Parser(),
    new WahaV1Parser(),
    new ZapiV1Parser(),
    new DataCrazyV1Parser(),
    new UnnichatV1Parser(),
  ];
}

export class InboundWebhookParserRegistry {
  private readonly parsers = new Map<string, InboundWebhookParser>();

  constructor(parsers: readonly InboundWebhookParser[] = defaultParsers()) {
    for (const parser of parsers) {
      const key = parserKey(parser.provider, parser.parserVersion);

      if (this.parsers.has(key)) {
        throw new InboundWebhookParserResolutionError(
          "inbound_webhook_parser_duplicate",
        );
      }

      this.parsers.set(key, parser);
    }
  }

  resolve(connection: InboundWebhookParserSelector): InboundWebhookParser {
    const releaseStatus =
      connection.parserReleaseStatus ?? connection.parserRelease?.status;

    if (releaseStatus === "retired") {
      throw new InboundWebhookParserResolutionError(
        "inbound_webhook_parser_retired",
      );
    }

    const parser = this.parsers.get(
      parserKey(connection.provider, connection.parserVersion),
    );

    if (!parser) {
      throw new InboundWebhookParserResolutionError(
        "inbound_webhook_parser_not_found",
      );
    }

    return parser;
  }
}
