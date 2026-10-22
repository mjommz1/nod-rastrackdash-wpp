// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipedriveEventDto } from "../src/app/(app)/integrations/pipedrive-actions";
import {
  eventWith,
  productionRuleWith,
  resultWith,
  revisionedConnectionWith,
} from "./support/pipedrive-fixtures";
import { formValues, renderPanel, sentForm } from "./support/pipedrive-panel-harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => cleanup());

const retryLabel = /Reprocessar evento de/;
const confirmLabel = "Reprocessar evento";

function openEvents() {
  const details = screen.getByText("Eventos recebidos", { selector: "summary span" }).closest("details")!;
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

const transientFailure = (overrides: Partial<PipedriveEventDto> = {}) =>
  eventWith({ id: "event_1", status: "failed", errorCode: "pipedrive_timeout", ...overrides });

function setup(initial: PipedriveEventDto[]) {
  const state = { events: initial };
  const listEventsAction = vi.fn(async (_w: string, _c: string) => ({
    ok: true as const,
    events: state.events,
  }));
  const retryEventAction = vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" }));
  const view = renderPanel({
    connections: [revisionedConnectionWith({ rules: [productionRuleWith({ id: "rule_1" })] })],
    listEventsAction,
    retryEventAction,
  });
  return { ...view, state, listEventsAction, retryEventAction };
}

async function openAndConfirm(ctx: ReturnType<typeof setup>) {
  openEvents();
  fireEvent.click(await screen.findByRole("button", { name: retryLabel }));
  await screen.findByRole("button", { name: confirmLabel });
}

async function refresh(ctx: ReturnType<typeof setup>) {
  const before = ctx.listEventsAction.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: /Atualizar eventos/ }));
  await waitFor(() => expect(ctx.listEventsAction.mock.calls.length).toBe(before + 1));
  await waitFor(() => expect(screen.queryByText("Carregando eventos...")).toBeNull());
}

describe("stale confirmation is invalidated when the event stops being eligible", () => {
  it.each([
    ["delivery_unknown"],
    ["unrecognized"],
  ] as const)("refresh to %s clears the confirmation and never calls retry", async (deliveryStatus) => {
    const ctx = setup([transientFailure()]);
    await openAndConfirm(ctx);

    ctx.state.events = [
      transientFailure({
        results: [
          resultWith({
            status: "materialized",
            conversionEventLogId: "log_1",
            deliveryStatus,
          }),
        ],
      }),
    ];
    await refresh(ctx);

    expect(screen.queryByRole("button", { name: confirmLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: retryLabel })).toBeNull();
    expect(ctx.retryEventAction).not.toHaveBeenCalled();
  });

  it("an in-flight refresh disables the open confirmation so it cannot fire on stale state", async () => {
    const ctx = setup([transientFailure()]);
    await openAndConfirm(ctx);

    let release!: (value: { ok: true; events: PipedriveEventDto[] }) => void;
    ctx.listEventsAction.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve as typeof release; }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Atualizar eventos/ }));
    await screen.findByText("Carregando eventos...");

    const stale = screen.queryByRole("button", { name: confirmLabel }) as HTMLButtonElement | null;
    if (stale) fireEvent.click(stale);
    expect(ctx.retryEventAction).not.toHaveBeenCalled();

    await act(async () => {
      release({
        ok: true,
        events: [
          transientFailure({
            results: [resultWith({ status: "materialized", conversionEventLogId: "log_1", deliveryStatus: "delivery_unknown" })],
          }),
        ],
      });
    });
    await waitFor(() => expect(screen.queryByText("Carregando eventos...")).toBeNull());
    expect(screen.queryByRole("button", { name: confirmLabel })).toBeNull();
    expect(ctx.retryEventAction).not.toHaveBeenCalled();
  });

  it("losing permission clears the confirmation and regaining it does not resurrect it", async () => {
    const ctx = setup([transientFailure()]);
    await openAndConfirm(ctx);

    ctx.rerenderWith({ canManage: false });
    expect(screen.queryByRole("button", { name: confirmLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: retryLabel })).toBeNull();

    ctx.rerenderWith({ canManage: true });
    expect(screen.queryByRole("button", { name: confirmLabel })).toBeNull();
    expect(await screen.findByRole("button", { name: retryLabel })).toBeTruthy();
    expect(ctx.retryEventAction).not.toHaveBeenCalled();
  });

  it("an event removed from the refreshed list clears the confirmation for good", async () => {
    const ctx = setup([transientFailure()]);
    await openAndConfirm(ctx);

    ctx.state.events = [eventWith({ id: "event_other" })];
    await refresh(ctx);
    expect(screen.queryByRole("button", { name: confirmLabel })).toBeNull();

    ctx.state.events = [transientFailure()];
    await refresh(ctx);
    expect(screen.queryByRole("button", { name: confirmLabel })).toBeNull();
    expect(screen.getByRole("button", { name: retryLabel })).toBeTruthy();
    expect(ctx.retryEventAction).not.toHaveBeenCalled();
  });

  it("control: a still-eligible event keeps the confirmation and retries the current event", async () => {
    const ctx = setup([transientFailure()]);
    await openAndConfirm(ctx);
    await refresh(ctx);
    fireEvent.click(await screen.findByRole("button", { name: confirmLabel }));
    await waitFor(() => expect(ctx.retryEventAction).toHaveBeenCalledTimes(1));
    expect(formValues(sentForm(ctx.retryEventAction)).eventId).toBe("event_1");
  });
});

describe("no event reprocessing once canonical materialization evidence exists", () => {
  const lifecycle = [
    "publication_pending",
    "queued",
    "sent",
    "revoked",
    "publication_failed",
    "delivery_unknown",
    "materialized",
    "unrecognized",
  ] as const;

  it.each(lifecycle)("a transient failure with deliveryStatus %s offers no Retry", async (deliveryStatus) => {
    const ctx = setup([
      transientFailure({
        results: [
          resultWith({
            status: "materialized",
            conversionEventLogId: "log_1",
            deliveryStatus,
          }),
        ],
      }),
    ]);
    openEvents();
    await screen.findByText(/Falhou/);
    expect(screen.queryByRole("button", { name: retryLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: confirmLabel })).toBeNull();
    expect(ctx.retryEventAction).not.toHaveBeenCalled();
  });

  it.each(lifecycle)("deliveryStatus %s alone (no id, non-materialized result status) offers no Retry", async (deliveryStatus) => {
    setup([transientFailure({ results: [resultWith({ status: "ignored", deliveryStatus })] })]);
    openEvents();
    await screen.findByText(/Falhou/);
    expect(screen.queryByRole("button", { name: retryLabel })).toBeNull();
  });

  it("result.status materialized alone offers no Retry", async () => {
    setup([transientFailure({ results: [resultWith({ status: "materialized" })] })]);
    openEvents();
    await screen.findByText(/Falhou/);
    expect(screen.queryByRole("button", { name: retryLabel })).toBeNull();
  });

  it("conversionEventLogId alone (all other fields null) is independent proof and offers no Retry", async () => {
    setup([
      transientFailure({
        results: [resultWith({ status: "ignored", conversionEventLogId: "log_only" })],
      }),
    ]);
    openEvents();
    await screen.findByText(/Falhou/);
    expect(screen.queryByRole("button", { name: retryLabel })).toBeNull();
  });

  it("one materialized result among several blocks the whole event", async () => {
    setup([
      transientFailure({
        results: [
          resultWith({ ruleId: "rule_a", status: "ignored", errorCode: "pipedrive_timeout" }),
          resultWith({ ruleId: "rule_b", status: "ignored", conversionEventLogId: "log_b" }),
        ],
      }),
    ]);
    openEvents();
    await screen.findByText(/Falhou/);
    expect(screen.queryByRole("button", { name: retryLabel })).toBeNull();
  });

  it("explains the block without the blanket 'cannot be reprocessed' text", async () => {
    setup([
      transientFailure({
        results: [resultWith({ status: "materialized", conversionEventLogId: "log_1", deliveryStatus: "queued" })],
      }),
    ]);
    openEvents();
    await screen.findByText(/Falhou/);
    expect(screen.getByText(/já tem conversão registrada/)).toBeTruthy();
    expect(screen.queryByText(/Esta falha não pode ser reprocessada/)).toBeNull();
  });

  it("controls: pre-materialization transient failures stay retryable", async () => {
    setup([
      transientFailure({ id: "e_empty" }),
      transientFailure({
        id: "e_ignored",
        results: [resultWith({ status: "ignored", errorCode: "pipedrive_timeout" })],
      }),
      transientFailure({
        id: "e_failed",
        results: [resultWith({ status: "observed", errorCode: "pipedrive_transport" })],
      }),
    ]);
    openEvents();
    expect((await screen.findAllByRole("button", { name: retryLabel })).length).toBe(3);
  });

  it("a stale confirmation cannot retry after the event gains materialization evidence", async () => {
    const ctx = setup([transientFailure()]);
    await openAndConfirm(ctx);

    ctx.state.events = [
      transientFailure({
        results: [resultWith({ status: "materialized", conversionEventLogId: "log_1", deliveryStatus: "queued" })],
      }),
    ];
    await refresh(ctx);

    expect(screen.queryByRole("button", { name: confirmLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: retryLabel })).toBeNull();
    expect(ctx.retryEventAction).not.toHaveBeenCalled();
  });
});
