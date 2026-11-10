import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { csvCell, isCalendarDay, lagosDay, lagosRange, nairaText, payoutCsv, PAYOUT_EXPORT_HEADER } from "../src/domain/payoutExport.js";
import type { Types } from "mongoose";
import { Payout } from "../src/models/Payout.js";
import { api, clearDb, createCustomer, createVendor, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin } from "./fulfilmentHelpers.js";

describe("the bank file rules", () => {
  it("writes kobo as plain naira text with two decimals", () => {
    expect(nairaText(0)).toBe("0.00");
    expect(nairaText(5)).toBe("0.05");
    expect(nairaText(150_000)).toBe("1500.00");
    expect(nairaText(4_374_050)).toBe("43740.50");
    expect(() => nairaText(1.5)).toThrow();
    expect(() => nairaText(-1)).toThrow();
  });

  it("knows real calendar days", () => {
    expect(isCalendarDay("2026-11-09")).toBe(true);
    expect(isCalendarDay("2026-02-30")).toBe(false);
    expect(isCalendarDay("09/11/2026")).toBe(false);
    expect(isCalendarDay("")).toBe(false);
  });

  it("turns a range of days into Lagos-clock bounds, both days included", () => {
    const r = lagosRange("2026-11-09", "2026-11-09")!;
    expect(r.start.toISOString()).toBe("2026-11-08T23:00:00.000Z"); // midnight in Lagos is 23:00 the evening before in UTC
    expect(r.end.toISOString()).toBe("2026-11-09T23:00:00.000Z");
    expect(lagosRange("2026-11-10", "2026-11-09")).toBeNull();
    expect(lagosRange("2026-11-09", "2026-13-01")).toBeNull();
    expect(lagosRange("2025-01-01", "2026-12-31")).toBeNull(); // longer than a year
    expect(lagosRange("2026-01-01", "2026-12-31")).not.toBeNull();
  });

  it("reads an instant as the Lagos calendar day", () => {
    expect(lagosDay(new Date("2026-11-08T23:30:00Z"))).toBe("2026-11-09");
    expect(lagosDay(new Date("2026-11-08T22:59:00Z"))).toBe("2026-11-08");
  });

  it("quotes cells and defuses spreadsheet formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("Ada, Bola")).toBe('"Ada, Bola"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell("+234")).toBe("'+234");
    expect(csvCell("0123456789")).toBe("0123456789"); // account numbers are left alone
  });

  it("builds the file with a header, a narration and Windows line endings", () => {
    const csv = payoutCsv([{ number: "PR-2291", vendor: "Bodija Foods", bankName: "GTBank", accountNumber: "0123456789", accountName: "Bodija Foods Ltd", amountKobo: 4_374_000, requestedAt: new Date("2026-11-08T23:30:00Z"), status: "REQUESTED" }]);
    const lines = csv.replace("﻿", "").split("\r\n");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(lines[0]).toBe(PAYOUT_EXPORT_HEADER.join(","));
    expect(lines[1]).toBe("PR-2291,Bodija Foods,GTBank,0123456789,Bodija Foods Ltd,43740.00,VendraMart PR-2291,2026-11-09,REQUESTED");
    expect(lines[2]).toBe("");
  });
});

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

async function makePayout(number: string, vendorId: Types.ObjectId, userId: Types.ObjectId, over: Record<string, unknown> = {}) {
  return Payout.create({
    number,
    vendorId,
    requestedBy: userId,
    amountKobo: 1_000_000,
    subOrderIds: [],
    bank: { bankName: "GTBank", accountNumber: "0123456789", accountName: "Bodija Foods" },
    ...over,
  });
}

describe("downloading the payout file", () => {
  it("returns only the chosen days and status, as a CSV download", async () => {
    const admin = await createAdmin();
    const { user, vendor } = await createVendor();
    await makePayout("PR-1", vendor._id, user._id, { requestedAt: new Date("2026-11-03T10:00:00Z") });
    await makePayout("PR-2", vendor._id, user._id, { requestedAt: new Date("2026-11-05T10:00:00Z"), amountKobo: 250_050 });
    await makePayout("PR-3", vendor._id, user._id, { requestedAt: new Date("2026-11-05T11:00:00Z"), status: "PAID" });
    await makePayout("PR-4", vendor._id, user._id, { requestedAt: new Date("2026-11-20T10:00:00Z") });

    const res = await asUser(admin.bearer).get("/admin/payouts/export?from=2026-11-04&to=2026-11-06");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="vendramart-payouts-2026-11-04-to-2026-11-06.csv"');
    expect(res.headers["cache-control"]).toBe("no-store");
    const rows = res.text.replace("﻿", "").trim().split("\r\n");
    expect(rows).toHaveLength(2); // the header and PR-2 only: PR-1 is before, PR-3 is paid, PR-4 is after
    expect(rows[1]).toContain("PR-2,");
    expect(rows[1]).toContain(",2500.50,VendraMart PR-2,2026-11-05,REQUESTED");

    const all = await asUser(admin.bearer).get("/admin/payouts/export?from=2026-11-01&to=2026-11-30&status=ALL");
    expect(all.text.trim().split("\r\n")).toHaveLength(5);
    const paid = await asUser(admin.bearer).get("/admin/payouts/export?from=2026-11-01&to=2026-11-30&status=PAID");
    expect(paid.text).toContain("PR-3");
    expect(paid.text).not.toContain("PR-2");
  });

  it("counts days on the Lagos clock, so a request just after midnight there is on that day", async () => {
    const admin = await createAdmin();
    const { user, vendor } = await createVendor();
    await makePayout("PR-LATE", vendor._id, user._id, { requestedAt: new Date("2026-11-04T23:30:00Z") }); // 00:30 on the 5th in Lagos
    const fifth = await asUser(admin.bearer).get("/admin/payouts/export/summary?from=2026-11-05&to=2026-11-05");
    expect(fifth.body.data).toEqual({ count: 1, totalKobo: 1_000_000 });
    const fourth = await asUser(admin.bearer).get("/admin/payouts/export/summary?from=2026-11-04&to=2026-11-04");
    expect(fourth.body.data).toEqual({ count: 0, totalKobo: 0 });
  });

  it("gives a summary of the count and total before downloading", async () => {
    const admin = await createAdmin();
    const { user, vendor } = await createVendor();
    await makePayout("PR-1", vendor._id, user._id, { amountKobo: 100_000 });
    await makePayout("PR-2", vendor._id, user._id, { amountKobo: 250_050 });
    const res = await asUser(admin.bearer).get(`/admin/payouts/export/summary?from=2020-01-01&to=2030-01-01`);
    expect(res.status).toBe(422); // more than a year
    const day = lagosDay(new Date());
    const ok = await asUser(admin.bearer).get(`/admin/payouts/export/summary?from=${day}&to=${day}`);
    expect(ok.status).toBe(200);
  });

  it("refuses missing, unreal or backwards days", async () => {
    const admin = await createAdmin();
    for (const q of ["", "?from=2026-11-05", "?from=nope&to=2026-11-05", "?from=2026-11-06&to=2026-11-05", "?from=2026-02-30&to=2026-03-01", "?from=2026-11-01&to=2026-11-02&status=BOGUS"]) {
      expect((await asUser(admin.bearer).get(`/admin/payouts/export${q}`)).status, q).toBe(422);
    }
  });

  it("is not read as a payout id", async () => {
    const admin = await createAdmin();
    expect((await asUser(admin.bearer).get("/admin/payouts/export?from=2026-11-01&to=2026-11-02")).status).toBe(200);
  });

  it("is only for an administrator who may open payouts", async () => {
    const admin = await createAdmin();
    const customer = await createCustomer();
    const url = "/admin/payouts/export?from=2026-11-01&to=2026-11-02";
    expect((await asUser(customer.bearer).get(url)).status).toBe(403);
    expect((await api().get(`/api${url}`)).status).toBe(401);
    const finance = await asUser(admin.bearer).post("/admin/staff", { name: "Fin Manager", email: "fin@example.com", phone: "08031234567", password: "Passw0rdTest", role: "STAFF", staffTitle: "FINANCE_MANAGER" });
    const { loginToken } = await import("./helpers.js");
    expect((await asUser(await loginToken("fin@example.com")).get(url)).status).toBe(200);
    await asUser(admin.bearer).patch(`/admin/staff/${finance.body.data.id}`, { permissions: ["orders"] });
    expect((await asUser(await loginToken("fin@example.com")).get(url)).status).toBe(403);
  });

  it("keeps a vendor's name from running as a spreadsheet formula", async () => {
    const admin = await createAdmin();
    const { user, vendor } = await createVendor();
    await makePayout("PR-EVIL", vendor._id, user._id, { bank: { bankName: "GTBank", accountNumber: "0123456789", accountName: "=1+1" } });
    const res = await asUser(admin.bearer).get("/admin/payouts/export?from=2000-01-01&to=2030-01-01");
    expect(res.status).toBe(422);
    const day = lagosDay(new Date());
    const today = await asUser(admin.bearer).get(`/admin/payouts/export?from=${day}&to=${day}`);
    expect(today.text).toContain(",'=1+1,");
  });
});
