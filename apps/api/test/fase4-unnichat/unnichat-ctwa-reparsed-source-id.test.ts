import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { offline } from "./helpers/first-entry-offline";
import { InboundWebhookProductionService } from "../../src/inbound-webhook-production/inbound-webhook-production.service";
import { CtwaEntryMaterializationError } from "../../src/inbound-webhook-production/ctwa-entry-materialization";
import { ConversionRecordError } from "../../src/conversion-events/conversion-record.error";
import { InboundWebhookObservationService } from "../../src/inbound-webhooks/inbound-webhook-observation.service";
import {
  buildInboundWebhookEventDedupeKey,
  type InboundWebhookEventNormalizedSummary,
} from "../../src/inbound-webhooks/providers/inbound-webhook-parser";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { LeadsService } from "../../src/leads/leads.service";

// Production incident (connections 5520/1020, events 2026-10-10..13): the
// client started sending ctwa_id (SourceID) after the first events were
// stored. Before d02ddb6 the Unnichat parser ignored ctwa_id, so those events
// were persisted with adId null and classified authorized_ctwa_destination
// (page + pixel). Re-parsing the retained payload with the current parser now
// yields adId = ctwa_id and the no-ad materializer rejected it with a plain
// Error, surfacing as inbound_webhook_*_unexpected on every retry.
//
// Owner rule: Meta CAPI for these events needs only pixel + page_id +
// ctwa_clid; the ad id is optional enrichment. The canonical (stored) no-ad
// decision wins and the re-parsed SourceID is ignored.
//
// Adapted to this edition: Unnichat entries are not replayed (the student
// recovery flow stays Meta Cloud only), so the live production path carries
// every assertion; the backoffice recovery list does not exist here.

const SOURCE_ID = "120210000000000001";

function persisted(
  summary: InboundWebhookEventNormalizedSummary,
): Record<string, unknown> {
  const observation = Object.create(
    InboundWebhookObservationService.prototype,
  ) as {
    eventSummary(
      value: InboundWebhookEventNormalizedSummary,
    ): InboundWebhookEventNormalizedSummary;
    toJsonValue(value: object): unknown;
  };
  return observation.toJsonValue(observation.eventSummary(summary)) as Record<
    string,
    unknown
  >;
}

/** Stored row shapes seen in production for these events. */
function storeAs(
  h: ReturnType<typeof offline>,
  shape:
    "pre_parser_change_legacy_key" | "click_scoped_without_hash" | "current",
) {
  const summary = persisted(h.event.normalizedSummary);
  // Stored before d02ddb6: the old parser always wrote adId null.
  summary.adId = null;
  if (shape !== "current") delete summary.ctwaEntryIdentityHash;
  if (shape === "pre_parser_change_legacy_key")
    h.event.dedupeKey = buildInboundWebhookEventDedupeKey({
      provider: "unnichat",
      organizationId: "w",
      providerChannelId: h.channel.providerChannelId,
      externalMessageId: h.event.externalMessageId,
    });
  h.event.normalizedSummary = summary;
  h.event.adId = null;
  // The retained payload carries the SourceID the client started sending.
  h.payload.ctwa_id = SOURCE_ID;
}

const shapes = [
  "pre_parser_change_legacy_key",
  "click_scoped_without_hash",
  "current",
] as const;

describe("no-ad Unnichat entry whose retained payload now yields a SourceID", () => {
  it.each(shapes)(
    "live production materializes a %s event via page/pixel",
    async (shape) => {
      const h = offline();
      storeAs(h, shape);
      await expect(
        h.production.processItem({
          workspaceId: "w",
          productionItemId: "item",
        }),
      ).resolves.toEqual({ status: "materialized" });
      expect(h.logs[0]).toMatchObject({
        adId: null,
        sourcePayload: { processingMode: "live_production" },
      });
      expect(h.jobs).toHaveLength(1);
    },
  );

  it("still requires the clid proof: a payload without ctwa_clid fails with a typed code", async () => {
    const h = offline();
    storeAs(h, "current");
    const materializer =
      await import("../../src/inbound-webhook-production/ctwa-entry-materialization");
    const parsed = (h.production as any).reparseEvent(h.item);
    await expect(
      materializer.materializeCtwaEntry(
        h.prisma,
        h.event,
        { ...parsed, ctwaClid: null },
        new LeadsService(h.prisma),
        h.conversions,
        "event",
        "live_production",
      ),
    ).rejects.toMatchObject({
      name: "CtwaEntryMaterializationError",
      code: "identity_invalid",
    });
    expect(h.leads).toHaveLength(0);
    expect(h.logs).toHaveLength(0);
  });

  it("an unauthorized page/pixel destination fails closed with a typed code", async () => {
    const h = offline();
    storeAs(h, "current");
    h.destination.status = "disabled";
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).rejects.toThrow();
    expect(h.item.status).toBe("failed");
    expect(h.item.errorCode).toBe("inbound_webhook_production_route_invalid");
    expect(h.logs).toHaveLength(0);
  });
});

describe("typed failure mapping (nothing in the Unnichat path is _unexpected)", () => {
  const prismaError = new Prisma.PrismaClientKnownRequestError("conflict", {
    code: "P2034",
    clientVersion: "test",
  });
  const cases: Array<[unknown, string]> = [
    [new CtwaEntryMaterializationError("route_invalid"), "route_invalid"],
    [new CtwaEntryMaterializationError("identity_invalid"), "identity_invalid"],
    [new CtwaEntryMaterializationError("lead_invalid"), "lead_invalid"],
    [
      new ConversionRecordError("ctwa_original_receipt_ambiguous"),
      "ctwa_original_receipt_ambiguous",
    ],
    [
      new ConversionRecordError("ctwa_destination_not_authorized"),
      "route_invalid",
    ],
    [
      new ConversionRecordError("conversion_workspace_mismatch"),
      "conversion_workspace_mismatch",
    ],
    [prismaError, "database_error"],
  ];

  for (const [cls, prefix, method] of [
    [
      InboundWebhookProductionService,
      "inbound_webhook_production",
      "productionErrorCode",
    ],
  ] as const)
    it.each(cases)(`${cls.name} maps %s`, (error, suffix) => {
      const svc = Object.create(cls.prototype) as Record<
        string,
        (value: unknown) => string
      >;
      expect(svc[method].call(svc, error)).toBe(`${prefix}_${suffix}`);
    });

  it("keeps genuinely unknown errors as _unexpected", () => {
    const svc = Object.create(InboundWebhookProductionService.prototype) as any;
    expect(svc.productionErrorCode(new Error("boom"))).toBe(
      "inbound_webhook_production_unexpected",
    );
  });

  it("a payload that no longer decrypts gets a typed code", async () => {
    for (const [cls, prefix] of [
      [InboundWebhookProductionService, "inbound_webhook_production"],
    ] as const) {
      const h = offline();
      const svc = Object.assign(Object.create(cls.prototype), {
        parserRegistry: new InboundWebhookParserRegistry(),
        payloadEncryption: {
          decrypt: () => {
            throw new Error("Inbound webhook payload decryption failed");
          },
        },
      }) as any;
      let code: string | undefined;
      try {
        svc.reparseEvent(h.item);
      } catch (error) {
        code = svc.productionErrorCode(error);
      }
      expect(code).toBe(`${prefix}_payload_decrypt_failed`);
    }
  });
});
