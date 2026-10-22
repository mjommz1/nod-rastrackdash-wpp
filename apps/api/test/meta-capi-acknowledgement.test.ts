import { describe, expect, it, vi } from "vitest";
import { MetaCapiAdapter } from "../src/conversion-events/meta-capi.adapter";

const input = {
  accessToken: "synthetic-token",
  pixelId: "synthetic-pixel",
  pageId: "synthetic-page",
  eventName: "LeadSubmitted" as const,
  dedupeKey: "synthetic-event",
  phoneHash: "a".repeat(64),
  adId: "synthetic-ad",
  ctwaClid: "synthetic-click",
};
describe("global CAPI acknowledgement contract", () => {
  it.each([
    "{}",
    "{",
    "",
    JSON.stringify({ error: { message: "synthetic private details" } }),
  ])("keeps non-2xx rejection explicit regardless of body %s", async (body) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(body, { status: 400 }),
    );
    const result = await new MetaCapiAdapter({}, fetcher).sendEvent(input);
    expect(result).toMatchObject({
      status: "error",
      errorCode: "MetaCapiRejected",
      responseSummary: { httpStatus: 400 },
    });
    expect(result.deliveryOutcome).toBeUndefined();
    expect(JSON.stringify(result.responseSummary)).not.toContain(
      "private details",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("accepts typed warning messages without persisting their text or unrecognized fields", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            events_received: 1,
            messages: ["synthetic provider warning"],
            fbtrace_id: "synthetic",
            extra: "synthetic private details",
          }),
          { status: 200 },
        ),
    );
    const result = await new MetaCapiAdapter({}, fetcher).sendEvent(input);
    expect(result).toMatchObject({
      status: "sent",
      errorCode: null,
      responseSummary: { events_received: 1, messageCount: 1 },
    });
    expect(JSON.stringify(result.responseSummary)).not.toContain("synthetic");
  });
});
