import { afterEach, describe, expect, it, vi } from "vitest";

const { revalidatePath, serverApiFetch, FakeApiRequestError } = vi.hoisted(
  () => {
    class FakeApiRequestError extends Error {
      constructor(
        message: string,
        readonly status: number,
      ) {
        super(message);
      }
    }

    return {
      revalidatePath: vi.fn(),
      serverApiFetch: vi.fn(),
      FakeApiRequestError,
    };
  },
);

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", () => ({
  serverApiFetch,
  isApiRequestError: (error: unknown) => error instanceof FakeApiRequestError,
}));

import {
  completeMetaPalmupConnectAction,
  startMetaPalmupConnectAction,
} from "../src/app/(app)/integrations/meta-manual-actions";

const pairingId = "p".repeat(43);
const challenge = "c".repeat(43);
const authorizeUrl = `https://wpptrack-api.rastrack.app/integrations/meta/student-connect/start?pairingId=${pairingId}&challenge=${challenge}`;
const leakedToken = "EAAB-palmup-secret-token-should-never-leave-the-api";

const discovery = {
  credential: {
    id: "credential_palmup",
    workspaceId: "workspace_1",
    source: "manual",
    label: "Login social PalmUP",
    fingerprint: "1234567890abcdef",
    tokenLast4: "oken",
    tokenType: "bearer",
    scopes: ["ads_read", "business_management"],
    expiresAt: null,
    status: "active",
    lastValidatedAt: "2026-10-10T12:00:00.000Z",
    validationError: null,
    rotatedAt: null,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
  },
  businesses: [{ id: "business_1", name: "BM Cliente", verificationStatus: null }],
  selectedBusinessId: "business_1",
  adAccounts: [],
  pixels: [],
  pages: [],
};

afterEach(() => {
  revalidatePath.mockReset();
  serverApiFetch.mockReset();
});

describe("PalmUP Meta social login actions", () => {
  it("starts the pairing and returns only the pairing id and authorize URL", async () => {
    serverApiFetch.mockResolvedValueOnce({ pairingId, challenge, authorizeUrl });

    const result = await startMetaPalmupConnectAction();

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/meta/manual/palmup-connect/start",
      { method: "POST", body: "{}" },
    );
    expect(result.ok).toBe(true);
    expect(result.palmupPairing).toEqual({ pairingId, authorizeUrl });
    expect(Object.keys(result.palmupPairing ?? {})).not.toContain("challenge");
  });

  it("refuses an authorize URL that is not HTTPS", async () => {
    serverApiFetch.mockResolvedValueOnce({
      pairingId,
      challenge,
      authorizeUrl: "javascript:alert(1)",
    });

    const result = await startMetaPalmupConnectAction();

    expect(result.ok).toBe(false);
    expect(result.palmupPairing).toBeUndefined();
  });

  it("reports an unconfigured broker honestly when the API answers 503", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new FakeApiRequestError("Login social PalmUP nao configurado", 503),
    );

    const result = await startMetaPalmupConnectAction();

    expect(result).toMatchObject({ ok: false, palmupUnconfigured: true });
    expect(result.message).toContain("nao configurado");
  });

  it("completes with the pairing id only and never forwards a token to the browser", async () => {
    serverApiFetch.mockResolvedValueOnce({
      ...discovery,
      accessToken: leakedToken,
      credential: { ...discovery.credential, accessToken: leakedToken },
    });

    const result = await completeMetaPalmupConnectAction(pairingId);

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/meta/manual/palmup-connect/complete",
      { method: "POST", body: JSON.stringify({ pairingId }) },
    );
    expect(result.ok).toBe(true);
    expect(result.discovery?.credential.id).toBe("credential_palmup");
    expect(JSON.stringify(result)).not.toContain(leakedToken);
    expect(JSON.stringify(result)).not.toContain("accessToken");
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
  });

  it("surfaces the sanitized API message for an expired or reused pairing", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new FakeApiRequestError(
        "Conexao PalmUP expirada, invalida ou ja utilizada. Inicie novamente",
        400,
      ),
    );

    const result = await completeMetaPalmupConnectAction(pairingId);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Inicie novamente");
  });

  it("rejects a malformed pairing id without calling the API", async () => {
    const result = await completeMetaPalmupConnectAction("../../oops");

    expect(result.ok).toBe(false);
    expect(serverApiFetch).not.toHaveBeenCalled();
  });
});
