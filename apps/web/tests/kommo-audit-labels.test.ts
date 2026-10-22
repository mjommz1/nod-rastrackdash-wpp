import { describe, expect, it } from "vitest";
import {
  auditStateLabels,
  describeAuditErrorCode,
  describeAuditResult,
  summarizeAuditEvent,
} from "../src/app/(app)/settings/kommo-audit-labels";
import type {
  KommoEventDto,
  KommoEventResultDto,
} from "../src/app/(app)/integrations/kommo-actions";

function result(overrides: Partial<KommoEventResultDto> = {}): KommoEventResultDto {
  return {
    ruleId: "rule_1",
    eventName: "QualifiedLead",
    status: "observed",
    errorCode: null,
    publicationStatus: null,
    publicationErrorCode: null,
    publicationErrorMessage: null,
    senderStatus: null,
    ...overrides,
  };
}

function event(overrides: Partial<KommoEventDto> = {}): KommoEventDto {
  return {
    id: "event_1",
    dealId: "9001",
    pipelineId: "pipeline_1",
    statusId: "status_1",
    status: "observed",
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    results: [result()],
    ...overrides,
  };
}

function stage(summary: ReturnType<typeof summarizeAuditEvent>, key: string) {
  const found = summary.stages.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`missing stage ${key}`);
  return found;
}

describe("summarizeAuditEvent", () => {
  it("an observed event is received+processed but never materialized/queued/sent", () => {
    const summary = summarizeAuditEvent(event());
    expect(stage(summary, "received").state).toBe("yes");
    expect(stage(summary, "processed").state).toBe("yes");
    expect(stage(summary, "matched").state).toBe("yes");
    expect(stage(summary, "materialized").state).toBe("no");
    expect(stage(summary, "queued").state).toBe("no");
    expect(stage(summary, "confirmedSent")).toMatchObject({
      state: "no",
      note: "Nada foi enviado.",
    });
    expect(summary.detail).toContain("nada foi criado nem enviado");
    expect(summary.auditOnly).toBe(false);
  });

  it("a materialized event is not 'sent'", () => {
    const summary = summarizeAuditEvent(
      event({
        status: "materialized",
        results: [result({ status: "materialized" })],
      }),
    );
    expect(stage(summary, "materialized").state).toBe("yes");
    expect(stage(summary, "queued").state).toBe("no");
    expect(stage(summary, "confirmedSent").state).toBe("pending");
    expect(summary.detail).toContain("Ainda não confirmada como enviada");
  });

  it("queued is not confirmed sent", () => {
    const summary = summarizeAuditEvent(
      event({
        status: "queued",
        results: [result({ status: "materialized", publicationStatus: "queued" })],
      }),
    );
    expect(stage(summary, "queued").state).toBe("yes");
    expect(stage(summary, "confirmedSent").state).toBe("pending");
    expect(summary.headline).toBe("Na fila de envio (envio não confirmado)");
  });

  it("only a sent status confirms the send", () => {
    const summary = summarizeAuditEvent(
      event({
        status: "sent",
        results: [
          result({ status: "materialized", publicationStatus: "sent", senderStatus: "sent" }),
        ],
      }),
    );
    expect(stage(summary, "confirmedSent").state).toBe("yes");
    expect(summary.tone).toBe("positive");
  });

  it("delivery-unknown is shown honestly and never as sent, even if the event says sent", () => {
    const summary = summarizeAuditEvent(
      event({
        status: "sent",
        errorCode: "kommo_delivery_unknown",
        results: [
          result({
            publicationStatus: "delivery_unknown",
            publicationErrorCode: "kommo_delivery_unknown",
          }),
        ],
      }),
    );
    expect(summary.deliveryUnknown).toBe(true);
    expect(stage(summary, "confirmedSent")).toMatchObject({ state: "unknown" });
    expect(summary.headline).toBe("Entrega desconhecida (reenvio bloqueado)");
    expect(summary.detail).toContain("Não afirmamos que foi enviado");
    expect(summary.tone).toBe("danger");
  });

  it("an unmatched lead is audit-only and no CTWA is presumed", () => {
    for (const code of [
      "workspace_lead_not_found",
      "lead_channel_or_attribution_unproven",
      "lead_channel_route_ambiguous",
      "phone_ambiguous",
      "contact_missing",
    ]) {
      const summary = summarizeAuditEvent(
        event({ status: "blocked", errorCode: code, results: [] }),
      );
      expect(summary.auditOnly).toBe(true);
      expect(stage(summary, "matched").state).toBe("no");
      expect(stage(summary, "materialized").state).toBe("no");
      expect(stage(summary, "confirmedSent").state).toBe("no");
    }
    expect(describeAuditErrorCode("lead_channel_or_attribution_unproven")).toContain(
      "Nenhum clique de anúncio (CTWA) foi presumido",
    );
  });

  it("an unmatched lead reported only in a rule result is also audit-only", () => {
    const summary = summarizeAuditEvent(
      event({
        status: "blocked",
        results: [result({ status: "blocked", errorCode: "lead_channel_route_unauthorized" })],
      }),
    );
    expect(summary.auditOnly).toBe(true);
  });

  it("stage_not_configured is audit-only with no match", () => {
    const summary = summarizeAuditEvent(
      event({ status: "blocked", errorCode: "stage_not_configured", results: [] }),
    );
    expect(summary.auditOnly).toBe(true);
    expect(stage(summary, "matched")).toMatchObject({
      state: "no",
      note: "Nenhuma regra ativa para este estágio.",
    });
  });

  it("an accepted/processing event keeps later stages pending, not failed", () => {
    for (const status of ["accepted", "processing"]) {
      const summary = summarizeAuditEvent(event({ status, results: [] }));
      expect(stage(summary, "received").state).toBe("yes");
      expect(stage(summary, "processed").state).toBe("pending");
      expect(stage(summary, "matched").state).toBe("pending");
      expect(stage(summary, "materialized").state).toBe("pending");
    }
  });

  it("failed/dead mean the processing did not finish; unknown statuses stay unknown", () => {
    expect(stage(summarizeAuditEvent(event({ status: "failed", results: [] })), "processed").state).toBe(
      "no",
    );
    expect(stage(summarizeAuditEvent(event({ status: "dead", results: [] })), "processed").state).toBe(
      "no",
    );
    const odd = summarizeAuditEvent(event({ status: "something_new", results: [] }));
    expect(stage(odd, "processed").state).toBe("unknown");
    expect(odd.headline).toBe("Status não reconhecido (something_new)");
  });

  it("a not-evaluated event (blocked connection) leaves 'matched' unknown", () => {
    const summary = summarizeAuditEvent(
      event({ status: "blocked", errorCode: "connection_blocked", results: [] }),
    );
    expect(stage(summary, "matched").state).toBe("unknown");
    expect(summary.auditOnly).toBe(false);
  });

  it("never invents timestamps or counters in the stage notes", () => {
    const summary = summarizeAuditEvent(event());
    const text = JSON.stringify(summary);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("describeAuditResult / describeAuditErrorCode", () => {
  it("describes observation as no-send", () => {
    expect(describeAuditResult(result()).text).toContain("nada foi criado nem enviado");
  });

  it("distinguishes queued from sent", () => {
    expect(describeAuditResult(result({ publicationStatus: "queued" })).text).toContain(
      "Envio ainda não confirmado",
    );
    expect(describeAuditResult(result({ publicationStatus: "sent" })).text).toBe(
      "Envio confirmado ao Meta.",
    );
  });

  it("delivery_unknown never says sent", () => {
    const described = describeAuditResult(
      result({ publicationStatus: "delivery_unknown" }),
    );
    expect(described.tone).toBe("danger");
    expect(described.text).toContain("Não é possível afirmar que foi enviado");
  });

  it("falls back to a technical-code string without echoing free text", () => {
    expect(describeAuditErrorCode("brand_new_code")).toBe("Código técnico: brand_new_code");
    expect(describeAuditErrorCode(null)).toBeNull();
  });

  it("exposes plain state labels", () => {
    expect(auditStateLabels).toEqual({
      yes: "Sim",
      no: "Não",
      pending: "Pendente",
      unknown: "Desconhecido",
    });
  });
});
