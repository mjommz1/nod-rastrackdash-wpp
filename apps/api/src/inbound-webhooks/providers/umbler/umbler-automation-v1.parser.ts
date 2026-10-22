import { createHash } from "node:crypto";
import { normalizePhoneIdentity } from "../../../common/phone/phone-identity";
import { boundedString } from "../inbound-webhook-delivery-identity";

export const UMBLER_AUTOMATION_V1_SCHEMA = "wpptrack.umbler.automation.v1";
export const UMBLER_AUTOMATION_V1_SOURCE = "umbler_tag_automation";
export const UMBLER_AUTOMATION_V1_PARSER_VERSION = "automation-v1";

export type UmblerAutomationV1EventName = "QualifiedLead" | "Purchase";

export type ParsedUmblerAutomationV1 = {
  provider?: "umbler";
  schema: typeof UMBLER_AUTOMATION_V1_SCHEMA;
  source: typeof UMBLER_AUTOMATION_V1_SOURCE;
  automation: "lead_qualificado" | "compra_aprovada";
  eventName: UmblerAutomationV1EventName;
  phone: string;
  conversationId: string;
  occurredAt: Date;
  externalExecutionKey: string;
};

export type UmblerAutomationV1ParseResult =
  | { ok: true; value: ParsedUmblerAutomationV1 }
  | { ok: false; errorCode: "umbler_automation_v1_invalid_payload" };

const automationEventNames = {
  lead_qualificado: "QualifiedLead",
  compra_aprovada: "Purchase",
} as const satisfies Record<string, UmblerAutomationV1EventName>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseUtcTimestamp(value: unknown): Date | null {
  const timestamp = boundedString(value, 80);
  if (!timestamp) return null;

  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(
    timestamp,
  )
    ? `${timestamp.replace(" ", "T")}Z`
    : timestamp;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized)) return null;

  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

function executionKey(input: {
  automation: string;
  phone: string;
  conversationId: string;
  occurredAt: Date;
}): string {
  const digest = createHash("sha256")
    .update(UMBLER_AUTOMATION_V1_SCHEMA, "utf8")
    .update("\0", "utf8")
    .update(input.automation, "utf8")
    .update("\0", "utf8")
    .update(input.phone, "utf8")
    .update("\0", "utf8")
    .update(input.conversationId, "utf8")
    .update("\0", "utf8")
    .update(input.occurredAt.toISOString(), "utf8")
    .digest("hex");

  return `umbler-automation:${digest}`;
}

export function parseUmblerAutomationV1(
  payload: unknown,
): UmblerAutomationV1ParseResult {
  try {
    const envelope = asRecord(payload);
    const contact = envelope ? asRecord(envelope.contact) : null;
    const conversation = envelope ? asRecord(envelope.conversation) : null;
    const schema = envelope ? boundedString(envelope.schema, 120) : null;
    const source = envelope ? boundedString(envelope.source, 120) : null;
    const automation = envelope
      ? boundedString(envelope.automation, 120)?.toLocaleLowerCase("pt-BR")
      : null;
    const phone = normalizePhoneIdentity(
      contact && typeof contact.phone === "string" ? contact.phone : undefined,
    );
    const conversationId = conversation
      ? boundedString(conversation.id, 255)
      : null;
    const occurredAt = conversation
      ? parseUtcTimestamp(conversation.created_at_utc)
      : null;
    const eventName = automation
      ? (automationEventNames[
          automation as keyof typeof automationEventNames
        ] ?? null)
      : null;

    if (
      schema !== UMBLER_AUTOMATION_V1_SCHEMA ||
      source !== UMBLER_AUTOMATION_V1_SOURCE ||
      !automation ||
      !eventName ||
      !phone ||
      !conversationId ||
      !occurredAt
    ) {
      return { ok: false, errorCode: "umbler_automation_v1_invalid_payload" };
    }

    return {
      ok: true,
      value: {
        schema: UMBLER_AUTOMATION_V1_SCHEMA,
        source: UMBLER_AUTOMATION_V1_SOURCE,
        automation: automation as ParsedUmblerAutomationV1["automation"],
        eventName,
        phone,
        conversationId,
        occurredAt,
        externalExecutionKey: executionKey({
          automation,
          phone,
          conversationId,
          occurredAt,
        }),
      },
    };
  } catch {
    return { ok: false, errorCode: "umbler_automation_v1_invalid_payload" };
  }
}
