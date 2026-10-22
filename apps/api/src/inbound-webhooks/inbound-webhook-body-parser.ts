import type { NestExpressApplication } from "@nestjs/platform-express";
import { INBOUND_WEBHOOK_BODY_LIMIT } from "./inbound-webhook-limits";

const { raw } = require("body-parser") as {
  raw: (...arguments_: unknown[]) => any;
};

type RequestWithRawBody = {
  rawBody?: Buffer;
};

function captureRawBody(
  request: RequestWithRawBody,
  _response: unknown,
  buffer: Buffer,
): void {
  request.rawBody = Buffer.from(buffer);
}

/**
 * Installs the inbound webhook parser before the application JSON parser.
 *
 * Inbound providers sometimes send a JSON string as the root value. Keeping
 * this route raw lets ingestion return its stable validation response instead
 * of body-parser rejecting it before the controller can run.
 */
export function configureInboundWebhookBodyParser(
  app: NestExpressApplication,
): void {
  app.use(
    "/webhooks/inbound",
    raw({
      // Providers do not consistently label webhook JSON as application/json.
      // Capture every POST on this public ingress before any JSON parser can
      // consume its stream; ingestion performs the fail-closed JSON check.
      type: (request: { method?: string }) => request.method === "POST",
      limit: INBOUND_WEBHOOK_BODY_LIMIT,
      verify: captureRawBody,
    }),
  );
  app.use(
    "/webhooks/kommo",
    raw({
      type: (request: { method?: string }) => request.method === "POST",
      limit: "256kb",
      verify: captureRawBody,
    }),
  );
  // Pipedrive Webhooks v2: the bounded JSON decoder runs in the service on
  // the raw bytes; parser failures answer a constant, non-echoing error.
  app.use(
    "/webhooks/pipedrive",
    raw({
      type: (request: { method?: string }) => request.method === "POST",
      limit: "100kb",
      inflate: false,
      verify: captureRawBody,
    }),
  );
  app.use(
    "/webhooks/pipedrive",
    (
      error: { status?: number },
      _request: unknown,
      response: { status: (code: number) => { json: (body: unknown) => void } },
      _next: unknown,
    ) => {
      const status =
        error.status === 413 ? 413 : error.status === 415 ? 415 : 400;
      response
        .status(status)
        .json({ statusCode: status, message: "pipedrive_payload_invalid" });
    },
  );
  app.useBodyParser("json", {
    limit: INBOUND_WEBHOOK_BODY_LIMIT,
    strict: false,
  } as { limit: string });
}
