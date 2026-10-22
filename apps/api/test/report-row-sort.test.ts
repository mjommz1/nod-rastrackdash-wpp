import { describe, expect, it } from "vitest";
import { sortReportRows } from "../src/reporting/report-row-sort";

type Row = {
  id: string;
  name: string;
  purchases?: number | null;
};

function row(id: string, name: string, purchases?: number | null): Row {
  return { id, name, purchases };
}

describe("sortReportRows", () => {
  const rows: Row[] = [
    row("r-nan", "Nan", Number.NaN),
    row("r-five", "Cinco", 5),
    row("r-inf", "Infinito", Number.POSITIVE_INFINITY),
    row("r-zero", "Zero", 0),
    row("r-null", "Nulo", null),
    row("r-neg-inf", "Menos infinito", Number.NEGATIVE_INFINITY),
    row("r-undefined", "Ausente", undefined),
    row("r-two", "Dois", 2),
  ];

  it("sorts finite values descending and keeps missing or nonfinite values last", () => {
    expect(
      sortReportRows(rows, { key: "purchases", direction: "desc" }).map(
        (item) => item.id,
      ),
    ).toEqual([
      "r-five",
      "r-two",
      "r-zero",
      // unavailable values: name ascending, then id
      "r-undefined",
      "r-inf",
      "r-neg-inf",
      "r-nan",
      "r-null",
    ]);
  });

  it("sorts finite values ascending and keeps missing or nonfinite values last", () => {
    expect(
      sortReportRows(rows, { key: "purchases", direction: "asc" }).map(
        (item) => item.id,
      ),
    ).toEqual([
      "r-zero",
      "r-two",
      "r-five",
      "r-undefined",
      "r-inf",
      "r-neg-inf",
      "r-nan",
      "r-null",
    ]);
  });

  it("breaks ties by name then id using locale-independent code unit order", () => {
    const tied = [
      row("b", "beta", 1),
      row("a2", "Beta", 1),
      row("a1", "Beta", 1),
      row("z", "alpha", 1),
    ];

    expect(
      sortReportRows(tied, { key: "purchases", direction: "desc" }).map(
        (item) => item.id,
      ),
    ).toEqual(["a1", "a2", "z", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [row("a", "A", 1), row("b", "B", 2)];

    sortReportRows(input, { key: "purchases", direction: "desc" });

    expect(input.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
