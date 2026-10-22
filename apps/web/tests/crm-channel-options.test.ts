import type { InboundWebhookChannelDto } from "@wpptrack/shared";
import {
  kommoChannelBindingMessages,
  pipedriveChannelBindingMessages,
} from "@wpptrack/shared";
import { describe, expect, it } from "vitest";
import {
  crmChannelOptionsFor,
  crmInheritsVerifiedDestination,
} from "../src/lib/crm-channel-options";
import { eligibleChannel } from "./support/pipedrive-fixtures";

function channel(patch: Record<string, unknown> = {}): InboundWebhookChannelDto {
  return {
    ...eligibleChannel,
    ...patch,
    readiness: {
      ...eligibleChannel.readiness,
      ...((patch.readiness as object) ?? {}),
    },
  } as InboundWebhookChannelDto;
}

const noRoutes = { routes: [], readiness: { routeCount: 0, validRouteCount: 0 } };

describe("CRM channel options (Kommo and Pipedrive)", () => {
  it("lists each valid route of an active, production number and preselects the first", () => {
    const options = crmChannelOptionsFor([channel()], kommoChannelBindingMessages);

    expect(options.map((option) => option.routeId)).toEqual(["route_1", "route_2"]);
    expect(options.every((option) => option.eligible && option.reason === null)).toBe(true);
    expect(options.map((option) => option.preselect)).toEqual([true, false]);
    expect(options[0]!.label).toBe("Comercial");
  });

  it("labels a number without a name by its phone", () => {
    const [option] = crmChannelOptionsFor(
      [channel({ channelName: null })],
      pipedriveChannelBindingMessages,
    );
    expect(option!.label).toBe("+5511999990000");
  });

  it("authorizes a number by its channel id when it inherits the verified workspace destination", () => {
    const inheriting = channel({
      ...noRoutes,
      id: "channel_inherit",
      readiness: {
        ...noRoutes.readiness,
        crmDestinationReadiness: {
          status: "verified",
          reason: "verified_workspace_destination",
        },
      },
    });

    expect(crmInheritsVerifiedDestination(inheriting)).toBe(true);
    expect(crmChannelOptionsFor([inheriting], kommoChannelBindingMessages)).toEqual([
      expect.objectContaining({
        routeId: "channel_inherit",
        eligible: true,
        reason: null,
        preselect: true,
        statusDetail: "destino herdado verificado",
      }),
    ]);
  });

  it("explains a number whose Meta destination is not verified, with the same fixed message for both CRMs", () => {
    const unverified = channel({ ...noRoutes, id: "channel_unverified" });
    const [kommo] = crmChannelOptionsFor([unverified], kommoChannelBindingMessages);
    const [pipedrive] = crmChannelOptionsFor([unverified], pipedriveChannelBindingMessages);

    expect(crmInheritsVerifiedDestination(unverified)).toBe(false);
    expect(kommo).toMatchObject({
      routeId: "channel_unverified",
      eligible: false,
      preselect: false,
      reason: "Este número ainda não tem destino Meta verificado (pixel e página).",
    });
    expect(pipedrive!.reason).toBe(kommo!.reason);
  });

  it("blocks a paused number and names the CRM in the message", () => {
    const paused = channel({ status: "paused" });
    const [kommo] = crmChannelOptionsFor([paused], kommoChannelBindingMessages);
    const [pipedrive] = crmChannelOptionsFor([paused], pipedriveChannelBindingMessages);

    expect(kommo!.eligible).toBe(false);
    expect(kommo!.reason).toMatch(/autorizá-lo no Kommo/);
    expect(pipedrive!.reason).toMatch(/autorizá-lo no Pipedrive/);
    expect(kommo!.preselect).toBe(false);
  });

  it("blocks a paused connection or channel flagged by the readiness blockers", () => {
    for (const blocker of ["channel_paused", "connection_paused"]) {
      const [option] = crmChannelOptionsFor(
        [channel({ readiness: { blockers: [blocker] } })],
        kommoChannelBindingMessages,
      );
      expect(option!.reason).toMatch(/Número de WhatsApp pausado/);
    }
  });

  it("blocks a number that is not activated for production", () => {
    const [option] = crmChannelOptionsFor(
      [channel({ productionActivatedAt: null })],
      pipedriveChannelBindingMessages,
    );
    expect(option).toMatchObject({
      eligible: false,
      reason: "Este número de WhatsApp ainda não está ativado para envio de conversões.",
    });
  });

  it("marks an invalid or inactive route as unavailable without hiding it", () => {
    const options = crmChannelOptionsFor(
      [
        channel({
          routes: [
            { ...eligibleChannel.routes[0]!, validationStatus: "invalid" },
            { ...eligibleChannel.routes[1]!, active: false },
          ],
        }),
      ],
      kommoChannelBindingMessages,
    );

    expect(options).toHaveLength(2);
    expect(options.every((option) => !option.eligible)).toBe(true);
    expect(options[0]!.statusDetail).toBe("invalid");
    expect(options[1]!.statusDetail).toBe("valid, rota inativa");
  });

  it("lists the numbers of every provider side by side", () => {
    const options = crmChannelOptionsFor(
      [
        channel(),
        channel({
          id: "channel_umbler",
          channelName: "Umbler",
          routes: [{ ...eligibleChannel.routes[0]!, id: "route_umbler" }],
        }),
      ],
      kommoChannelBindingMessages,
    );
    expect(options.map((option) => option.routeId)).toEqual([
      "route_1",
      "route_2",
      "route_umbler",
    ]);
  });
});
