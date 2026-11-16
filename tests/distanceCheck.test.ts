import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleRoutesProvider, explainFailure } from "../src/services/distance/GoogleRoutesProvider.js";
import { IBADAN, OJA_BA, api, clearDb, createCustomer, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin } from "./fulfilmentHelpers.js";

const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("explaining a failed distance call", () => {
  const http = (status: number, detail: string) => explainFailure({ kind: "http", status, detail }, "SECRET-KEY");

  it("recognises a key that is restricted to websites", () => {
    const e = http(403, "Requests from referer <empty> are blocked.");
    expect(e.problem).toMatch(/restricted to websites/);
    expect(e.hint).toMatch(/GOOGLE_MAPS_SERVER_KEY/);
  });

  it("recognises the Routes API being switched off", () => {
    expect(http(403, "Routes API has not been used in project 123 before or it is disabled.").problem).toMatch(/Routes API is not switched on/);
  });

  it("recognises a key restricted to IP addresses, billing, a bad key and a used-up quota", () => {
    expect(http(403, "The provided API key has an IP address restriction. The IP address is not allowed").problem).toMatch(/IP addresses/);
    expect(http(403, "This API method requires billing to be enabled.").problem).toMatch(/billing/i);
    expect(http(400, "API key not valid. Please pass a valid API key.").problem).toMatch(/does not accept the key/);
    expect(http(429, "Quota exceeded").problem).toMatch(/quota/);
    expect(http(403, "denied").problem).toMatch(/refused/);
    expect(http(502, "").problem).toMatch(/502/);
  });

  it("explains a network failure: a timeout, an old Node, or no outgoing connections", () => {
    expect(explainFailure({ kind: "network", reason: "AbortError: This operation was aborted" }).problem).toMatch(/did not answer in time/);
    expect(explainFailure({ kind: "network", reason: "ReferenceError: fetch is not defined" }).problem).toMatch(/Node.js is too old/);
    expect(explainFailure({ kind: "network", reason: "TypeError: fetch failed" }).hint).toMatch(/outgoing HTTPS/);
  });

  it("never repeats the key, even when Google's message contains it", () => {
    const e = http(403, "Key SECRET-KEY is restricted. Requests from referer are blocked.");
    expect(JSON.stringify(e)).not.toContain("SECRET-KEY");
    expect(JSON.stringify(explainFailure({ kind: "http", status: 418, detail: "SECRET-KEY" }, "SECRET-KEY"))).not.toContain("SECRET-KEY");
  });
});

describe("GoogleRoutesProvider retries and checks", () => {
  it("tries once more after a dropped connection, and succeeds if the second try does", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      if (n++ === 0) throw new Error("socket hang up");
      return reply(200, { routes: [{ distanceMeters: 5000 }] });
    }) as never;
    expect(await new GoogleRoutesProvider("K", fetchImpl).driveDistanceMeters(IBADAN, OJA_BA)).toBe(5000);
    expect(n).toBe(2);
  });

  it("tries once more after a Google 5xx, but not after a refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let a = 0;
    await new GoogleRoutesProvider("K", (async () => (a++, reply(503, "busy"))) as never).driveDistanceMeters(IBADAN, OJA_BA).catch(() => {});
    expect(a).toBe(2);
    let b = 0;
    await new GoogleRoutesProvider("K", (async () => (b++, reply(403, "denied"))) as never).driveDistanceMeters(IBADAN, OJA_BA).catch(() => {});
    expect(b).toBe(1);
    vi.restoreAllMocks();
  });

  it("writes the real reason to the log, and gives the shopper only the safe message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new GoogleRoutesProvider("SECRET-KEY", (async () => reply(403, "Requests from referer <empty> are blocked. SECRET-KEY")) as never);
    const err = await provider.driveDistanceMeters(IBADAN, OJA_BA).catch((e) => e);
    expect(err).toMatchObject({ status: 503 });
    expect(err.message).not.toMatch(/referer|SECRET-KEY|restricted/);
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/restricted to websites/);
    expect(logged).not.toContain("SECRET-KEY");
    vi.restoreAllMocks();
  });

  it("check() says it works, with the sample distance", async () => {
    const provider = new GoogleRoutesProvider("K", (async () => reply(200, { routes: [{ distanceMeters: 6200 }] })) as never);
    expect(await provider.check()).toEqual({ ok: true, provider: "google", meters: 6200 });
  });

  it("check() says what is wrong", async () => {
    const off = new GoogleRoutesProvider("K", (async () => reply(403, "Routes API has not been used in project 1 before or it is disabled.")) as never);
    expect(await off.check()).toMatchObject({ ok: false, provider: "google", problem: expect.stringMatching(/Routes API is not switched on/) });
    const down = new GoogleRoutesProvider("K", (async () => { throw new Error("getaddrinfo ENOTFOUND routes.googleapis.com"); }) as never);
    expect(await down.check()).toMatchObject({ ok: false, problem: expect.stringMatching(/could not reach Google/) });
  });
});

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

describe("POST /api/admin/settings/check-distance", () => {
  it("answers an administrator with the state of the distance service", async () => {
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).post("/admin/settings/check-distance");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true });
    expect(typeof res.body.data.provider).toBe("string");
  });

  it("is not for customers or signed-out visitors, or staff without the pricing area", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer();
    expect((await asUser(customer.bearer).post("/admin/settings/check-distance")).status).toBe(403);
    expect((await api().post("/api/admin/settings/check-distance")).status).toBe(401);
    await asUser(admin.bearer).post("/admin/staff", { name: "Fin Manager", email: "fin@example.com", phone: "08031234567", password: "Passw0rdTest", role: "STAFF", staffTitle: "FINANCE_MANAGER" });
    const { loginToken } = await import("./helpers.js");
    expect((await asUser(await loginToken("fin@example.com")).post("/admin/settings/check-distance")).status).toBe(403);
  });
});
