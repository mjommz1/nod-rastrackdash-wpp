import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../src/common/prisma/prisma.service";
import {
  PipedriveAdapter,
  type PipedriveTransport,
} from "../src/pipedrive/pipedrive.adapter";
import { PipedriveService } from "../src/pipedrive/pipedrive.service";
import {
  actor,
  createInput,
  pipedriveHarness,
} from "./support/pipedrive-harness";

beforeEach(() =>
  vi.stubEnv(
    "PIPEDRIVE_CRM_ENCRYPTION_KEY",
    Buffer.alloc(32, 7).toString("base64"),
  ),
);
afterEach(() => vi.unstubAllEnvs());

function transported() {
  const h = pipedriveHarness();
  const responseConfig = { status: 200, invalid: false, catalogStatus: 200 };
  const request = vi.fn(
    (
      url: URL,
      options: RequestOptions,
      callback: (res: IncomingMessage) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        end: () =>
          queueMicrotask(() => {
            const isAccount = url.pathname === "/api/v1/users/me";
            const body = responseConfig.invalid
              ? { private: createInput.apiToken }
              : isAccount
                ? {
                    success: true,
                    data: { company_id: 1, company_domain: "synthetic" },
                  }
                : {
                    success: true,
                    data:
                      url.pathname === "/api/v2/pipelines"
                        ? [
                            { id: 2, name: "Empty", order_nr: 2 },
                            { id: 1, name: "Sales", order_nr: 1 },
                          ]
                        : [
                            {
                              id: 11,
                              name: "Qualified",
                              order_nr: 1,
                              pipeline_id: 1,
                            },
                          ],
                    additional_data: { next_cursor: null },
                  };
            const res = Object.assign(new EventEmitter(), {
              statusCode: isAccount
                ? responseConfig.status
                : responseConfig.catalogStatus,
            });
            callback(res as IncomingMessage);
            res.emit("data", Buffer.from(JSON.stringify(body)));
            res.emit("end");
          }),
        destroy: () => req,
      });
      return req as unknown as ClientRequest;
    },
  );
  const transport = {
    lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    request,
    now: Date.now,
  } as unknown as PipedriveTransport;
  const service = new PipedriveService(
    h.client as PrismaService,
    new PipedriveAdapter(transport),
  );
  return { ...h, service, transport, request, responseConfig };
}

describe("Pipedrive service with the real adapter and injected synthetic transport", () => {
  it("joins pipelines/stages from provider pages and uses the sealed credential on refresh", async () => {
    const h = transported();
    const result = await h.service.create("workspace-a", actor, createInput);
    expect(result.pipelines).toEqual([
      {
        id: "1",
        name: "Sales",
        sort: 1,
        stages: [{ id: "11", name: "Qualified", sort: 1 }],
      },
      { id: "2", name: "Empty", sort: 2, stages: [] },
    ]);
    expect(h.request).toHaveBeenCalledTimes(4);
    for (const [url, options] of h.request.mock.calls) {
      expect(url.origin).toBe(createInput.accountOrigin);
      expect(url.toString()).not.toContain(createInput.apiToken);
      expect(options.headers).toMatchObject({
        "x-api-token": createInput.apiToken,
      });
    }
    expect(JSON.stringify(result)).not.toContain(createInput.apiToken);
  });
  it.each([
    [401, "pipedrive_unauthorized"],
    [403, "pipedrive_unauthorized"],
    [429, "pipedrive_rate_limited"],
  ])(
    "sanitizes upstream HTTP %s at the service boundary",
    async (status, code) => {
      const h = transported();
      h.responseConfig.status = Number(status);
      h.responseConfig.invalid = true;
      await expect(
        h.service.create("workspace-a", actor, createInput),
      ).rejects.toMatchObject({ status: 502, message: code });
      expect(h.state.pipedriveConnection).toHaveLength(0);
      expect(h.state.auditLog).toHaveLength(0);
    },
  );
  it("rejects invalid provider data without exposing its private body", async () => {
    const h = transported();
    h.responseConfig.invalid = true;
    await expect(
      h.service.create("workspace-a", actor, createInput),
    ).rejects.toMatchObject({
      status: 502,
      message: "pipedrive_invalid_response",
    });
    expect(h.state.pipedriveConnection).toHaveLength(0);
  });
  it("retains a verified connection for retry when its initial catalog is rate limited", async () => {
    const h = transported();
    h.responseConfig.catalogStatus = 429;
    await expect(
      h.service.create("workspace-a", actor, createInput),
    ).rejects.toMatchObject({ status: 502, message: "pipedrive_rate_limited" });
    const rows = await h.service.list("workspace-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      catalogState: "error",
      verifiedAccountId: "1",
      credentialHealthy: true,
      lastErrorCode: "pipedrive_rate_limited",
    });
    h.responseConfig.catalogStatus = 200;
    expect(
      (await h.service.refreshCatalog("workspace-a", rows[0]!.id)).pipelines,
    ).toHaveLength(2);
  });
});
