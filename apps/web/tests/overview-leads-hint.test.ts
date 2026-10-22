// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { OverviewLeadsHint } from "../src/app/(app)/overview/overview-leads-hint";

afterEach(() => {
  cleanup();
});

function renderHint() {
  return render(
    React.createElement(
      "div",
      null,
      React.createElement(OverviewLeadsHint, {
        id: "hint_returning",
        label: "Voltaram por anúncio",
        text: "Já eram leads antes do período e chamaram de novo por anúncio.",
      }),
      React.createElement("p", null, "fora"),
    ),
  );
}

describe("OverviewLeadsHint", () => {
  it("opens on tap and closes on a second tap (iOS never hovers or focuses)", () => {
    renderHint();
    const button = screen.getByRole("button", {
      name: "O que é: Voltaram por anúncio",
    });

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-describedby")).toBe("hint_returning");
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Já eram leads antes do período",
    );

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on a tap outside and on Escape", () => {
    renderHint();
    const button = screen.getByRole("button");

    fireEvent.click(button);
    fireEvent.pointerDown(screen.getByText("fora"));
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});
