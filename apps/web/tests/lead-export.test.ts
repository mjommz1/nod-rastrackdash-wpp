// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { LeadExportMenu } from "../src/app/(app)/leads/lead-export-menu";
import {
  leadExportHref,
  type LeadFilterValues,
} from "../src/app/(app)/leads/lead-filter-params";
import { GET } from "../src/app/(app)/leads/export/route";

const empty: LeadFilterValues = {
  search: "",
  status: "",
  eventName: "",
  label: "",
  campaignId: "",
  adSetId: "",
  adId: "",
  attribution: "",
  since: "",
  until: "",
  base: "",
  pageSize: "25",
};

const applied: LeadFilterValues = {
  ...empty,
  search: "mari",
  status: "qualified",
  eventName: "QualifiedLead",
  attribution: "paid",
  label: "VIP",
  since: "2026-09-01",
  until: "2026-09-24",
  campaignId: "cmp_1",
  pageSize: "100",
};

describe("leadExportHref", () => {
  it("carries every applied filter but never the page size", () => {
    const params = new URL(`http://x${leadExportHref(applied, "xlsx")}`)
      .searchParams;

    expect(Object.fromEntries(params)).toEqual({
      search: "mari",
      status: "qualified",
      eventName: "QualifiedLead",
      label: "VIP",
      campaignId: "cmp_1",
      attribution: "paid",
      since: "2026-09-01",
      until: "2026-09-24",
      format: "xlsx",
    });
    expect(params.has("page")).toBe(false);
    expect(params.has("pageSize")).toBe(false);
  });

  it("exports the same base (novos or voltaram) the list shows", () => {
    expect(
      leadExportHref(
        {
          ...empty,
          attribution: "paid",
          since: "2026-10-14",
          base: "returning",
        },
        "csv",
      ),
    ).toBe(
      "/leads/export?attribution=paid&since=2026-10-14&base=returning&format=csv",
    );
  });

  it("exports everything when no filter is applied", () => {
    expect(leadExportHref(empty, "csv")).toBe("/leads/export?format=csv");
  });

  it("asks for hidden data only when the privacy toggle is on", () => {
    expect(leadExportHref(empty, "csv", true)).toBe(
      "/leads/export?format=csv&maskSensitive=1",
    );
  });
});

describe("LeadExportMenu", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    delete document.documentElement.dataset.presentationMode;
    URL.createObjectURL = vi.fn(() => "blob:leads");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("offers CSV and Excel and downloads the applied filters", async () => {
    let finish: (response: Response) => void = () => {};
    global.fetch = vi.fn(
      () => new Promise<Response>((resolve) => (finish = resolve)),
    ) as typeof fetch;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(createElement(LeadExportMenu, { applied }));
    fireEvent.click(screen.getByRole("button", { name: /Exportar/u }));

    expect(screen.getByRole("menuitem", { name: /Excel/u })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /CSV/u })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/u }));

    expect(global.fetch).toHaveBeenCalledWith(
      "/leads/export?search=mari&status=qualified&eventName=QualifiedLead&label=VIP&campaignId=cmp_1&attribution=paid&since=2026-09-01&until=2026-09-24&format=csv",
      expect.objectContaining({ credentials: "include" }),
    );
    // Loading state while the file is generated.
    const busy = screen.getByRole("button", { name: /Gerando planilha/u });
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      finish(
        new Response("Nome;Telefone\r\n", {
          status: 200,
          headers: {
            "Content-Disposition":
              'attachment; filename="leads_acme_2026-09-01_a_2026-09-24.csv"',
          },
        }),
      );
    });

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
      "leads_acme_2026-09-01_a_2026-09-24.csv",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Exportar/u })).toBeTruthy(),
    );
    expect(screen.getByRole("status").textContent).toBe("Planilha baixada.");
  });

  it("requests the Excel format and hidden data when 'Ocultar dados' is on", async () => {
    document.documentElement.dataset.presentationMode = "active";
    global.fetch = vi.fn(
      async () => new Response("x", { status: 200 }),
    ) as typeof fetch;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(createElement(LeadExportMenu, { applied: empty }));
    fireEvent.click(screen.getByRole("button", { name: /Exportar/u }));

    await waitFor(() =>
      expect(screen.getByText(/Ocultar dados/u)).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /Excel/u }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/leads/export?format=xlsx&maskSensitive=1",
        expect.anything(),
      ),
    );
  });

  it("shows the server's message when the export is refused", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: "Use um período menor e exporte de novo.",
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
    ) as typeof fetch;

    render(createElement(LeadExportMenu, { applied: empty }));
    fireEvent.click(screen.getByRole("button", { name: /Exportar/u }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/u }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toBe("Use um período menor e exporte de novo.");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to a plain message when the request fails", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network");
    }) as typeof fetch;

    render(createElement(LeadExportMenu, { applied: empty }));
    fireEvent.click(screen.getByRole("button", { name: /Exportar/u }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Excel/u }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Não foi possível gerar a planilha",
    );
  });
});

describe("leads export route", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("forwards the filters (not the page) and streams the file back", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response("Nome;Telefone\r\n", {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="leads_acme_todos.csv"',
          },
        }),
    ) as typeof fetch;

    const response = await GET(
      new Request(
        "http://localhost/leads/export?format=csv&search=mari&status=qualified&since=2026-09-01&page=4&pageSize=100&workspaceId=other",
      ),
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/leads/export?format=csv&search=mari&status=qualified&since=2026-09-01",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain(
      "leads_acme_todos.csv",
    );
    expect(await response.text()).toBe("Nome;Telefone\r\n");
  });

  it("forwards the base so the file follows the list", async () => {
    global.fetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as typeof fetch;

    await GET(
      new Request(
        "http://localhost/leads/export?format=csv&since=2026-10-14&base=returning",
      ),
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/leads/export?format=csv&since=2026-10-14&base=returning",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("passes the API's refusal message along", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Muitos leads" }), {
          status: 422,
        }),
    ) as typeof fetch;

    const response = await GET(
      new Request("http://localhost/leads/export?format=xlsx"),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ message: "Muitos leads" });
  });
});
