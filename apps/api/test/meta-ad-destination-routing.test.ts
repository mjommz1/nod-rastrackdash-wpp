import { describe, expect, it, vi } from "vitest";
import { MetaAdDestinationRoutingService } from "../src/integrations/meta/meta-ad-destination-routing.service";

function routingHarness(input: {
  destinations: Array<{ id: string; pixelId: string; pageId: string }>;
  ads: Array<{
    adId: string;
    detectedPixelIds: string[];
    detectedPageIds: string[];
  }>;
  manualAdIds?: string[];
}) {
  const automaticAssignments: any[] = [];
  const transaction = {
    metaAdDestinationAssignment: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }) => {
        automaticAssignments.push(...data);
        return { count: data.length };
      }),
    },
  };
  const prisma = {
    metaReportingAccount: {
      findFirst: vi.fn(async () => ({
        adAccountId: "act-a",
        conversionDestinationId: null,
        businessConnection: { defaultConversionDestinationId: null },
        allowedDestinations: input.destinations.map((destination) => ({
          destination: { ...destination, status: "configured" },
        })),
      })),
    },
    metaConversionDestination: { findMany: vi.fn(async () => []) },
    metaAd: { findMany: vi.fn(async () => input.ads) },
    metaAdDestinationAssignment: {
      findMany: vi.fn(async () =>
        (input.manualAdIds ?? []).map((adId) => ({ adId })),
      ),
    },
    $transaction: vi.fn(async (callback) => callback(transaction)),
  };
  return {
    prisma,
    transaction,
    automaticAssignments,
    service: new MetaAdDestinationRoutingService(prisma as any),
  };
}

describe("MetaAdDestinationRoutingService", () => {
  it("writes automatic assignments for every non-manual ad when there is one configured destination", async () => {
    const h = routingHarness({
      destinations: [
        { id: "destination-a", pixelId: "pixel-a", pageId: "page-a" },
      ],
      ads: [
        { adId: "manual-ad", detectedPixelIds: [], detectedPageIds: [] },
        { adId: "automatic-ad", detectedPixelIds: [], detectedPageIds: [] },
      ],
      manualAdIds: ["manual-ad"],
    });

    await expect(
      h.service.reconcileReportingAccount({
        workspaceId: "workspace-a",
        reportingAccountId: "reporting-a",
      }),
    ).resolves.toEqual({
      examinedCount: 2,
      assignedCount: 1,
      unresolvedCount: 0,
      manualCount: 1,
    });
    expect(
      h.transaction.metaAdDestinationAssignment.deleteMany,
    ).toHaveBeenCalledWith({
      where: expect.objectContaining({ source: "automatic" }),
    });
    expect(h.automaticAssignments).toEqual([
      expect.objectContaining({
        adId: "automatic-ad",
        conversionDestinationId: "destination-a",
        source: "automatic",
      }),
    ]);
  });

  it.each([
    ["zero destinations", [], []],
    [
      "ambiguous destinations without a unique page or pixel match",
      [
        { id: "destination-a", pixelId: "pixel-a", pageId: "page-a" },
        { id: "destination-b", pixelId: "pixel-b", pageId: "page-b" },
      ],
      [{ adId: "ad-a", detectedPixelIds: [], detectedPageIds: [] }],
    ],
  ])("leaves %s unassigned", async (_name, destinations: any[], ads: any[]) => {
    const h = routingHarness({
      destinations,
      ads: ads.length
        ? ads
        : [{ adId: "ad-a", detectedPixelIds: [], detectedPageIds: [] }],
    });

    await expect(
      h.service.reconcileReportingAccount({
        workspaceId: "workspace-a",
        reportingAccountId: "reporting-a",
      }),
    ).resolves.toMatchObject({ assignedCount: 0, unresolvedCount: 1 });
    expect(h.automaticAssignments).toEqual([]);
  });
});
