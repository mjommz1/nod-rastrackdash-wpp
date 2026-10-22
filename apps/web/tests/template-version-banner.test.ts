import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const requestState = vi.hoisted(() => ({ pathname: "/backoffice" as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ toString: () => "wpptrack_session=fixture" }),
  headers: async () =>
    new Headers(
      requestState.pathname
        ? { "x-wpptrack-pathname": requestState.pathname }
        : {},
    ),
}));

import { BackofficeStatusBanners } from "../src/components/backoffice-status-banners";
import {
  TemplateVersionBanner,
  TemplateVersionStatus,
} from "../src/components/template-version-banner";
import {
  getTemplateVersionBannerData,
  normalizeTemplateVersion,
} from "../src/lib/template-version";
import { TEMPLATE_UPDATE_GUIDE_URL } from "../src/lib/template-version-format";

const DEPLOYED = "0123456789abcdef0123456789abcdef01234567";
const LATEST = "fedcba9876543210fedcba9876543210fedcba98";
const GUIDE = TEMPLATE_UPDATE_GUIDE_URL;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function session(platformRole: string | null, id = "owner-1") {
  return {
    user: { id, email: "owner@example.test", platformRole },
    activeWorkspaceId: null,
    workspaces: [],
    supportContext: null,
  };
}

function version(overrides: Record<string, unknown> = {}) {
  return {
    deployedSha: DEPLOYED,
    latestMainSha: LATEST,
    status: "behind",
    updateGuideUrl: GUIDE,
    ...overrides,
  };
}

/** Routes fetch by path fragment and records every URL that was requested. */
function mockApi(routes: Record<string, () => Promise<Response>>): string[] {
  const calls: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    calls.push(url);
    const match = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((path) => url.includes(path));

    if (!match) {
      throw new Error(`unexpected fetch: ${url}`);
    }

    return routes[match]!();
  });

  return calls;
}

async function render(element: unknown): Promise<string> {
  return renderToStaticMarkup(createElement("div", null, element as never));
}

/** Streams the tree to completion so nested async server components resolve. */
async function renderAsyncTree(element: unknown): Promise<string> {
  const stream = await renderToReadableStream(
    createElement("div", null, element as never),
  );
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<!-- -->/g, "");
}

afterEach(() => {
  vi.restoreAllMocks();
  requestState.pathname = "/backoffice";
});

describe("normalizeTemplateVersion", () => {
  it("keeps a behind answer only when both SHAs are real and differ", () => {
    expect(normalizeTemplateVersion(version())).toEqual({
      status: "behind",
      deployedSha: DEPLOYED,
      latestMainSha: LATEST,
    });
  });

  it("keeps a current answer only when the SHAs match", () => {
    expect(
      normalizeTemplateVersion(
        version({ status: "current", latestMainSha: DEPLOYED }),
      ),
    ).toEqual({ status: "current", deployedSha: DEPLOYED });
    expect(
      normalizeTemplateVersion(version({ status: "current" })),
    ).toMatchObject({ status: "unknown", deployedSha: DEPLOYED });
  });

  it("maps a missing or invalid deployed SHA to unknown without inventing one", () => {
    for (const deployedSha of [null, "abc1234", "not-a-sha", DEPLOYED.toUpperCase()]) {
      expect(
        normalizeTemplateVersion(version({ deployedSha, status: "behind" })),
      ).toEqual({
        status: "unknown",
        deployedSha: null,
        reason: "missing_deployed_sha",
      });
    }
  });

  it("maps a behind answer without a latest SHA to unknown", () => {
    expect(
      normalizeTemplateVersion(version({ latestMainSha: null })),
    ).toEqual({ status: "unknown", deployedSha: DEPLOYED, reason: "unavailable" });
  });

  it("maps malformed bodies to unknown/unavailable", () => {
    for (const raw of [
      undefined,
      null,
      "behind",
      [],
      { status: "behind" },
      version({ status: "outdated" }),
      version({ updateGuideUrl: "not a url" }),
      version({ extra: true }),
    ]) {
      expect(normalizeTemplateVersion(raw)).toEqual({
        status: "unknown",
        deployedSha: null,
        reason: "unavailable",
      });
    }
  });
});

describe("TemplateVersionBanner authorization", () => {
  it("never fetches the template version for a workspace client (no platform role)", async () => {
    const calls = mockApi({
      "/auth/me": async () => jsonResponse(session(null)),
      "/backoffice/template-version": async () => jsonResponse(version()),
    });

    expect(await render(await TemplateVersionBanner())).toBe("<div></div>");
    expect(calls.some((url) => url.includes("/backoffice/template-version"))).toBe(false);
  });

  it("never fetches the template version for a platform operator", async () => {
    const calls = mockApi({
      "/auth/me": async () => jsonResponse(session("platform_operator")),
      "/backoffice/template-version": async () => jsonResponse(version()),
    });

    expect(await getTemplateVersionBannerData()).toBeNull();
    expect(calls.some((url) => url.includes("/backoffice/template-version"))).toBe(false);
  });

  it("renders nothing and skips the endpoint when the session is gone", async () => {
    for (const status of [401, 403]) {
      vi.restoreAllMocks();
      const calls = mockApi({
        "/auth/me": async () => jsonResponse({ message: "Sessão expirada" }, status),
        "/backoffice/template-version": async () => jsonResponse(version()),
      });

      expect(await render(await TemplateVersionBanner())).toBe("<div></div>");
      expect(calls.some((url) => url.includes("/backoffice/template-version"))).toBe(false);
    }
  });

  it("renders nothing when the owner endpoint itself answers 401/403", async () => {
    for (const status of [401, 403]) {
      vi.restoreAllMocks();
      mockApi({
        "/auth/me": async () => jsonResponse(session("platform_owner")),
        "/backoffice/template-version": async () =>
          jsonResponse({ message: "Acesso negado" }, status),
      });

      expect(await render(await TemplateVersionBanner())).toBe("<div></div>");
    }
  });

  it("fetches the version for the platform owner with the session cookie", async () => {
    const calls = mockApi({
      "/auth/me": async () => jsonResponse(session("platform_owner")),
      "/backoffice/template-version": async () =>
        jsonResponse(version({ status: "current", latestMainSha: DEPLOYED })),
    });

    expect(await getTemplateVersionBannerData()).toEqual({
      userId: "owner-1",
      version: { status: "current", deployedSha: DEPLOYED },
    });
    expect(calls.filter((url) => url.includes("/backoffice/template-version"))).toHaveLength(1);
    const versionCall = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([url]) => String(url).includes("/backoffice/template-version"));
    expect((versionCall?.[1]?.headers as Record<string, string>).Cookie).toBe(
      "wpptrack_session=fixture",
    );
    expect(calls.every((url) => !url.includes("github.com"))).toBe(true);
  });
});

describe("TemplateVersionBanner states", () => {
  it("current: shows the installed short SHA with no update warning", async () => {
    mockApi({
      "/auth/me": async () => jsonResponse(session("platform_owner")),
      "/backoffice/template-version": async () =>
        jsonResponse(version({ status: "current", latestMainSha: DEPLOYED })),
    });

    const html = await render(await TemplateVersionBanner());

    expect(html).toContain("Versão instalada");
    expect(html).toContain("<code>0123456</code>");
    expect(html).not.toContain(DEPLOYED);
    expect(html).not.toContain("atualização disponível");
    expect(html).not.toContain("Não foi possível");
  });

  it("behind: server markup is empty so the dismissible notice hydrates without mismatch", async () => {
    mockApi({
      "/auth/me": async () => jsonResponse(session("platform_owner")),
      "/backoffice/template-version": async () => jsonResponse(version()),
    });

    const data = await getTemplateVersionBannerData();
    expect(data?.version.status).toBe("behind");
    expect(await render(await TemplateVersionBanner())).toBe("<div></div>");
  });

  it("unknown (no build identity): explains the missing commit without claiming the instance is current", async () => {
    mockApi({
      "/auth/me": async () => jsonResponse(session("platform_owner")),
      "/backoffice/template-version": async () =>
        jsonResponse(version({ deployedSha: null, status: "unknown" })),
    });

    const html = await render(await TemplateVersionBanner());

    expect(html).toContain("Não foi possível verificar atualizações");
    expect(html).toContain("não conseguiu confirmar o commit instalado");
    // The commit is detected automatically; never send students to a build arg.
    expect(html).not.toContain("GIT_SHA");
    expect(html).toContain("não significa que ela esteja atualizada");
    expect(html).not.toContain("Versão instalada <code>");
    expect(html).toContain(`href="${GUIDE}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("unknown (upstream unavailable): keeps a valid installed SHA visible", async () => {
    mockApi({
      "/auth/me": async () => jsonResponse(session("platform_owner")),
      "/backoffice/template-version": async () =>
        jsonResponse(version({ latestMainSha: null, status: "unknown" })),
    });

    const html = await render(await TemplateVersionBanner());

    expect(html).toContain("Não foi possível verificar atualizações");
    expect(html).toContain("<code>0123456</code>");
    expect(html).not.toContain("GIT_SHA");
  });

  it("maps network failures to unknown", async () => {
    mockApi({
      "/auth/me": async () => jsonResponse(session("platform_owner")),
      "/backoffice/template-version": async () => {
        throw new TypeError("fetch failed: ECONNREFUSED 10.0.0.5:3333");
      },
    });

    const html = await render(await TemplateVersionBanner());

    expect(html).toContain("Não foi possível verificar atualizações");
    expect(html).not.toContain("ECONNREFUSED");
  });

  it("maps API errors to unknown without echoing the backend message", async () => {
    mockApi({
      "/auth/me": async () => jsonResponse(session("platform_owner")),
      "/backoffice/template-version": async () =>
        jsonResponse({ message: "GitHub token internal-detail exploded" }, 500),
    });

    const html = await render(await TemplateVersionBanner());

    expect(html).toContain("Não foi possível verificar atualizações");
    expect(html).not.toContain("internal-detail");
  });

  it("maps a malformed 200 body to unknown", async () => {
    mockApi({
      "/auth/me": async () => jsonResponse(session("platform_owner")),
      "/backoffice/template-version": async () =>
        new Response("<html>proxy error</html>", { status: 200 }),
    });

    const html = await render(await TemplateVersionBanner());

    expect(html).toContain("Não foi possível verificar atualizações");
    expect(html).not.toContain("proxy error");
  });

  it("never renders a guide link supplied by the API", async () => {
    const html = await render(
      createElement(TemplateVersionStatus, {
        userId: "owner-1",
        version: normalizeTemplateVersion(
          version({
            deployedSha: null,
            status: "unknown",
            updateGuideUrl: "https://evil.example/phish",
          }),
        ),
      }),
    );

    expect(html).not.toContain("evil.example");
    expect(html).toContain(`href="${GUIDE}"`);
  });
});

describe("BackofficeStatusBanners", () => {
  const graceLicense = {
    status: "grace",
    softLock: true,
    hardLock: false,
    usable: true,
    expiresAt: null,
    validUntil: null,
    source: "cache",
  };

  it("stacks the existing license banner above the version banner once each", async () => {
    mockApi({
      "/license-client/status": async () => jsonResponse(graceLicense),
      "/auth/me": async () => jsonResponse(session("platform_owner")),
      "/backoffice/template-version": async () =>
        jsonResponse(version({ deployedSha: null, status: "unknown" })),
    });

    const html = await renderAsyncTree(await BackofficeStatusBanners());

    expect(html).toContain('class="backoffice-status-banners"');
    expect(html.match(/período de tolerância<\/strong>/g)).toHaveLength(1);
    expect(html.match(/Não foi possível verificar atualizações/g)).toHaveLength(1);
    expect(html.indexOf("período de tolerância")).toBeLessThan(
      html.indexOf("Não foi possível verificar atualizações"),
    );
  });

  it("keeps the license banner for non-owners without fetching the version", async () => {
    const calls = mockApi({
      "/license-client/status": async () => jsonResponse(graceLicense),
      "/auth/me": async () => jsonResponse(session(null)),
    });

    const html = await renderAsyncTree(await BackofficeStatusBanners());

    expect(html).toContain("período de tolerância");
    expect(html).not.toContain("atualizações");
    expect(calls.some((url) => url.includes("/backoffice/template-version"))).toBe(false);
  });

  it("skips the license banner on the license page, which already explains the lock", async () => {
    requestState.pathname = "/backoffice/license";
    const calls = mockApi({
      "/auth/me": async () => jsonResponse(session("platform_owner")),
      "/backoffice/template-version": async () =>
        jsonResponse(version({ status: "current", latestMainSha: DEPLOYED })),
    });

    const html = await renderAsyncTree(await BackofficeStatusBanners());

    expect(html).toContain("Versão instalada");
    expect(calls.some((url) => url.includes("/license-client/status"))).toBe(false);
  });
});

describe("template version banner mount points", () => {
  const srcRoot = join(process.cwd(), "src");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory()
        ? sourceFiles(path)
        : /\.tsx?$/.test(entry)
          ? [path]
          : [];
    });
  }

  function importers(moduleName: string): string[] {
    return sourceFiles(srcRoot)
      .filter((file) =>
        readFileSync(file, "utf8").includes(`/${moduleName}"`),
      )
      .map((file) => relative(srcRoot, file));
  }

  it("is only reachable from the backoffice layout, never the workspace product", () => {
    expect(importers("template-version-banner")).toEqual([
      "components/backoffice-status-banners.tsx",
    ]);
    expect(importers("backoffice-status-banners")).toEqual([
      "app/(backoffice)/layout.tsx",
    ]);

    const productLayout = readFileSync(
      join(srcRoot, "app/(app)/layout.tsx"),
      "utf8",
    );
    expect(productLayout).toContain("<LicenseStatusBanner />");
    expect(productLayout).not.toMatch(/TemplateVersion|BackofficeStatusBanners/);
  });

  it("mounts the status region before the page content in the backoffice layout", () => {
    const layout = readFileSync(
      join(srcRoot, "app/(backoffice)/layout.tsx"),
      "utf8",
    );

    expect(layout.indexOf("<BackofficeStatusBanners />")).toBeGreaterThan(-1);
    expect(layout.indexOf("<BackofficeStatusBanners />")).toBeLessThan(
      layout.indexOf("{children}"),
    );
  });
});
