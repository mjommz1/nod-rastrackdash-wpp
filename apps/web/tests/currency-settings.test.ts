// @vitest-environment jsdom
import type {
  AdAccountCurrencyDto,
  AdAccountCurrencyListDto,
  WorkspaceCurrencySettingsDto,
} from "@wpptrack/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { revalidatePath, serverApiFetch } = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  serverApiFetch: vi.fn(),
}));

class ApiRequestErrorStub extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

class LicenseLockedErrorStub extends ApiRequestErrorStub {
  constructor() {
    super("Licença não utilizável", 423);
  }
}

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", () => ({
  serverApiFetch,
  isApiRequestError: (error: unknown) => error instanceof ApiRequestErrorStub,
  isLicenseLockedError: (error: unknown) =>
    error instanceof LicenseLockedErrorStub,
}));

import {
  saveAdAccountCurrencyAction,
  saveConversionCurrencyAction,
} from "../src/app/(app)/settings/currency-settings-actions";
import {
  conversionCurrencyChangeWarning,
  ConversionCurrencyForm,
} from "../src/app/(app)/settings/conversion-currency-form";
import {
  CurrencySettingsSection,
  metaCurrencyOptionLabel,
} from "../src/app/(app)/settings/currency-settings-section";
import { initialBackofficeActionState } from "../src/components/backoffice-action-form";
import {
  getAdAccountCurrencies,
  getWorkspaceCurrencySettings,
} from "../src/lib/currency-settings";
import { licenseLockedActionMessage } from "../src/lib/license-locked-message";

afterEach(() => {
  cleanup();
  revalidatePath.mockReset();
  serverApiFetch.mockReset();
});

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const settings: WorkspaceCurrencySettingsDto = {
  workspaceId: "workspace_1",
  conversionCurrency: "BRL",
  supportedCurrencies: ["BRL", "USD", "EUR"],
  canManage: true,
};

function account(
  patch: Partial<AdAccountCurrencyDto> = {},
): AdAccountCurrencyDto {
  return {
    id: "acc_1",
    adAccountId: "act_111",
    adAccountName: "Conta Brasil",
    businessId: "bm_1",
    businessName: "BM Principal",
    active: true,
    detectedCurrency: "BRL",
    detectedCurrencySupported: true,
    currencyOverride: null,
    effectiveCurrency: "BRL",
    ...patch,
  };
}

function accountList(
  accounts: AdAccountCurrencyDto[],
  canManage = true,
): AdAccountCurrencyListDto {
  return {
    accounts,
    currencies: [...new Set(accounts.map((item) => item.effectiveCurrency))],
    canManage,
  };
}

describe("loaders", () => {
  it("returns the settings and the ad accounts from the API", async () => {
    serverApiFetch.mockResolvedValueOnce(settings);
    expect(await getWorkspaceCurrencySettings()).toEqual(settings);
    expect(serverApiFetch).toHaveBeenLastCalledWith("/workspaces/current/currency");

    const list = accountList([account()]);
    serverApiFetch.mockResolvedValueOnce(list);
    expect(await getAdAccountCurrencies()).toEqual(list);
    expect(serverApiFetch).toHaveBeenLastCalledWith(
      "/workspaces/current/currency/ad-accounts",
    );
  });

  it("never blocks the page when the API fails or answers something else", async () => {
    serverApiFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await getWorkspaceCurrencySettings()).toBeNull();
    serverApiFetch.mockResolvedValueOnce({ unexpected: true });
    expect(await getWorkspaceCurrencySettings()).toBeNull();
    serverApiFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await getAdAccountCurrencies()).toBeNull();
    serverApiFetch.mockResolvedValueOnce({});
    expect(await getAdAccountCurrencies()).toBeNull();
  });
});

describe("Configurações > Moeda: actions", () => {
  it("saves the workspace currency and refreshes the screens that show money", async () => {
    serverApiFetch.mockResolvedValueOnce({});

    const result = await saveConversionCurrencyAction(
      initialBackofficeActionState,
      form({ conversionCurrency: "usd" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith("/workspaces/current/currency", {
      method: "PATCH",
      body: JSON.stringify({ conversionCurrency: "USD" }),
    });
    expect(result).toMatchObject({
      status: "success",
      message: "Moeda das conversões atualizada.",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
    expect(revalidatePath).toHaveBeenCalledWith("/conversions");
  });

  it("refuses a currency outside BRL/USD/EUR without calling the API", async () => {
    const result = await saveConversionCurrencyAction(
      initialBackofficeActionState,
      form({ conversionCurrency: "GBP" }),
    );

    expect(result).toMatchObject({
      status: "error",
      message: "Escolha Real, Dólar ou Euro.",
    });
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("shows the standard message when the license is locked (423)", async () => {
    serverApiFetch.mockRejectedValueOnce(new LicenseLockedErrorStub());

    const workspace = await saveConversionCurrencyAction(
      initialBackofficeActionState,
      form({ conversionCurrency: "EUR" }),
    );
    expect(workspace).toMatchObject({
      status: "error",
      message: licenseLockedActionMessage,
    });

    serverApiFetch.mockRejectedValueOnce(new LicenseLockedErrorStub());
    const adAccount = await saveAdAccountCurrencyAction(
      initialBackofficeActionState,
      form({ accountId: "acc_1", currencyOverride: "USD" }),
    );
    expect(adAccount).toMatchObject({
      status: "error",
      message: licenseLockedActionMessage,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("explains a refusal for who cannot manage the workspace (403)", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("Forbidden", 403));

    const result = await saveConversionCurrencyAction(
      initialBackofficeActionState,
      form({ conversionCurrency: "EUR" }),
    );

    expect(result).toMatchObject({
      status: "error",
      message: "Sem permissão para alterar a moeda deste workspace.",
    });
  });

  it("saves and removes the manual correction of an ad account", async () => {
    serverApiFetch.mockResolvedValue({});

    const fixed = await saveAdAccountCurrencyAction(
      initialBackofficeActionState,
      form({ accountId: "acc 1", currencyOverride: "EUR" }),
    );
    expect(serverApiFetch).toHaveBeenLastCalledWith(
      "/workspaces/current/currency/ad-accounts/acc%201",
      { method: "PATCH", body: JSON.stringify({ currencyOverride: "EUR" }) },
    );
    expect(fixed).toMatchObject({
      status: "success",
      message: "Conta corrigida para EUR.",
    });

    const removed = await saveAdAccountCurrencyAction(
      initialBackofficeActionState,
      form({ accountId: "acc_1", currencyOverride: "" }),
    );
    expect(serverApiFetch).toHaveBeenLastCalledWith(
      "/workspaces/current/currency/ad-accounts/acc_1",
      { method: "PATCH", body: JSON.stringify({ currencyOverride: null }) },
    );
    expect(removed).toMatchObject({
      status: "success",
      message: "Conta voltou a usar a moeda da Meta.",
    });
  });

  it("validates the ad account id and the chosen currency before calling the API", async () => {
    expect(
      await saveAdAccountCurrencyAction(
        initialBackofficeActionState,
        form({ accountId: "", currencyOverride: "USD" }),
      ),
    ).toMatchObject({ status: "error", message: "Conta de anúncio não identificada." });
    expect(
      await saveAdAccountCurrencyAction(
        initialBackofficeActionState,
        form({ accountId: "acc_1", currencyOverride: "JPY" }),
      ),
    ).toMatchObject({ status: "error", message: "Escolha Real, Dólar ou Euro." });
    expect(serverApiFetch).not.toHaveBeenCalled();
  });
});

describe("Configurações > Moeda: aviso antes de salvar", () => {
  it("says that the change only affects new conversions", () => {
    expect(conversionCurrencyChangeWarning("BRL", "USD")).toBe(
      "Trocar de BRL para USD afeta só as conversões novas. As já enviadas à Meta continuam em BRL, e regras com moeda própria não mudam.",
    );
    expect(conversionCurrencyChangeWarning("EUR", "EUR")).toContain(
      "afeta só as conversões novas",
    );
  });

  it("keeps save disabled until the currency changes and warns when it does", () => {
    render(
      createElement(ConversionCurrencyForm, {
        current: "BRL",
        supportedCurrencies: ["BRL", "USD", "EUR"],
      }),
    );

    const save = screen.getByRole("button", { name: "Salvar moeda" }) as HTMLButtonElement;
    const select = screen.getByLabelText("Moeda das conversões") as HTMLSelectElement;
    const note = () =>
      document.querySelector("[data-currency-warning]") as HTMLElement;

    expect(select.value).toBe("BRL");
    expect(save.disabled).toBe(true);
    expect(note().dataset.currencyWarning).toBe("idle");

    fireEvent.change(select, { target: { value: "USD" } });

    expect(save.disabled).toBe(false);
    expect(note().dataset.currencyWarning).toBe("changed");
    expect(note().textContent).toContain("Trocar de BRL para USD");
    expect(note().getAttribute("role")).toBe("alert");

    fireEvent.change(select, { target: { value: "BRL" } });
    expect(save.disabled).toBe(true);
  });

  it("lists only the currencies the API supports", () => {
    render(
      createElement(ConversionCurrencyForm, {
        current: "BRL",
        supportedCurrencies: ["BRL", "USD"],
      }),
    );

    const options = Array.from(
      (screen.getByLabelText("Moeda das conversões") as HTMLSelectElement).options,
    ).map((option) => option.value);
    expect(options).toEqual(["BRL", "USD"]);
  });
});

describe("Configurações > Moeda: tela", () => {
  function renderSection(
    props: Partial<{
      settings: WorkspaceCurrencySettingsDto | null;
      accounts: AdAccountCurrencyListDto | null;
    }> = {},
  ) {
    return render(
      createElement(CurrencySettingsSection, {
        settings,
        accounts: accountList([account()]),
        sectionNumber: "04",
        ...props,
      }),
    );
  }

  it("lets owner and admin change the currency and fix each ad account", () => {
    renderSection({
      accounts: accountList([
        account(),
        account({
          id: "acc_2",
          adAccountId: "act_222",
          adAccountName: "Conta Global",
          detectedCurrency: "USD",
          currencyOverride: "EUR",
          effectiveCurrency: "EUR",
        }),
      ]),
    });

    expect(screen.getByRole("heading", { name: "Moeda" })).toBeTruthy();
    expect(screen.getByText("Conversões em BRL")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Salvar moeda" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Salvar" })).toHaveLength(2);

    const rows = screen.getAllByRole("row").slice(1);
    const second = within(rows[1]!);
    expect(second.getByText("Conta Global")).toBeTruthy();
    expect(second.getByText("corrigida")).toBeTruthy();
    const override = second.getByLabelText(
      "Moeda da conta Conta Global",
    ) as HTMLSelectElement;
    expect(override.value).toBe("EUR");
    expect(
      within(override).getByRole("option", { name: "Usar a da Meta (USD)" }),
    ).toBeTruthy();
    expect(Array.from(override.options).map((option) => option.value)).toEqual([
      "",
      "BRL",
      "USD",
      "EUR",
    ]);
  });

  it("is read-only for a member", () => {
    renderSection({
      settings: { ...settings, canManage: false, conversionCurrency: "USD" },
      accounts: accountList(
        [account({ currencyOverride: "USD", effectiveCurrency: "USD" })],
        false,
      ),
    });

    expect(screen.getByText("Dólar (USD)")).toBeTruthy();
    expect(screen.getByText("Somente o dono ou o admin altera a moeda.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Salvar moeda" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    expect(screen.getByText("Corrigida para USD")).toBeTruthy();
  });

  it("warns about a Meta currency outside BRL/USD/EUR and about missing data", () => {
    renderSection({
      accounts: accountList([
        account({
          detectedCurrency: "GBP",
          detectedCurrencySupported: false,
        }),
        account({
          id: "acc_3",
          adAccountId: "act_333",
          adAccountName: "Sem moeda",
          detectedCurrency: null,
          detectedCurrencySupported: false,
        }),
      ]),
    });

    expect(screen.getByText("Moeda da Meta não suportada")).toBeTruthy();
    expect(screen.getByText(/1 conta usa/)).toBeTruthy();
    expect(screen.getByText("Não suportada")).toBeTruthy();
    expect(screen.getByText("Não informada")).toBeTruthy();
    expect(
      metaCurrencyOptionLabel(
        account({ detectedCurrency: "GBP", detectedCurrencySupported: false }),
      ),
    ).toBe("Usar a da Meta (GBP não suportada: BRL)");
    expect(
      metaCurrencyOptionLabel(account({ detectedCurrency: null })),
    ).toBe("Usar a da Meta (não informada: BRL)");
  });

  it("degrades with a plain message when the API is unavailable or has no accounts", () => {
    const { unmount } = renderSection({ settings: null, accounts: null });
    expect(screen.getByText("Indisponível")).toBeTruthy();
    expect(screen.getByText("Não foi possível carregar a moeda das conversões.")).toBeTruthy();
    expect(screen.getByText("Não foi possível carregar as contas de anúncio.")).toBeTruthy();
    unmount();

    renderSection({ accounts: accountList([]) });
    expect(
      screen.getByText("Nenhuma conta de anúncio conectada. Conecte a Meta em Integrações."),
    ).toBeTruthy();
  });
});
