import { describe, expect, it } from "vitest";
import {
  kommoDeliveryKey,
  parseKommoFormBody,
  parseKommoStageEvents,
} from "../src/kommo/kommo-webhook.parser";

describe("Kommo webhook parser", () => {
  it("processes every form status item and preserves webhook-time stage/value", () => {
    const body = parseKommoFormBody(
      Buffer.from(
        "account[id]=account-1&account[subdomain]=clinic&leads[status][0][id]=deal-a&leads[status][0][pipeline_id]=p-a&leads[status][0][status_id]=142&leads[status][0][old_status_id]=1&leads[status][0][updated_at]=1735689600&leads[status][0][price]=12.34&leads[status][1][id]=deal-b&leads[status][1][pipeline_id]=p-b&leads[status][1][status_id]=142&leads[status][1][updated_at]=1735689601&leads[status][1][price_with_minor_units]=456",
      ),
    );
    const events = parseKommoStageEvents(body);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "account-1",
          dealId: "deal-a",
          pipelineId: "p-a",
          statusId: "142",
          oldStatusId: "1",
          priceCents: 1234,
          pricePresent: true,
        }),
        expect.objectContaining({
          dealId: "deal-b",
          pipelineId: "p-b",
          statusId: "142",
          priceCents: 456,
          pricePresent: true,
        }),
      ]),
    );
    expect(kommoDeliveryKey("connection-a", events![0]!)).not.toBe(
      kommoDeliveryKey("connection-a", events![1]!),
    );
  });
  it("fails closed for malformed brackets, duplicate leaves and invalid event price", () => {
    expect(
      parseKommoFormBody(
        Buffer.from("leads[status][0][id]=a&leads[status][0][id]=b"),
      ),
    ).toBeNull();
    expect(
      parseKommoStageEvents({
        account: { id: "a" },
        leads: {
          status: {
            0: {
              id: "d",
              pipeline_id: "p",
              status_id: "s",
              updated_at: "10",
              price: "1.234",
            },
          },
        },
      }),
    ).toBeNull();
  });
  it("rejects prototype paths before auth while allowing deep unused custom fields and array status input", () => {
    expect(
      parseKommoFormBody(Buffer.from("account[id]=a&__proto__[polluted]=yes")),
    ).toBeNull();
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
    const body = parseKommoFormBody(
      Buffer.from(
        "account[id]=a&leads[status][0][id]=d&leads[status][0][pipeline_id]=p&leads[status][0][status_id]=s&leads[status][0][updated_at]=10&leads[status][0][custom_fields][99][values][0][value]=ignored",
      ),
    );
    expect(parseKommoStageEvents(body)).toHaveLength(1);
    expect(
      parseKommoStageEvents({
        account: { id: "a" },
        leads: {
          status: [
            { id: "d", pipeline_id: "p", status_id: "s", updated_at: "10" },
          ],
        },
      }),
    ).toHaveLength(1);
    expect(
      parseKommoStageEvents({
        account: { id: "a" },
        leads: {
          status: {
            0: {
              id: "d",
              pipeline_id: "p",
              status_id: "s",
              updated_at: "10",
              custom_fields: { constructor: { x: 1 } },
            },
          },
        },
      }),
    ).toBeNull();
  });
});

import { decodeKommoBody } from "../src/kommo/kommo-webhook.parser";
it("decodes bounded raw JSON by validated content type with before/after prototype checks", () => {
  const payload = JSON.stringify({
    account: { id: "synthetic" },
    leads: {
      status: [
        {
          id: "d",
          pipeline_id: "p",
          status_id: "142",
          updated_at: 1791201600,
          custom_fields: [{ values: [{ value: "safe" }] }],
        },
      ],
    },
  });
  expect(
    parseKommoStageEvents(
      decodeKommoBody(Buffer.from(payload), "application/json; charset=utf-8"),
    ),
  ).toHaveLength(1);
  expect(decodeKommoBody(Buffer.from(payload), "text/plain")).toBeNull();
  expect(
    decodeKommoBody(
      Buffer.from(payload.replace('"safe"', '{"constr\\u0075ctor":{}}')),
      "application/json",
    ),
  ).toBeNull();
  expect(
    decodeKommoBody(
      Buffer.from(JSON.stringify({ unused: Array(5001).fill(0) })),
      "application/json",
    ),
  ).toBeNull();
  expect(
    decodeKommoBody(
      Buffer.from("[".repeat(10000) + "0" + "]".repeat(10000)),
      "application/json",
    ),
  ).toBeNull();
  expect(
    decodeKommoBody(Buffer.alloc(256 * 1024 + 1), "application/json"),
  ).toBeNull();
  expect(({} as any).polluted).toBeUndefined();
});
