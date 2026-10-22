import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LicenseStatusBanner } from "../src/components/license-status-banner";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LicenseStatusBanner", () => {
  it("renders an amber tolerance banner when the license is in grace", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "grace",
        softLock: true,
        hardLock: false,
        usable: true,
        expiresAt: null,
        validUntil: null,
        source: "cache",
      }),
    );

    const element = await LicenseStatusBanner();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("período de tolerância");
    expect(html).toContain("feedback-banner license-banner warn");
  });

  it("renders a red persistent banner when the license is blocked", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "blocked",
        softLock: true,
        hardLock: true,
        usable: false,
        expiresAt: null,
        validUntil: null,
        source: "cache",
      }),
    );

    const element = await LicenseStatusBanner();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Licença bloqueada");
    expect(html).toContain("operações de escrita desativadas");
    expect(html).toContain("feedback-banner");
    expect(html).toContain("error");
  });

  it("renders a persistent banner linking to the license page when activation is required", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "unlicensed",
        softLock: true,
        hardLock: true,
        usable: false,
        expiresAt: null,
        validUntil: null,
        source: "cache",
        locked: true,
        lockReason: "license_required",
        interval: null,
      }),
    );

    const element = await LicenseStatusBanner();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Licença não ativada");
    expect(html).toContain("/backoffice/license");
    expect(html).toContain("feedback-banner");
    expect(html).toContain("error");
  });

  it("renders a banner pointing at the license envs when the activation attempt failed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "unlicensed",
        softLock: true,
        hardLock: true,
        usable: false,
        expiresAt: null,
        validUntil: null,
        source: "cache",
        locked: true,
        lockReason: "activation_failed",
        interval: null,
      }),
    );

    const element = await LicenseStatusBanner();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Falha ao ativar a licença");
    expect(html).toContain("LICENSE_KEY");
    expect(html).toContain("/backoffice/license");
  });

  it("renders nothing when the license is active", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "active",
        softLock: false,
        hardLock: false,
        usable: true,
        expiresAt: null,
        validUntil: null,
        source: "cache",
      }),
    );

    const element = await LicenseStatusBanner();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html.trim()).toBe("<div></div>");
  });

  it("renders nothing (dev-friendly) when licensing is inert — unlicensed but not locked", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "unlicensed",
        softLock: true,
        hardLock: true,
        usable: false,
        expiresAt: null,
        validUntil: null,
        source: "cache",
      }),
    );

    const element = await LicenseStatusBanner();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html.trim()).toBe("<div></div>");
  });

  it("fails open (renders nothing) when the status endpoint is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network unreachable"));

    const element = await LicenseStatusBanner();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html.trim()).toBe("<div></div>");
  });
});
