import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverApiFetch } from "../src/lib/server-api";
import {
  authorizeInboundRecoveryAction,
  inboundRecoveryResultAction,
  previewInboundRecoveryAction,
} from "../src/app/(app)/integrations/inbound-recovery-actions";
vi.mock("../src/lib/server-api", () => ({ serverApiFetch: vi.fn() }));
const result = {
  batchId: "batch",
  selection: "canary_1",
  state: "pending",
  total: 1,
  delivered: 0,
  failed: 0,
  unknown: 0,
  pending: 1,
  items: [{ id: "item", state: "pending" }],
};
beforeEach(() => vi.resetAllMocks());
describe("recovery server actions", () => {
  it("calls preview/authorize/result in scoped paths with strict input and no supplied actor", async () => {
    const preview = {
      connectionId: "connection",
      channelId: "channel",
      eligible: 1,
      scanned: 1,
      scanLimit: 2500,
      batchLimit: 500,
      previewToken: "signed",
      expiresAt: null,
      unavailableReason: null,
      canSendRemaining: false,
      latestBatch: null,
    };
    vi.mocked(serverApiFetch)
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce(result);
    expect(await previewInboundRecoveryAction("connection", "channel")).toEqual(
      { ok: true, data: preview },
    );
    const input = {
      previewToken: "signed",
      confirmation: "Meta",
      selection: "canary_1",
    };
    expect(
      await authorizeInboundRecoveryAction("connection", "channel", input),
    ).toEqual({ ok: true, data: result });
    expect(
      await inboundRecoveryResultAction("connection", "channel", "batch"),
    ).toEqual({ ok: true, data: result });
    expect(serverApiFetch).toHaveBeenNthCalledWith(
      1,
      "/integrations/inbound-webhooks/connection/channels/channel/recovery/preview",
    );
    expect(serverApiFetch).toHaveBeenNthCalledWith(
      2,
      "/integrations/inbound-webhooks/connection/channels/channel/recovery/authorize",
      { method: "POST", body: JSON.stringify(input) },
    );
    expect(serverApiFetch).toHaveBeenNthCalledWith(
      3,
      "/integrations/inbound-webhooks/connection/channels/channel/recovery/batches/batch",
    );
  });
  it.each([
    { selection: "remaining", actor: "forged" },
    { selection: "canary_5" },
    { selection: "canary_1", workspaceId: "foreign" },
  ])("rejects invalid/forged input before calling API (%j)", async (extra) => {
    expect(
      await authorizeInboundRecoveryAction("connection", "channel", {
        previewToken: "signed",
        confirmation: "Meta",
        ...extra,
      }),
    ).toMatchObject({ ok: false });
    expect(serverApiFetch).not.toHaveBeenCalled();
  });
  it("encodes scoped identifiers and rejects missing/invalid responses without leaking API secrets", async () => {
    vi.mocked(serverApiFetch)
      .mockResolvedValueOnce({ unsafe: "not a result" })
      .mockRejectedValueOnce(new Error("private-token-fixture"));
    expect(await previewInboundRecoveryAction("c/1", "ch/1")).toMatchObject({
      ok: false,
    });
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/c%2F1/channels/ch%2F1/recovery/preview",
    );
    const response = await inboundRecoveryResultAction("c", "ch", "batch");
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response)).not.toContain("private-token");
    expect(await previewInboundRecoveryAction("", "channel")).toMatchObject({
      ok: false,
    });
    expect(serverApiFetch).toHaveBeenCalledTimes(2);
  });
  it("preserves safe actionable route-change errors", async () => {
    vi.mocked(serverApiFetch).mockRejectedValue(
      new Error("A conexao ou a rota mudou. Atualize a previa antes de enviar"),
    );
    expect(
      await authorizeInboundRecoveryAction("connection", "channel", {
        previewToken: "signed",
        confirmation: "Meta",
        selection: "canary_1",
      }),
    ).toEqual({
      ok: false,
      message: "A conexao ou a rota mudou. Atualize a previa antes de enviar",
    });
  });
});
