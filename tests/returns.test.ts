import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { earningState, holdHasEnded } from "../src/domain/earnings.js";
import { LODGE_WINDOW_HOURS, REFUND_WORKING_DAYS, canLodge, lodgeDeadline, maxRefundKobo, netEarningKobo, refundDeadline, returnedEarningKobo, windowState, workingDaysLeft } from "../src/domain/returns.js";
import { Notification } from "../src/models/Notification.js";
import { Product } from "../src/models/Product.js";
import { ReturnRequest } from "../src/models/ReturnRequest.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { availableFilter, loadEarnings } from "../src/modules/earnings/earnings.service.js";
import { requestPayout } from "../src/modules/payouts/payouts.service.js";
import { flagOverdueReturns } from "../src/modules/returns/returns.service.js";
import { api, clearDb, createCustomer, loginToken, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, paidOrder } from "./fulfilmentHelpers.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("the rules for a return", () => {
  const delivered = new Date("2026-11-10T10:00:00Z");

  it("allows a case up to 48 hours after delivery, and not a moment later", () => {
    expect(LODGE_WINDOW_HOURS).toBe(48);
    expect(lodgeDeadline(delivered).toISOString()).toBe("2026-11-12T10:00:00.000Z");
    expect(canLodge(delivered, new Date("2026-11-12T09:59:59Z"))).toBe(true);
    expect(canLodge(delivered, new Date("2026-11-12T10:00:00Z"))).toBe(true); // exactly at the deadline
    expect(canLodge(delivered, new Date("2026-11-12T10:00:01Z"))).toBe(false);
  });

  it("keeps the return window at 2 days: a case cannot be lodged later than 48 hours after delivery", () => {
    expect(LODGE_WINDOW_HOURS).toBe(48);
  });

  it("makes the refund due within 7 working days of confirming, Monday to Friday, at the same time of day", () => {
    expect(REFUND_WORKING_DAYS).toBe(7);
    // Confirmed on a Tuesday: Wed, Thu, Fri, Mon, Tue, Wed, Thu.
    expect(refundDeadline(new Date("2026-11-10T08:30:00Z")).toISOString()).toBe("2026-11-19T08:30:00.000Z");
    // Confirmed on a Friday: Mon, Tue, Wed, Thu, Fri, Mon, Tue.
    expect(refundDeadline(new Date("2026-11-13T10:00:00Z")).toISOString()).toBe("2026-11-24T10:00:00.000Z");
  });

  it("counts a case confirmed on a weekend from Monday, and skips weekends in between", () => {
    // Saturday counts as Monday 00:00 in Lagos, so the 7 days run Tue 17th to Wed 25th, ending at 00:00 Lagos (23:00 UTC the day before).
    expect(refundDeadline(new Date("2026-11-14T10:00:00Z")).toISOString()).toBe("2026-11-24T23:00:00.000Z");
    expect(refundDeadline(new Date("2026-11-15T10:00:00Z")).toISOString()).toBe("2026-11-24T23:00:00.000Z"); // Sunday: the same
    const due = refundDeadline(new Date("2026-11-10T08:30:00Z"));
    const day = new Date(due.getTime() + 3_600_000).getUTCDay(); // the weekday in Lagos
    expect(day === 0 || day === 6).toBe(false); // never due on a weekend
  });

  it("knows whether a window is not started, open, or ended without being completed", () => {
    const ends = new Date("2026-11-17T08:30:00Z");
    expect(windowState({ status: "REQUESTED" }, delivered)).toBe("NONE");
    expect(windowState({ status: "COMPLETED", windowEndsAt: ends }, new Date("2026-12-01T00:00:00Z"))).toBe("NONE"); // settled in time or not, it is over
    expect(windowState({ status: "CONFIRMED", windowEndsAt: ends }, new Date("2026-11-17T08:30:00Z"))).toBe("OPEN"); // exactly at the end
    expect(windowState({ status: "CONFIRMED", windowEndsAt: ends }, new Date("2026-11-17T08:30:01Z"))).toBe("ENDED");
  });

  it("counts the working days left, after today up to the deadline day, and zero on that day and after", () => {
    const due = new Date("2026-11-19T08:30:00Z"); // a Thursday: confirmed on Tuesday the 10th
    expect(workingDaysLeft(due, new Date("2026-11-10T08:30:00Z"))).toBe(7); // right after confirming
    expect(workingDaysLeft(due, new Date("2026-11-11T12:00:00Z"))).toBe(6);
    expect(workingDaysLeft(due, new Date("2026-11-13T12:00:00Z"))).toBe(4); // Friday: Mon, Tue, Wed, Thu are left
    expect(workingDaysLeft(due, new Date("2026-11-14T12:00:00Z"))).toBe(4); // Saturday: the same four
    expect(workingDaysLeft(due, new Date("2026-11-10T23:30:00Z"))).toBe(6); // 00:30 on Wednesday in Lagos, so Wednesday is today
    expect(workingDaysLeft(due, new Date("2026-11-19T06:00:00Z"))).toBe(0); // the deadline day, still open
    expect(workingDaysLeft(due, new Date("2026-11-19T08:30:01Z"))).toBe(0); // past it
    expect(workingDaysLeft(due, new Date("2026-11-25T00:00:00Z"))).toBe(0);
  });

  it("takes the vendor's share off in proportion, in whole kobo, and the whole line when every unit goes", () => {
    expect(returnedEarningKobo(1_350_000, 1, 1)).toBe(1_350_000);
    expect(returnedEarningKobo(2_700_000, 2, 1)).toBe(1_350_000);
    expect(returnedEarningKobo(1000, 3, 1)).toBe(333);
    expect(returnedEarningKobo(1000, 3, 2)).toBe(667); // 666.67 rounds up
    expect(returnedEarningKobo(1000, 3, 3)).toBe(1000); // nothing left over
    expect(() => returnedEarningKobo(1000, 3, 0)).toThrow();
    expect(() => returnedEarningKobo(1000, 3, 4)).toThrow();
    expect(() => returnedEarningKobo(10.5, 3, 1)).toThrow();
  });

  it("caps a refund at the goods, plus the delivery fee only when the whole delivery goes back", () => {
    expect(maxRefundKobo(1_500_000, 64_000, false)).toBe(1_500_000);
    expect(maxRefundKobo(1_500_000, 64_000, true)).toBe(1_564_000);
  });

  it("never lets earnings after refunds go below nothing", () => {
    expect(netEarningKobo(1_350_000, 0)).toBe(1_350_000);
    expect(netEarningKobo(1_350_000, undefined)).toBe(1_350_000);
    expect(netEarningKobo(1_350_000, 450_000)).toBe(900_000);
    expect(netEarningKobo(1_350_000, 2_000_000)).toBe(0);
  });

  it("keeps earnings on hold, with no unlock date, while a return is open, however long ago it was delivered", () => {
    const longAgo = new Date("2026-01-05T10:00:00Z");
    const now = new Date("2026-11-10T10:00:00Z");
    expect(holdHasEnded(longAgo, now)).toBe(true);
    expect(earningState({ status: "DELIVERED", deliveredAt: longAgo }, now)).toEqual({ state: "AVAILABLE" });
    expect(earningState({ status: "DELIVERED", deliveredAt: longAgo, returnHold: true }, now)).toEqual({ state: "ON_HOLD", heldForReturn: true });
    // A payout that already owns the money still wins.
    expect(earningState({ status: "DELIVERED", deliveredAt: longAgo, payoutStatus: "PAID", returnHold: true }, now)).toEqual({ state: "PAID" });
  });
});

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

/** The checkout order, paid. Bodija's delivery can then be marked delivered (just now, or some hours ago). */
async function order() {
  const o = await paidOrder();
  const deliver = (hoursAgo = 0) => SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "DELIVERED", deliveredAt: new Date(Date.now() - hoursAgo * HOUR) });
  const c = asUser(o.customer.bearer);
  const lodge = (over: Record<string, unknown> = {}) =>
    c.post("/returns", {
      subOrderId: String(o.bodijaSub._id),
      type: "RETURN",
      reason: "DAMAGED",
      description: "The bag was torn and the flour spilled.",
      items: [{ productId: String(o.flour._id), qty: 1 }],
      ...over,
    });
  return { ...o, deliver, c, lodge };
}

async function withAdmin() {
  const o = await order();
  await o.deliver();
  const admin = await createAdmin();
  const a = asUser(admin.bearer);
  return { ...o, admin, a };
}

describe("lodging a return or a problem report", () => {
  it("is only for a delivery that has arrived", async () => {
    const o = await order();
    const early = await o.lodge();
    expect(early.status).toBe(403);
    expect(early.body.error.message).toMatch(/once it has been delivered/);
    await o.deliver();
    expect((await o.lodge()).status).toBe(201);
  });

  it("saves the case, numbers it, copies the items in and puts the delivery's earnings on hold", async () => {
    const o = await order();
    await o.deliver();
    const res = await o.lodge();
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      number: "RT-1001",
      type: "RETURN",
      reason: "DAMAGED",
      status: "REQUESTED",
      subOrderRef: o.bodijaSub.ref,
      items: [{ productId: String(o.flour._id), name: o.flour.name, qty: 1, lineTotalKobo: 1_500_000 }],
      goodsKobo: 1_500_000,
      windowState: "NONE",
      windowEndsAt: null,
    });
    expect(await SubOrder.findById(o.bodijaSub._id)).toMatchObject({ returnHold: true });
    expect((await o.lodge({ type: "REPORT", reason: "OTHER" })).status).toBe(409); // a second case waits until the first is settled
  });

  it("works for a problem report as well as a return", async () => {
    const o = await order();
    await o.deliver();
    const res = await o.lodge({ type: "REPORT", reason: "NOT_RECEIVED", description: "The rider marked it delivered but nothing came." });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ type: "REPORT", reason: "NOT_RECEIVED", reasonLabel: expect.stringMatching(/did not receive/) });
  });

  it("allows 48 hours from delivery and refuses after", async () => {
    const o = await order();
    await o.deliver(49);
    const late = await o.lodge();
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/48 hour window/);
    expect(await ReturnRequest.countDocuments()).toBe(0);
    await o.deliver(47);
    expect((await o.lodge()).status).toBe(201);
  });

  it("allows one open case on a delivery at a time, and another once it is cancelled", async () => {
    const o = await order();
    await o.deliver();
    const first = (await o.lodge()).body.data;
    const second = await o.lodge();
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/already have an open/);
    expect((await o.c.post(`/returns/${first.id}/cancel`)).status).toBe(200);
    expect(await SubOrder.findById(o.bodijaSub._id)).toMatchObject({ returnHold: false });
    expect((await o.lodge()).status).toBe(201);
  });

  it("refuses short descriptions, unknown reasons and types, empty or doubled or foreign items, too many units, and extra fields", async () => {
    const o = await order();
    await o.deliver();
    const flour = String(o.flour._id);
    const bad: Record<string, unknown>[] = [
      { description: "torn" },
      { reason: "BECAUSE" },
      { type: "SWAP" },
      { items: [] },
      { items: [{ productId: flour, qty: 0 }] },
      { items: [{ productId: flour, qty: 1.5 }] },
      { items: [{ productId: flour, qty: 2 }] }, // only 1 was bought
      { items: [{ productId: flour, qty: 1 }, { productId: flour, qty: 1 }] },
      { items: [{ productId: String(o.oil._id), qty: 1 }] }, // the other store's product is not in this delivery
      { items: [{ productId: "nope", qty: 1 }] },
      { subOrderId: "nope" },
      { extra: true },
    ];
    for (const over of bad) expect((await o.lodge(over)).status, JSON.stringify(over)).toBe(422);
    expect(await ReturnRequest.countDocuments()).toBe(0);
  });

  it("is not for another customer's delivery, nor for a vendor, an admin or a signed-out visitor", async () => {
    const o = await order();
    await o.deliver();
    const other = asUser((await createCustomer()).bearer);
    expect((await other.post("/returns", { subOrderId: String(o.bodijaSub._id), type: "RETURN", reason: "DAMAGED", description: "Torn and spilled flour", items: [{ productId: String(o.flour._id), qty: 1 }] })).status).toBe(404);
    expect((await asUser(o.vendorTokens.bodija).post("/returns", {})).status).toBe(403);
    expect((await asUser((await createAdmin()).bearer).post("/returns", {})).status).toBe(403);
    expect((await api().post("/api/returns").send({})).status).toBe(401);
    expect((await o.lodge({ subOrderId: "64b000000000000000000000" })).status).toBe(404);
  });

  it("tells the staff who handle orders, and the vendor in the app", async () => {
    const o = await order();
    await o.deliver();
    const admin = await createAdmin();
    const staff = (title: string, email: string) => asUser(admin.bearer).post("/admin/staff", { name: "Some Manager", email, phone: "08031234567", password: "Passw0rdTest", role: "STAFF", staffTitle: title });
    const support = (await staff("CUSTOMER_SUPPORT", "support@example.com")).body.data;
    const vendorMgr = (await staff("VENDOR_MANAGER", "vendor-mgr@example.com")).body.data;
    await o.lodge();
    expect(await Notification.countDocuments({ userId: support.id, kind: "RETURN_REQUESTED" })).toBe(1);
    expect(await Notification.countDocuments({ userId: vendorMgr.id, kind: "RETURN_REQUESTED" })).toBe(0);
    const vendorNote = (await Notification.find({ userId: o.bodija.user._id, kind: "RETURN_REQUESTED" }))[0]!;
    expect(vendorNote.body).toMatch(/earnings for this order stay on hold/);
  });

  it("lists the customer's own cases and cancels a waiting one, but not a decided one or someone else's", async () => {
    const o = await withAdmin();
    const made = (await o.lodge()).body.data;
    const mine = await o.c.get("/returns");
    expect(mine.body.data.map((r: { id: string }) => r.id)).toEqual([made.id]);
    expect((await asUser((await createCustomer()).bearer).get("/returns")).body.data).toEqual([]);
    expect((await asUser((await createCustomer()).bearer).post(`/returns/${made.id}/cancel`)).status).toBe(404);
    await o.a.post(`/admin/returns/${made.id}/confirm`, {});
    const late = await o.c.post(`/returns/${made.id}/cancel`);
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/only be cancelled while it is waiting/);
  });
});

describe("the customer's order page", () => {
  it("says whether a return can be lodged, the deadline, what can still be returned, and shows the cases", async () => {
    const o = await order();
    const sub = async () => ((await o.c.get(`/orders/${o.data.orderId}`)).body.data.subOrders as { id: string; returnWindow: { canLodge: boolean; deadline: string | null; hasOpenCase: boolean }; returns: { number: string; status: string }[]; items: { returnableQty: number }[] }[]).find((s) => s.id === String(o.bodijaSub._id))!;

    expect((await sub()).returnWindow).toMatchObject({ canLodge: false, deadline: null }); // not delivered yet
    await o.deliver();
    const open = await sub();
    expect(open.returnWindow).toMatchObject({ canLodge: true, hasOpenCase: false });
    expect(new Date(open.returnWindow.deadline!).getTime() - Date.now()).toBeGreaterThan(47 * HOUR);
    expect(open.items[0]!.returnableQty).toBe(1);

    await o.lodge();
    const held = await sub();
    expect(held.returnWindow).toMatchObject({ canLodge: false, hasOpenCase: true });
    expect(held.returns).toMatchObject([{ number: "RT-1001", status: "REQUESTED" }]);

    await o.deliver(49);
    await ReturnRequest.updateMany({}, { status: "REJECTED" });
    expect((await sub()).returnWindow.canLodge).toBe(false); // 48 hours have passed
  });
});

describe("deciding a case (admin) and the 7 working day refund deadline", () => {
  it("lists what needs a decision, counts it, and gives a confirmed case its refund deadline", async () => {
    const o = await withAdmin();
    const made = (await o.lodge()).body.data;
    expect((await o.a.get("/admin/returns")).body.data[0]).toMatchObject({ id: made.id, status: "REQUESTED", customer: { email: o.customer.email }, vendor: { businessName: "Bodija Provisions" }, maxRefundKobo: 1_564_000 });
    expect((await o.a.get("/admin/returns/counts")).body.data).toEqual({ needs_decision: 1, window: 0, overdue: 0, closed: 0, all: 1 });

    const res = await o.a.post(`/admin/returns/${made.id}/confirm`, { note: "Please keep the bag." });
    expect(res.status).toBe(200);
    const row = res.body.data;
    expect(row).toMatchObject({ status: "CONFIRMED", windowState: "OPEN", decisionNote: "Please keep the bag." });
    // Seven working days away: the deadline the domain works out, 9 to 12 calendar days later depending on the weekend.
    expect(row.windowEndsAt).toBe(refundDeadline(new Date(row.confirmedAt)).toISOString());
    const calendarDays = (new Date(row.windowEndsAt).getTime() - new Date(row.confirmedAt).getTime()) / DAY;
    expect(calendarDays).toBeGreaterThanOrEqual(9);
    expect(calendarDays).toBeLessThanOrEqual(12);
    expect(row.windowWorkingDaysLeft).toBeGreaterThanOrEqual(7); // 8 when it was confirmed on a weekend
    expect(row.windowWorkingDaysLeft).toBeLessThanOrEqual(8);

    expect((await o.a.get("/admin/returns?group=needs_decision")).body.data).toHaveLength(0);
    expect((await o.a.get("/admin/returns?group=window")).body.data[0].id).toBe(made.id);
    expect((await o.a.get("/admin/returns/counts")).body.data).toMatchObject({ needs_decision: 0, window: 1 });
    expect((await o.a.get("/admin/returns?group=all&q=RT-1001")).body.data).toHaveLength(1);
    expect((await o.a.get("/admin/returns?group=all&q=.*")).body.data).toHaveLength(0);
    expect((await o.a.get("/admin/returns?group=sideways")).status).toBe(422);
  });

  it("tells the customer the date their refund is due, and the vendor", async () => {
    const o = await withAdmin();
    const made = (await o.lodge()).body.data;
    await o.a.post(`/admin/returns/${made.id}/confirm`, {});
    const note = (await Notification.find({ userId: o.customer.user._id, kind: "RETURN_CONFIRMED" }))[0]!;
    expect(note.title).toBe("RT-1001 is confirmed");
    expect(note.body).toMatch(/refund will be made within 7 working days, by \d{1,2} \w+/);
    expect(note.link).toBe(`/order/?id=${o.data.orderId}`);
    expect(await Notification.countDocuments({ userId: o.bodija.user._id, kind: "RETURN_CONFIRMED" })).toBe(1);
  });

  it("can only be confirmed once, and only while it is waiting", async () => {
    const o = await withAdmin();
    const made = (await o.lodge()).body.data;
    expect((await o.a.post(`/admin/returns/${made.id}/confirm`, {})).status).toBe(200);
    expect((await o.a.post(`/admin/returns/${made.id}/confirm`, {})).status).toBe(409);
    expect((await o.a.post("/admin/returns/64b000000000000000000000/confirm", {})).status).toBe(404);
    expect((await o.a.post(`/admin/returns/${made.id}/confirm`, { note: "x".repeat(501) })).status).toBe(422);
  });

  it("rejecting needs a reason, tells the customer, and releases the delivery's earnings", async () => {
    const o = await withAdmin();
    const made = (await o.lodge()).body.data;
    expect((await o.a.post(`/admin/returns/${made.id}/reject`, {})).status).toBe(422);
    expect((await o.a.post(`/admin/returns/${made.id}/reject`, { reason: "no" })).status).toBe(422);
    const res = await o.a.post(`/admin/returns/${made.id}/reject`, { reason: "The item was used, so it cannot be returned." });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "REJECTED", decisionNote: "The item was used, so it cannot be returned." });
    expect(await SubOrder.findById(o.bodijaSub._id)).toMatchObject({ returnHold: false });
    const note = (await Notification.find({ userId: o.customer.user._id, kind: "RETURN_REJECTED" }))[0]!;
    expect(note.body).toContain("The item was used");
    expect((await o.a.post(`/admin/returns/${made.id}/reject`, { reason: "Again, to be sure" })).status).toBe(409);
    expect((await o.a.get("/admin/returns?group=closed")).body.data).toHaveLength(1);
  });

  it("can turn down a confirmed case too, for example when the item came back unfit", async () => {
    const o = await withAdmin();
    const made = (await o.lodge()).body.data;
    await o.a.post(`/admin/returns/${made.id}/confirm`, {});
    expect((await o.a.post(`/admin/returns/${made.id}/reject`, { reason: "The item came back used." })).status).toBe(200);
    expect(await SubOrder.findById(o.bodijaSub._id)).toMatchObject({ returnHold: false });
  });

  it("completing records the refund, takes the vendor's share off their earnings, releases the hold and tells both", async () => {
    const o = await withAdmin();
    const made = (await o.lodge()).body.data;
    expect((await o.a.post(`/admin/returns/${made.id}/complete`, { refundKobo: 1_500_000 })).status).toBe(409); // not confirmed yet
    await o.a.post(`/admin/returns/${made.id}/confirm`, {});
    const res = await o.a.post(`/admin/returns/${made.id}/complete`, { refundKobo: 1_564_000, note: "Paystack ref T123" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "COMPLETED", refundKobo: 1_564_000, refundNote: "Paystack ref T123", restocked: false });
    expect(await SubOrder.findById(o.bodijaSub._id)).toMatchObject({ returnHold: false, returnedEarningKobo: 1_350_000 });
    const customerNote = (await Notification.find({ userId: o.customer.user._id, kind: "RETURN_COMPLETED" }))[0]!;
    expect(customerNote.body).toContain("15,640");
    expect((await Notification.find({ userId: o.bodija.user._id, kind: "RETURN_COMPLETED" }))[0]!.body).toContain("13,500");
    expect((await o.a.post(`/admin/returns/${made.id}/complete`, { refundKobo: 100 })).status).toBe(409); // only once
  });

  it("refuses a refund of nothing, or more than the goods (plus delivery when the whole delivery goes back)", async () => {
    const o = await withAdmin();
    const made = (await o.lodge()).body.data;
    await o.a.post(`/admin/returns/${made.id}/confirm`, {});
    for (const refundKobo of [0, -1, 1.5, 1_564_001]) {
      expect((await o.a.post(`/admin/returns/${made.id}/complete`, { refundKobo })).status, String(refundKobo)).toBe(422);
    }
    expect((await o.a.post(`/admin/returns/${made.id}/complete`, { refundKobo: "100" })).status).toBe(422);
    expect((await o.a.post(`/admin/returns/${made.id}/complete`, { refundKobo: 100, extra: true })).status).toBe(422);
    expect(await ReturnRequest.findById(made.id)).toMatchObject({ status: "CONFIRMED" });
  });

  it("can put the returned units back on sale, taking them off the sold count", async () => {
    const o = await withAdmin();
    const before = await Product.findById(o.flour._id);
    const made = (await o.lodge()).body.data;
    await o.a.post(`/admin/returns/${made.id}/confirm`, {});
    await o.a.post(`/admin/returns/${made.id}/complete`, { refundKobo: 1_500_000, restock: true });
    const after = await Product.findById(o.flour._id);
    expect(after!.stock).toBe(before!.stock + 1);
    expect(after!.soldCount).toBe(before!.soldCount - 1);
    expect((await ReturnRequest.findById(made.id))!.restocked).toBe(true);
  });

  it("does not put units back on sale unless the admin says so", async () => {
    const o = await withAdmin();
    const before = await Product.findById(o.flour._id);
    const made = (await o.lodge()).body.data;
    await o.a.post(`/admin/returns/${made.id}/confirm`, {});
    await o.a.post(`/admin/returns/${made.id}/complete`, { refundKobo: 1_500_000 });
    expect((await Product.findById(o.flour._id))!.stock).toBe(before!.stock);
  });

  it("refunded units cannot be returned again", async () => {
    const o = await withAdmin();
    const made = (await o.lodge()).body.data;
    await o.a.post(`/admin/returns/${made.id}/confirm`, {});
    await o.a.post(`/admin/returns/${made.id}/complete`, { refundKobo: 1_500_000 });
    const again = await o.lodge();
    expect(again.status).toBe(422);
    expect(again.body.error.message).toMatch(/already been refunded/);
  });

  it("flags a confirmed case that passes its 7 working day refund deadline, to the team, once", async () => {
    const o = await withAdmin();
    const staff = (await asUser(o.admin.bearer).post("/admin/staff", { name: "Support Person", email: "support@example.com", phone: "08031234567", password: "Passw0rdTest", role: "STAFF", staffTitle: "CUSTOMER_SUPPORT" })).body.data;
    const made = (await o.lodge()).body.data;
    await o.a.post(`/admin/returns/${made.id}/confirm`, {});
    expect(await flagOverdueReturns()).toBe(0); // still inside the window

    await ReturnRequest.updateOne({ _id: made.id }, { windowEndsAt: new Date(Date.now() - 1000) });
    const listed = (await o.a.get("/admin/returns?group=window")).body.data[0];
    expect(listed).toMatchObject({ windowState: "ENDED", windowWorkingDaysLeft: null });
    expect((await o.a.get("/admin/returns/counts")).body.data).toMatchObject({ window: 1, overdue: 1 });

    expect(await flagOverdueReturns()).toBe(1);
    expect(await flagOverdueReturns()).toBe(0); // only once
    expect(await Notification.countDocuments({ userId: staff.id, kind: "RETURN_OVERDUE" })).toBe(1);
    expect((await o.a.post(`/admin/returns/${made.id}/complete`, { refundKobo: 1_500_000 })).status).toBe(200); // it can still be finished
  });

  it("is for staff who handle orders (super admin, finance, support, operations) and not for others", async () => {
    const o = await withAdmin();
    const made = (await o.lodge()).body.data;
    const staff = (title: string, email: string) => asUser(o.admin.bearer).post("/admin/staff", { name: "Some Manager", email, phone: "08031234567", password: "Passw0rdTest", role: "STAFF", staffTitle: title });
    await staff("CUSTOMER_SUPPORT", "support@example.com");
    await staff("VENDOR_MANAGER", "vendor-mgr@example.com");
    expect((await asUser(await loginToken("support@example.com")).get("/admin/returns")).status).toBe(200);
    expect((await asUser(await loginToken("vendor-mgr@example.com")).get("/admin/returns")).status).toBe(403);
    expect((await asUser(await loginToken("vendor-mgr@example.com")).get("/admin/returns/counts")).status).toBe(403);
    expect((await asUser(await loginToken("vendor-mgr@example.com")).post(`/admin/returns/${made.id}/confirm`, {})).status).toBe(403);
    expect((await o.c.get("/admin/returns")).status).toBe(403);
    expect((await asUser(o.vendorTokens.bodija).get("/admin/returns")).status).toBe(403);
    expect((await api().get("/api/admin/returns")).status).toBe(401);
    expect((await asUser(await loginToken("support@example.com")).post(`/admin/returns/${made.id}/confirm`, {})).status).toBe(200);
  });
});

describe("what a return does to the vendor's earnings", () => {
  it("keeps them on hold while a case is open, even after the 4 working days, and says so to the vendor", async () => {
    const o = await order();
    await o.deliver();
    await o.lodge();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { deliveredAt: new Date(Date.now() - 12 * DAY) }); // the hold would be over by now

    expect(await SubOrder.countDocuments(availableFilter(o.bodija.vendor._id, new Date(), []))).toBe(0);
    const { summary, results } = await loadEarnings(o.bodija.vendor._id);
    expect(summary).toMatchObject({ availableKobo: 0, onHoldKobo: 1_350_000, onHoldOrders: 1, nextUnlockAt: null });
    expect(results.get(String(o.bodijaSub._id))).toEqual({ state: "ON_HOLD", heldForReturn: true });
    await expect(requestPayout(o.bodija.vendor, o.bodija.user)).rejects.toMatchObject({ status: 409 });

    const view = await asUser(o.vendorTokens.bodija).get("/vendor/orders?group=done");
    expect(view.body.data.orders[0]).toMatchObject({ returnHold: true, returnedEarningKobo: 0, netEarningKobo: 1_350_000 });
  });

  it("releases them in full when the case is rejected or cancelled", async () => {
    const o = await order();
    await o.deliver();
    const admin = await createAdmin();
    const made = (await o.lodge()).body.data;
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { deliveredAt: new Date(Date.now() - 12 * DAY) });
    await asUser(admin.bearer).post(`/admin/returns/${made.id}/reject`, { reason: "Not eligible for return." });

    expect((await loadEarnings(o.bodija.vendor._id)).summary).toMatchObject({ availableKobo: 1_350_000, onHoldOrders: 0 });
    const payout = await requestPayout(o.bodija.vendor, o.bodija.user);
    expect(payout.amountKobo).toBe(1_350_000);
  });

  it("takes the refunded items' earnings off when the case is completed, and a fully refunded delivery leaves nothing to withdraw", async () => {
    const o = await order();
    await o.deliver();
    const admin = await createAdmin();
    const made = (await o.lodge()).body.data;
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { deliveredAt: new Date(Date.now() - 12 * DAY) });
    await asUser(admin.bearer).post(`/admin/returns/${made.id}/confirm`, {});
    await asUser(admin.bearer).post(`/admin/returns/${made.id}/complete`, { refundKobo: 1_500_000 });

    const { summary } = await loadEarnings(o.bodija.vendor._id);
    expect(summary.availableKobo).toBe(0);
    expect(summary.onHoldKobo).toBe(0);
    await expect(requestPayout(o.bodija.vendor, o.bodija.user)).rejects.toMatchObject({ status: 409 });
    expect(await SubOrder.findById(o.bodijaSub._id).then((s) => s!.payoutId)).toBeFalsy(); // nothing was left locked
    const view = await asUser(o.vendorTokens.bodija).get("/vendor/orders?group=done");
    expect(view.body.data.orders[0]).toMatchObject({ returnHold: false, returnedEarningKobo: 1_350_000, netEarningKobo: 0 });
  });

  it("does not hold other deliveries of the same vendor", async () => {
    const o = await order();
    await o.deliver();
    await o.lodge();
    expect(await SubOrder.findById(o.ojabaSub._id)).toMatchObject({ returnHold: false });
  });
});
