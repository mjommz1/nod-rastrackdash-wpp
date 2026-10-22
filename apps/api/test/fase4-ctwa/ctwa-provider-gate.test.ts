import { describe, expect, it, vi } from "vitest";
import { InboundWebhookProvider } from "@prisma/client";
import { ctwaDestinationProviderValue } from "../../src/inbound-webhooks/authorized-ctwa-destination";
import { resolveCtwaLeadProof } from "../../src/conversion-rules/ctwa-lead-proof";

// Fase 4.0 shipped the page/pixel path closed until the Unnichat provider value
// existed. Fase 4b adds it: the path is now reachable, and ctwa_clid stays
// mandatory (no click, no proof, nothing is sent).
describe("CTWA page/pixel entries with the Unnichat provider (Fase 4b)", () => {
  it("exposes the Unnichat provider value to the CTWA destination path", () => {
    expect(Object.values(InboundWebhookProvider)).toContain("unnichat");
    expect(ctwaDestinationProviderValue()).toBe("unnichat");
  });

  it("never accepts an entry proof without ctwa_clid", async () => {
    const client = {
      conversionEventLog: { findMany: vi.fn() },
      inboundWebhookEvent: { findFirst: vi.fn() },
    };
    for (const ctwaClid of [null, "", "   "]) {
      expect(
        await resolveCtwaLeadProof(client as never, {
          workspaceId: "ws1",
          leadId: "lead1",
          phoneHash: "h",
          ctwaClid: ctwaClid as string,
        }),
      ).toBeNull();
    }
    expect(client.conversionEventLog.findMany).not.toHaveBeenCalled();
    expect(client.inboundWebhookEvent.findFirst).not.toHaveBeenCalled();
  });
});
