import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkProductionConfig, type CheckedSettings } from "../src/config/productionChecks.js";
import { api, startDb, stopDb } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);

const GOOD: CheckedSettings = {
  CLIENT_ORIGIN: "https://www.vendramart.com,https://vendramart.com",
  JWT_SECRET: "k3Jf9QpLz2Vx8TnA5wRb7YcHd1MsGe6UoXi4NqPvZtBa0DyCfWjSlEhKrOmIuT3g",
  JWT_EXPIRES_IN_DAYS: 7,
  PAYSTACK_SECRET_KEY: "sk_live_" + "x".repeat(32),
  GOOGLE_MAPS_SERVER_KEY: "maps-server-key",
  CLOUDINARY_CLOUD_NAME: "vendramart",
  CLOUDINARY_API_KEY: "123",
  CLOUDINARY_API_SECRET: "secret",
  RESEND_API_KEY: "re_live_key",
  EMAIL_FROM: "VendraMart <orders@vendramart.com>",
  PLACEHOLDER_IMAGES: "false",
};

describe("the live server's start-up checklist", () => {
  it("passes a fully set up server with nothing to say", () => {
    expect(checkProductionConfig(GOOD)).toEqual({ errors: [], warnings: [] });
  });

  it("refuses a development or non-https website address, naming the bad one", () => {
    for (const origin of ["http://localhost:3000", "https://localhost:3000", "http://127.0.0.1:3000", "http://www.vendramart.com"]) {
      const r = checkProductionConfig({ ...GOOD, CLIENT_ORIGIN: origin });
      expect(r.errors, origin).toHaveLength(1);
      expect(r.errors[0]).toContain(origin);
    }
    const mixed = checkProductionConfig({ ...GOOD, CLIENT_ORIGIN: "https://www.vendramart.com,http://localhost:3000" });
    expect(mixed.errors).toHaveLength(1);
    expect(mixed.errors[0]).toContain("http://localhost:3000");
  });

  it("refuses a stand-in sign-in secret, but accepts a real random one", () => {
    for (const secret of [
      "dev-memory-secret-dev-memory-secret-0123456789",
      "test-secret-test-secret-test-secret-1234",
      "changeme-changeme-changeme-changeme-1234",
      "your-secret-here-your-secret-here-0000",
      "a".repeat(40),
      "abababababababababababababababababab",
      "please-replace-me-with-something-random-123456",
    ]) {
      expect(checkProductionConfig({ ...GOOD, JWT_SECRET: secret }).errors.some((e) => e.includes("JWT_SECRET")), secret).toBe(true);
    }
    expect(checkProductionConfig(GOOD).errors).toEqual([]);
  });

  it("only warns about what is not set up yet, so the site can be put live step by step", () => {
    const bare: CheckedSettings = { CLIENT_ORIGIN: GOOD.CLIENT_ORIGIN, JWT_SECRET: GOOD.JWT_SECRET, JWT_EXPIRES_IN_DAYS: 7 };
    const r = checkProductionConfig(bare);
    expect(r.errors).toEqual([]);
    const text = r.warnings.join("\n");
    for (const word of ["PAYSTACK_SECRET_KEY", "GOOGLE_MAPS_SERVER_KEY", "Cloudinary", "email service", "PLACEHOLDER_IMAGES"]) expect(text, word).toContain(word);
    expect(r.warnings).toHaveLength(5);
  });

  it("warns about a test payment key, a sample sender address and a very long sign-in", () => {
    expect(checkProductionConfig({ ...GOOD, PAYSTACK_SECRET_KEY: "sk_test_abc" }).warnings.join()).toContain("TEST key");
    expect(checkProductionConfig({ ...GOOD, EMAIL_FROM: "VendraMart <no-reply@vendramart.test>" }).warnings.join()).toContain("EMAIL_FROM");
    expect(checkProductionConfig({ ...GOOD, EMAIL_FROM: undefined }).warnings.join()).toContain("EMAIL_FROM");
    expect(checkProductionConfig({ ...GOOD, JWT_EXPIRES_IN_DAYS: 90 }).warnings.join()).toContain("90");
  });

  it("is happy with SMTP instead of Resend", () => {
    const { RESEND_API_KEY: _drop, ...rest } = GOOD;
    expect(checkProductionConfig({ ...rest, SMTP_HOST: "smtp.example.com" })).toEqual({ errors: [], warnings: [] });
  });

  it("never prints a secret in what it says", () => {
    const r = checkProductionConfig({ ...GOOD, PAYSTACK_SECRET_KEY: "sk_test_SUPERSECRETVALUE", JWT_SECRET: "dev-SUPERSECRETJWT-dev-SUPERSECRETJWT" });
    expect(JSON.stringify(r)).not.toContain("SUPERSECRET");
  });
});

describe("health checks", () => {
  it("/health says the process is up, and /health/ready also checks the database", async () => {
    expect((await api().get("/api/health")).body).toEqual({ success: true, data: { status: "ok" } });
    const ready = await api().get("/api/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.data).toEqual({ status: "ready" });
  });

  it("/health/ready says 503 when the database is not connected, so a host can restart or skip this server", async () => {
    const spy = vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(0);
    const res = await api().get("/api/health/ready");
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, error: { code: "SERVICE_UNAVAILABLE" } });
    expect((await api().get("/api/health")).status).toBe(200); // still alive
  });

  it("is open to anyone, and shows nothing about the setup", async () => {
    const res = await api().get("/api/health/ready");
    expect(JSON.stringify(res.body)).not.toMatch(/mongodb|uri|password|key/i);
  });
});
