import { describe, expect, it } from "vitest";
import {
  clientNavVisibleForPermissions,
  type WorkspacePermissionsDto,
} from "../src";

function permissions(
  overrides: Partial<WorkspacePermissionsDto> = {},
): WorkspacePermissionsDto {
  return {
    canInviteMembers: false,
    canManageMembers: false,
    canGrantMemberManager: false,
    canManageBilling: false,
    canManageIntegrations: false,
    canManageWorkspaceSettings: false,
    canTransferOwnership: false,
    canViewReports: true,
    canExportReports: true,
    ...overrides,
  };
}

describe("clientNavVisibleForPermissions", () => {
  it("always shows operational items for a member", () => {
    const memberPermissions = permissions();

    expect(
      clientNavVisibleForPermissions("overview", memberPermissions),
    ).toBe(true);
    expect(clientNavVisibleForPermissions("leads", memberPermissions)).toBe(
      true,
    );
    expect(clientNavVisibleForPermissions("reports", memberPermissions)).toBe(
      true,
    );
    expect(clientNavVisibleForPermissions("events", memberPermissions)).toBe(
      true,
    );
  });

  it("hides integrations, conversions and settings for a member", () => {
    const memberPermissions = permissions();

    expect(
      clientNavVisibleForPermissions("integrations", memberPermissions),
    ).toBe(false);
    expect(
      clientNavVisibleForPermissions("settings", memberPermissions),
    ).toBe(false);
    expect(
      clientNavVisibleForPermissions("conversions", memberPermissions),
    ).toBe(false);
  });

  it("shows integrations, conversions and settings to an admin who manages them", () => {
    const adminPermissions = permissions({
      canManageIntegrations: true,
      canManageWorkspaceSettings: true,
      canManageBilling: false,
    });

    expect(
      clientNavVisibleForPermissions("integrations", adminPermissions),
    ).toBe(true);
    expect(
      clientNavVisibleForPermissions("settings", adminPermissions),
    ).toBe(true);
    expect(
      clientNavVisibleForPermissions("conversions", adminPermissions),
    ).toBe(true);
  });

  it("shows everything for an owner", () => {
    const ownerPermissions = permissions({
      canManageIntegrations: true,
      canManageWorkspaceSettings: true,
      canManageBilling: true,
    });

    expect(
      clientNavVisibleForPermissions("integrations", ownerPermissions),
    ).toBe(true);
    expect(clientNavVisibleForPermissions("settings", ownerPermissions)).toBe(
      true,
    );
    expect(
      clientNavVisibleForPermissions("conversions", ownerPermissions),
    ).toBe(true);
  });

  it("shows conversions only with the integrations permission", () => {
    expect(
      clientNavVisibleForPermissions(
        "conversions",
        permissions({ canManageWorkspaceSettings: true }),
      ),
    ).toBe(false);
    expect(
      clientNavVisibleForPermissions(
        "conversions",
        permissions({ canManageIntegrations: true }),
      ),
    ).toBe(true);
  });

  it("fails closed when permissions are missing", () => {
    expect(clientNavVisibleForPermissions("integrations", null)).toBe(false);
    expect(clientNavVisibleForPermissions("settings", undefined)).toBe(false);
    expect(clientNavVisibleForPermissions("conversions", null)).toBe(false);
    expect(clientNavVisibleForPermissions("overview", null)).toBe(true);
  });
});
