import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { MetaConnectionResolverService } from "../../src/integrations/meta/meta-connection-resolver.service";
import { Module } from "@nestjs/common";
import { vi } from "vitest";
import { ConversionEventsQueueService } from "../../src/common/queue/conversion-events-queue.service";
import { Global } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { RUNTIME_ENV, RUNTIME_FETCH } from "../../src/common/runtime/runtime.module";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";

/** Mutable license decision of the offline license module (default: active). */
export const offlineLicense = {
  locked: false,
  getLockState: vi.fn(async () => ({
    inert: false,
    locked: offlineLicense.locked,
    reason: offlineLicense.locked ? ("revoked" as const) : null,
    state: { status: offlineLicense.locked ? "revoked" : "active" },
  })),
};

/**
 * Student edition license boundary without the heartbeat queue/worker: the
 * real global soft-lock guard (HTTP 423 on writes) reading a synthetic
 * decision, plus the runtime env the conversion sender reads.
 */
@Global()
@Module({
  providers: [
    { provide: LicenseClientService, useValue: offlineLicense },
    { provide: APP_GUARD, useClass: LicenseSoftlockGuard },
    { provide: RUNTIME_ENV, useValue: process.env },
    { provide: RUNTIME_FETCH, useValue: fetch },
  ],
  exports: [LicenseClientService, RUNTIME_ENV, RUNTIME_FETCH],
})
export class OfflinePipedriveLicenseModule {}

/** Replaces only Redis handoff; production module/controllers/services stay real. */
@Module({
  providers: [
    { provide: ConversionEventsQueueService, useValue: { retrySend: vi.fn() } },
  ],
  exports: [ConversionEventsQueueService],
})
export class OfflinePipedriveQueueModule {}

/** Credential/route boundaries without the broad integrations module's workers. */
@Module({
  providers: [
    { provide: MetaTokenEncryptionService, useValue: {} },
    {
      provide: MetaConnectionResolverService,
      useValue: { hasNormalizedConnections: vi.fn(async () => false) },
    },
  ],
  exports: [MetaTokenEncryptionService, MetaConnectionResolverService],
})
export class OfflinePipedriveIntegrationsModule {}

/** Real Node HTTP streams and Nest/Express; no socket binding or TLS claim. */
export async function dispatch(
  app: any,
  method: string,
  path: string,
  body: Buffer = Buffer.alloc(0),
  headers: Record<string, string> = {},
) {
  const chunks: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  const req = new IncomingMessage(socket as any);
  req.method = method;
  req.url = path;
  req.headers = {
    "content-type": "application/json",
    "content-length": String(body.length),
    ...headers,
  };
  req.httpVersion = "1.1";
  const res = new ServerResponse(req);
  res.assignSocket(socket as any);
  const completed = new Promise<void>((ok, fail) => {
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            "dispatch stalled " +
              method +
              " " +
              path.split("?")[0] +
              " flags:" +
              JSON.stringify({
                status: res.statusCode,
                finished: res.finished,
                headers: res.headersSent,
                chunks: chunks.length,
                reqEnded: req.readableEnded,
              }),
          ),
        ),
      1000,
    );
    res.once("finish", () => {
      clearTimeout(timer);
      ok();
    });
    res.once("error", fail);
  });
  app.getHttpAdapter().getInstance()(req, res);
  req.complete = true;
  req.push(body);
  req.push(null);
  await completed;
  const raw = Buffer.concat(chunks).toString();
  const responseBody = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  return {
    status: res.statusCode,
    headers: res.getHeaders(),
    body: responseBody ? JSON.parse(responseBody) : null,
  };
}
