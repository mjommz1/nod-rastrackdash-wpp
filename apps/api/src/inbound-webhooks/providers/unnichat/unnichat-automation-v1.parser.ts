import { createHash } from "node:crypto";
import { parseUnnichatV1Payload } from "./unnichat-v1.parser";

export const UNNICHAT_AUTOMATION_V1_SCHEMA = "wpptrack.unnichat.automation.v1";
export const UNNICHAT_AUTOMATION_V1_PARSER_VERSION = "automation-v1";

export type ParsedUnnichatAutomationV1 = {
  phone: string;
  hasCtwa: boolean;
  ctwaClid: string | null;
  occurredAt: Date;
  externalExecutionKey: string;
};

export type UnnichatAutomationV1ParseResult =
  | { ok: true; value: ParsedUnnichatAutomationV1 }
  | { ok: false; errorCode: "unnichat_automation_v1_invalid_payload" };

function executionKey(input: {
  event: string;
  externalId: string;
  origin: string;
  phone: string;
}): string {
  const digest = createHash("sha256")
    .update(UNNICHAT_AUTOMATION_V1_SCHEMA, "utf8")
    .update("\0", "utf8")
    .update(input.event, "utf8")
    .update("\0", "utf8")
    .update(input.externalId, "utf8")
    .update("\0", "utf8")
    .update(input.origin, "utf8")
    .update("\0", "utf8")
    .update(input.phone, "utf8")
    .digest("hex");

  return `unnichat-automation:${digest}`;
}

export function parseUnnichatAutomationV1(
  payload: unknown,
): UnnichatAutomationV1ParseResult {
  try {
    const body = parseUnnichatV1Payload(payload);
    if (!body) {
      return { ok: false, errorCode: "unnichat_automation_v1_invalid_payload" };
    }

    return {
      ok: true,
      value: {
        phone: body.phone,
        hasCtwa: body.ctwaClid !== null,
        ctwaClid: body.ctwaClid,
        // The provider contract has no timestamp, so this remains delivery time.
        occurredAt: new Date(),
        externalExecutionKey: executionKey(body),
      },
    };
  } catch {
    return { ok: false, errorCode: "unnichat_automation_v1_invalid_payload" };
  }
}
