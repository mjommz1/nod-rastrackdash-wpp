// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdAccountFilter } from "../src/components/ad-account-filter";
import {
  parseAdAccountIdsParam,
  setAdAccountParams,
} from "../src/lib/ad-account-params";

afterEach(cleanup);

const accounts = [
  { adAccountId: "act_1", adAccountName: "Conta Real", currency: "BRL" },
  { adAccountId: "act_2", adAccountName: "Conta Dolar", currency: "USD" },
  { adAccountId: "act_3", adAccountName: "Conta Euro", currency: "EUR" },
];

function Harness({ applied = [] as string[] }: { applied?: string[] }) {
  const [value, setValue] = useState<string[]>(applied);

  return createElement(
    "form",
    { "aria-label": "filtros" },
    createElement(AdAccountFilter, {
      accounts,
      appliedValue: applied,
      onChange: setValue,
      value,
    }),
  );
}

function hiddenField(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>(
    'input[type="hidden"][name^="adAccountId"]',
  )!;
}

describe("AdAccountFilter", () => {
  it("começa em 'Todas as contas' e mostra a moeda de cada conta", () => {
    const { container } = render(createElement(Harness));

    expect(screen.getByText("Todas as contas")).toBeTruthy();
    expect(hiddenField(container).name).toBe("adAccountId");
    expect(hiddenField(container).value).toBe("");
    expect(screen.getByText("USD")).toBeTruthy();
    expect(screen.getByText("EUR")).toBeTruthy();
  });

  it("uma conta vira adAccountId e duas ou mais viram adAccountIds", () => {
    const { container } = render(createElement(Harness));

    fireEvent.click(screen.getByLabelText(/Conta Real/));
    expect(hiddenField(container).name).toBe("adAccountId");
    expect(hiddenField(container).value).toBe("act_1");

    fireEvent.click(screen.getByLabelText(/Conta Dolar/));
    expect(hiddenField(container).name).toBe("adAccountIds");
    expect(hiddenField(container).value).toBe("act_1,act_2");
    expect(screen.getByText("2 contas")).toBeTruthy();

    fireEvent.click(screen.getByText("Limpar"));
    expect(hiddenField(container).value).toBe("");
  });

  it("'Pronto' aplica o formulário sozinho quando a seleção mudou", () => {
    const { container } = render(createElement(Harness));
    const form = container.querySelector("form")!;
    const submit = vi.fn();

    form.requestSubmit = submit;
    container.querySelector("details")!.open = true;
    fireEvent.click(screen.getByLabelText(/Conta Euro/));
    fireEvent.click(screen.getByText("Pronto"));

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("'Pronto' sem mudar a seleção não reaplica", () => {
    const { container } = render(
      createElement(Harness, { applied: ["act_1"] }),
    );
    const form = container.querySelector("form")!;
    const submit = vi.fn();

    form.requestSubmit = submit;
    container.querySelector("details")!.open = true;
    fireEvent.click(screen.getByText("Pronto"));

    expect(submit).not.toHaveBeenCalled();
  });
});

describe("ad-account-params", () => {
  it("lê adAccountId e adAccountIds juntos, sem repetir", () => {
    expect(parseAdAccountIdsParam("act_1", "act_1,act_2")).toEqual([
      "act_1",
      "act_2",
    ]);
    expect(parseAdAccountIdsParam(undefined, undefined)).toEqual([]);
    expect(parseAdAccountIdsParam("act_1,act_2")).toEqual(["act_1", "act_2"]);
  });

  it("escreve na URL no formato canônico", () => {
    expect(setAdAccountParams(new URLSearchParams(), []).toString()).toBe("");
    expect(
      setAdAccountParams(new URLSearchParams(), ["act_1"]).toString(),
    ).toBe("adAccountId=act_1");
    expect(
      setAdAccountParams(new URLSearchParams("adAccountId=x"), [
        "act_1",
        "act_2",
      ]).toString(),
    ).toBe("adAccountIds=act_1%2Cact_2");
  });
});
