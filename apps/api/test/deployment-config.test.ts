import { describe, expect, it } from "vitest";
import {
  parseDeploymentConfig,
  parseWebOrigin,
} from "../src/config/deployment-config";

describe("WEB_ORIGIN deployment configuration", () => {
  it("requires an explicitly configured origin in production", () => {
    expect(() => parseDeploymentConfig({ NODE_ENV: "production" })).toThrow(
      "Invalid WEB_ORIGIN",
    );
  });

  it("accepts an HTTPS origin and normalizes a trailing slash", () => {
    expect(
      parseWebOrigin({
        NODE_ENV: "production",
        WEB_ORIGIN: " https://console.example.com/ ",
      }),
    ).toBe("https://console.example.com");
  });

  it("allows HTTP only for localhost in development and test", () => {
    expect(
      parseWebOrigin({
        NODE_ENV: "development",
        WEB_ORIGIN: "http://localhost:3000",
      }),
    ).toBe("http://localhost:3000");
    expect(() =>
      parseWebOrigin({
        NODE_ENV: "production",
        WEB_ORIGIN: "http://localhost:3000",
      }),
    ).toThrow("Invalid WEB_ORIGIN");
    expect(() =>
      parseWebOrigin({
        NODE_ENV: "development",
        WEB_ORIGIN: "http://student.example.com",
      }),
    ).toThrow("Invalid WEB_ORIGIN");
  });

  it("rejects a URL with a path, query, hash, or credentials", () => {
    for (const WEB_ORIGIN of [
      "https://console.example.com/app",
      "https://console.example.com/?next=/login",
      "https://console.example.com/#login",
      "https://user:password@console.example.com",
    ]) {
      expect(() =>
        parseWebOrigin({ NODE_ENV: "production", WEB_ORIGIN }),
      ).toThrow("Invalid WEB_ORIGIN");
    }
  });
});

describe("PIPEDRIVE_CRM_ENCRYPTION_KEY boot validation (optional)", () => {
  const base = { NODE_ENV: "test", WEB_ORIGIN: "http://localhost:3000" };
  const pipedrive = Buffer.alloc(32, 7).toString("base64");
  const kommo = Buffer.alloc(32, 9).toString("base64");

  it("boots exactly as before when the variable is unset", () => {
    expect(() => parseDeploymentConfig(base)).not.toThrow();
  });

  it("accepts a canonical Base64 32-byte key different from the Kommo key", () => {
    expect(() =>
      parseDeploymentConfig({
        ...base,
        PIPEDRIVE_CRM_ENCRYPTION_KEY: pipedrive,
        KOMMO_CRM_ENCRYPTION_KEY: kommo,
      }),
    ).not.toThrow();
  });

  it("refuses to boot with the same key as Kommo", () => {
    expect(() =>
      parseDeploymentConfig({
        ...base,
        PIPEDRIVE_CRM_ENCRYPTION_KEY: pipedrive,
        KOMMO_CRM_ENCRYPTION_KEY: pipedrive,
      }),
    ).toThrow("must differ from KOMMO_CRM_ENCRYPTION_KEY");
  });

  it.each(["short", Buffer.alloc(16, 1).toString("base64"), "not base64!!"])(
    "refuses to boot with an invalid key (%s)",
    (value) => {
      expect(() =>
        parseDeploymentConfig({ ...base, PIPEDRIVE_CRM_ENCRYPTION_KEY: value }),
      ).toThrow("PIPEDRIVE_CRM_ENCRYPTION_KEY");
    },
  );
});
