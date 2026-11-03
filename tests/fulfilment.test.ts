import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Order } from "../src/models/Order.js";
import { Product } from "../src/models/Product.js";
import { StatusLog } from "../src/models/StatusLog.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { User } from "../src/models/User.js";
import { Vendor } from "../src/models/Vendor.js";
import { completeDeliveredOrders } from "../src/modules/orders/subOrderTransitions.js";
import { PASSWORD, api, clearDb, createUser, fakeDistance, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { createAdmin, createHandler, emailLog, asUser, paidOrder, reload } from "./fulfilmentHelpers.js";
import { fakeGateway } from "./paymentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  fakeDistance.reset();
  fakeGateway.reset();
  emailLog.reset();
});

describe("vendor orders", () => {
  it("shows a vendor only their own paid sub-orders, with counts per tab", async () => {
    const o = await paidOrder();
    const bodija = asUser(o.vendorTokens.bodija);
    const res = await bodija.get("/vendor/orders");
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toEqual({ todo: 1, active: 0, done: 0, problem: 0 });
    expect(res.body.data.orders).toHaveLength(1);
    expect(res.body.data.orders[0]).toMatchObject({ ref: o.bodijaSub.ref, status: "PAID", items: [expect.objectContaining({ name: "Omosalewa Bean Flour", qty: 1 })], vendorEarningKobo: 1350000 });

    const ojaba = await asUser(o.vendorTokens.ojaba).get("/vendor/orders");
    expect(ojaba.body.data.orders.map((x: { ref: string }) => x.ref)).toEqual([o.ojabaSub.ref]);
  });

  it("never shows unpaid or expired orders", async () => {
    const o = await paidOrder();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "PENDING_PAYMENT" });
    expect((await asUser(o.vendorTokens.bodija).get("/vendor/orders")).body.data.orders).toEqual([]);
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "CANCELLED" });
    // A cancelled one is a "problem" tab item only if it was paid; here it shows there, never under "todo".
    expect((await asUser(o.vendorTokens.bodija).get("/vendor/orders?group=todo")).body.data.orders).toEqual([]);
  });

  it("gives the vendor what they need to pack, without the customer's phone, email or address", async () => {
    const o = await paidOrder();
    const res = await asUser(o.vendorTokens.bodija).get("/vendor/orders");
    const text = JSON.stringify(res.body);
    expect(res.body.data.orders[0].customerFirstName).toBe("CUSTOMER");
    for (const secret of [o.customer.email, "08030000000", "Awolowo", "Old Bodija", "landmark", "lat", "lng", "deliveryFee", "feeKobo", "distance"]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("lets a vendor mark their own order ready for pickup, and logs who did it", async () => {
    const o = await paidOrder();
    const res = await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.bodijaSub._id}/ready`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("READY_FOR_PICKUP");
    expect((await reload(o.bodijaSub)).status).toBe("READY_FOR_PICKUP");

    const log = (await StatusLog.findOne({ subOrderId: o.bodijaSub._id, to: "READY_FOR_PICKUP" }))!;
    expect(log).toMatchObject({ from: "PAID", actorRole: "VENDOR" });
    expect(String(log.actorId)).toBe(String(o.bodija.user._id));
    // The other vendor's part of the same order is untouched.
    expect((await reload(o.ojabaSub)).status).toBe("PAID");
  });

  it("treats another vendor's order as not found, and changes nothing", async () => {
    const o = await paidOrder();
    const res = await asUser(o.vendorTokens.ojaba).post(`/vendor/orders/${o.bodijaSub._id}/ready`);
    expect(res.status).toBe(404);
    expect((await reload(o.bodijaSub)).status).toBe("PAID");
  });

  it("refuses to mark an order ready twice, or one that is not paid", async () => {
    const o = await paidOrder();
    const bodija = asUser(o.vendorTokens.bodija);
    await bodija.post(`/vendor/orders/${o.bodijaSub._id}/ready`);
    const again = await bodija.post(`/vendor/orders/${o.bodijaSub._id}/ready`);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/ready for pickup/);
    expect(await StatusLog.countDocuments({ subOrderId: o.bodijaSub._id, to: "READY_FOR_PICKUP" })).toBe(1);

    await SubOrder.updateOne({ _id: o.ojabaSub._id }, { status: "PENDING_PAYMENT" });
    expect((await asUser(o.vendorTokens.ojaba).post(`/vendor/orders/${o.ojabaSub._id}/ready`)).status).toBe(404);
  });

  it("blocks a suspended vendor from marking orders ready", async () => {
    const o = await paidOrder();
    await Vendor.updateOne({ _id: o.bodija.vendor._id }, { status: "SUSPENDED" });
    expect((await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.bodijaSub._id}/ready`)).status).toBe(403);
  });

  it("is for vendors only", async () => {
    const o = await paidOrder();
    expect((await api().get("/api/vendor/orders")).status).toBe(401);
    expect((await asUser(o.customer.bearer).get("/vendor/orders")).status).toBe(403);
    expect((await asUser((await createHandler()).bearer).get("/vendor/orders")).status).toBe(403);
    expect((await asUser((await createAdmin()).bearer).post(`/vendor/orders/${o.bodijaSub._id}/ready`)).status).toBe(403);
  });

  it("includes the number of orders to pack in the overview, for the sidebar badge", async () => {
    const o = await paidOrder();
    expect((await asUser(o.vendorTokens.bodija).get("/vendor/overview")).body.data.counts.toPrepare).toBe(1);
    await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.bodijaSub._id}/ready`);
    expect((await asUser(o.vendorTokens.bodija).get("/vendor/overview")).body.data.counts.toPrepare).toBe(0);
  });
});

describe("admin assigns handlers", () => {
  it("assigns a handler to a paid sub-order", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const rider = await createHandler();
    const res = await asUser(admin.bearer).post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(rider.user._id) });
    expect(res.status).toBe(200);
    expect(res.body.data.handler).toMatchObject({ id: String(rider.user._id) });
    expect(String((await reload(o.bodijaSub)).handlerId)).toBe(String(rider.user._id));
  });

  it("rejects an id that is not a handler, a deactivated handler, and an unknown order", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const a = asUser(admin.bearer);
    expect((await a.post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(o.customer.user._id) })).status).toBe(422);
    expect((await a.post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(admin.user._id) })).status).toBe(422);
    const rider = await createHandler();
    await User.updateOne({ _id: rider.user._id }, { isActive: false });
    expect((await a.post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(rider.user._id) })).status).toBe(422);
    const active = await createHandler("active@example.com");
    expect((await a.post(`/admin/sub-orders/${"a".repeat(24)}/assign`, { handlerId: String(active.user._id) })).status).toBe(404);
    expect((await reload(o.bodijaSub)).handlerId).toBeUndefined();
  });

  it("will not assign before payment or after the parcel is on the road", async () => {
    const o = await paidOrder();
    const admin = asUser((await createAdmin()).bearer);
    const rider = await createHandler();
    const body = { handlerId: String(rider.user._id) };

    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "PENDING_PAYMENT" });
    expect((await admin.post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, body)).status).toBe(409);
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "PICKED_UP" });
    expect((await admin.post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, body)).status).toBe(409);
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "DELIVERED" });
    expect((await admin.post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, body)).status).toBe(409);
  });

  it("lets the admin reassign before pickup", async () => {
    const o = await paidOrder();
    const admin = asUser((await createAdmin()).bearer);
    const one = await createHandler("one@example.com");
    const two = await createHandler("two@example.com");
    await admin.post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(one.user._id) });
    await admin.post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(two.user._id) });
    expect(String((await reload(o.bodijaSub)).handlerId)).toBe(String(two.user._id));
    expect((await asUser(one.bearer).get("/handler/deliveries")).body.data.deliveries).toEqual([]);
    expect((await asUser(two.bearer).get("/handler/deliveries")).body.data.deliveries).toHaveLength(1);
  });

  it("is for admins only", async () => {
    const o = await paidOrder();
    const rider = await createHandler();
    const body = { handlerId: String(rider.user._id) };
    expect((await api().post(`/api/admin/sub-orders/${o.bodijaSub._id}/assign`).send(body)).status).toBe(401);
    for (const bearer of [o.customer.bearer, o.vendorTokens.bodija, rider.bearer]) {
      expect((await asUser(bearer).post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, body)).status).toBe(403);
      expect((await asUser(bearer).get("/admin/deliveries")).status).toBe(403);
    }
    expect((await reload(o.bodijaSub)).handlerId).toBeUndefined();
  });

  it("lists deliveries by group with counts: needs handler, active, problems, done", async () => {
    const o = await paidOrder();
    const admin = asUser((await createAdmin()).bearer);
    const rider = await createHandler();
    const first = await admin.get("/admin/deliveries");
    expect(first.body.data.counts).toMatchObject({ needs_handler: 2, active: 2, problem: 0, done: 0, all: 2 });
    expect(first.body.data.deliveries[0]).toMatchObject({ status: "PAID", handler: null });
    expect(first.body.data.deliveries[0].customerName).toBeTruthy();

    await admin.post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(rider.user._id) });
    const after = await admin.get("/admin/deliveries");
    expect(after.body.data.counts.needs_handler).toBe(1);
    expect(after.body.data.deliveries.map((d: { ref: string }) => d.ref)).toEqual([o.ojabaSub.ref]);
    const active = await admin.get("/admin/deliveries?group=active");
    expect(active.body.data.deliveries.find((d: { ref: string }) => d.ref === o.bodijaSub.ref).handler.name).toBe("HANDLER User");

    const found = await admin.get(`/admin/deliveries?group=all&q=${o.bodijaSub.ref}`);
    expect(found.body.data.deliveries).toHaveLength(1);
  });
});

describe("the delivery handler's work", () => {
  async function assigned() {
    const o = await paidOrder();
    const admin = await createAdmin();
    const rider = await createHandler();
    await asUser(admin.bearer).post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(rider.user._id) });
    return { ...o, admin, rider, h: asUser(rider.bearer), subId: String(o.bodijaSub._id) };
  }

  it("sees only deliveries assigned to them", async () => {
    const o = await assigned();
    const other = await createHandler("other@example.com");
    const mine = await o.h.get("/handler/deliveries");
    expect(mine.body.data.deliveries.map((d: { id: string }) => d.id)).toEqual([o.subId]);
    expect(mine.body.data.counts).toEqual({ active: 1, done: 0 });
    expect((await asUser(other.bearer).get("/handler/deliveries")).body.data.deliveries).toEqual([]);
    // The other vendor's unassigned sub-order is invisible and untouchable too.
    expect((await o.h.get(`/handler/deliveries/${o.ojabaSub._id}`)).status).toBe(404);
    expect((await o.h.post(`/handler/deliveries/${o.ojabaSub._id}/status`, { to: "PICKED_UP" })).status).toBe(404);
  });

  it("treats another handler's delivery as not found, for reading and for changing", async () => {
    const o = await assigned();
    const other = asUser((await createHandler("other@example.com")).bearer);
    expect((await other.get(`/handler/deliveries/${o.subId}`)).status).toBe(404);
    expect((await other.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" })).status).toBe(404);
    expect((await reload(o.bodijaSub)).status).toBe("PAID");
  });

  it("shows pickup and drop-off details, phones and what is in the box, but no prices", async () => {
    const o = await assigned();
    const res = await o.h.get(`/handler/deliveries/${o.subId}`);
    expect(res.body.data).toMatchObject({
      ref: o.bodijaSub.ref,
      status: "PAID",
      waitingForVendor: true,
      nextActions: [],
      pickup: { businessName: "Bodija Provisions", phone: "08031234567", lat: expect.any(Number), lng: expect.any(Number) },
      dropoff: { customerName: "CUSTOMER User", phone: "08030000000", line: "12 Awolowo Avenue, Old Bodija, Ibadan", landmark: "opposite Bodija Market gate" },
      distanceKm: "3.2",
      items: [{ name: "Omosalewa Bean Flour", qty: 1 }],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/Kobo|commission|earning|payment|email/i);
  });

  it("cannot pick up until the vendor has marked it ready", async () => {
    const o = await assigned();
    const res = await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/paid and waiting to be packed/);
    expect((await reload(o.bodijaSub)).status).toBe("PAID");
  });

  it("walks the happy path: picked up, then delivered, with deliveredAt and a log for each step", async () => {
    const o = await assigned();
    await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.subId}/ready`);
    expect((await o.h.get(`/handler/deliveries/${o.subId}`)).body.data.nextActions).toEqual(["PICKED_UP"]);

    const pick = await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" });
    expect(pick.body.data).toMatchObject({ status: "PICKED_UP", nextActions: expect.arrayContaining(["DELIVERED", "FAILED_DELIVERY"]) });

    const before = Date.now();
    const done = await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "DELIVERED" });
    expect(done.body.data.status).toBe("DELIVERED");
    const sub = await reload(o.bodijaSub);
    expect(sub.deliveredAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(sub.deliveredAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const logs = await StatusLog.find({ subOrderId: o.bodijaSub._id }).sort({ at: 1 });
    expect(logs.map((l) => `${l.from ?? "-"}>${l.to}:${l.actorRole}`)).toEqual([
      "->PENDING_PAYMENT:CUSTOMER",
      "PENDING_PAYMENT>PAID:SYSTEM",
      "PAID>READY_FOR_PICKUP:VENDOR",
      "READY_FOR_PICKUP>PICKED_UP:HANDLER",
      "PICKED_UP>DELIVERED:HANDLER",
    ]);
    expect(String(logs.at(-1)!.actorId)).toBe(String(o.rider.user._id));
  });

  it("cannot deliver without picking up, or change a delivered order", async () => {
    const o = await assigned();
    await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.subId}/ready`);
    expect((await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "DELIVERED" })).status).toBe(409);
    await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" });
    await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "DELIVERED" });
    for (const to of ["PICKED_UP", "DELIVERED", "FAILED_DELIVERY"]) {
      expect((await o.h.post(`/handler/deliveries/${o.subId}/status`, { to, reason: "too late to change" })).status, to).toBe(409);
    }
    expect((await reload(o.bodijaSub)).status).toBe("DELIVERED");
  });

  it("must give a reason to report a failed delivery, and the reason is recorded", async () => {
    const o = await assigned();
    await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.subId}/ready`);
    await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" });
    expect((await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "FAILED_DELIVERY" })).status).toBe(422);
    expect((await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "FAILED_DELIVERY", reason: "x" })).status).toBe(422);
    expect((await reload(o.bodijaSub)).status).toBe("PICKED_UP");

    const res = await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "FAILED_DELIVERY", reason: "Customer did not pick up the phone" });
    expect(res.body.data).toMatchObject({ status: "FAILED_DELIVERY", failureReason: "Customer did not pick up the phone" });
    expect((await StatusLog.findOne({ subOrderId: o.bodijaSub._id, to: "FAILED_DELIVERY" }))!.note).toBe("Customer did not pick up the phone");
  });

  it("can only ask for the three outcomes a handler owns", async () => {
    const o = await assigned();
    for (const to of ["READY_FOR_PICKUP", "CANCELLED", "COMPLETED", "PAID", "PENDING_PAYMENT", "nonsense"]) {
      expect((await o.h.post(`/handler/deliveries/${o.subId}/status`, { to })).status, to).toBe(422);
    }
    expect((await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP", status: "DELIVERED" })).status).toBe(422);
  });

  it("lets only one of two simultaneous taps succeed", async () => {
    const o = await assigned();
    await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.subId}/ready`);
    const results = await Promise.all([1, 2, 3].map(() => o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await StatusLog.countDocuments({ subOrderId: o.bodijaSub._id, to: "PICKED_UP" })).toBe(1);
  });

  it("moves finished deliveries to the done tab", async () => {
    const o = await assigned();
    await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.subId}/ready`);
    await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" });
    await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "DELIVERED" });
    expect((await o.h.get("/handler/deliveries")).body.data.counts).toEqual({ active: 0, done: 1 });
    expect((await o.h.get("/handler/deliveries?group=done")).body.data.deliveries.map((d: { id: string }) => d.id)).toEqual([o.subId]);
  });

  it("is for handlers only", async () => {
    const o = await assigned();
    expect((await api().get("/api/handler/deliveries")).status).toBe(401);
    for (const bearer of [o.customer.bearer, o.vendorTokens.bodija, o.admin.bearer]) {
      expect((await asUser(bearer).get("/handler/deliveries")).status).toBe(403);
      expect((await asUser(bearer).get(`/handler/deliveries/${o.subId}`)).status).toBe(403);
      expect((await asUser(bearer).post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" })).status).toBe(403);
    }
  });

  it("shows the customer the progress on their order page", async () => {
    const o = await assigned();
    await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.subId}/ready`);
    await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" });
    const res = await asUser(o.customer.bearer).get(`/orders/${o.data.orderId}`);
    const sub = res.body.data.subOrders.find((s: { ref: string }) => s.ref === o.bodijaSub.ref);
    expect(sub.status).toBe("PICKED_UP");
    expect(sub.timeline.map((t: { status: string }) => t.status)).toEqual(["PENDING_PAYMENT", "PAID", "READY_FOR_PICKUP", "PICKED_UP"]);
  });
});

describe("admin cancel and retry", () => {
  async function ready() {
    const o = await paidOrder();
    const admin = await createAdmin();
    return { ...o, a: asUser(admin.bearer), subId: String(o.bodijaSub._id) };
  }

  it("cancels a paid sub-order: stock goes back, the order is flagged for a refund, and it is logged", async () => {
    const o = await ready();
    expect((await Product.findById(o.flour._id))!.stock).toBe(9);
    const res = await o.a.post(`/admin/sub-orders/${o.subId}/status`, { to: "CANCELLED", note: "Vendor ran out" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("CANCELLED");
    expect((await Product.findById(o.flour._id))!.stock).toBe(10);

    const order = await reloadOrderDoc(o.order._id);
    expect(order.needsAttention).toBe(true);
    expect(order.attentionReason).toMatch(/cancelled after payment/);
    expect(order.attentionReason).toMatch(/Refund 15640 naira/); // N15,000 items + N640 delivery
    expect(order.status).toBe("PAID"); // the other vendor's part is still going ahead
    const log = (await StatusLog.findOne({ subOrderId: o.bodijaSub._id, to: "CANCELLED" }))!;
    expect(log).toMatchObject({ from: "PAID", actorRole: "ADMIN", note: "Vendor ran out" });
  });

  it("cannot cancel something already on the road or delivered", async () => {
    const o = await ready();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "PICKED_UP" });
    expect((await o.a.post(`/admin/sub-orders/${o.subId}/status`, { to: "CANCELLED" })).status).toBe(409);
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "DELIVERED" });
    expect((await o.a.post(`/admin/sub-orders/${o.subId}/status`, { to: "CANCELLED" })).status).toBe(409);
  });

  it("retries a failed delivery (back to picked up, failure reason cleared) or cancels it", async () => {
    const o = await ready();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "FAILED_DELIVERY", failureReason: "Nobody home" });
    const retry = await o.a.post(`/admin/sub-orders/${o.subId}/status`, { to: "PICKED_UP" });
    expect(retry.body.data.status).toBe("PICKED_UP");
    expect((await reload(o.bodijaSub)).failureReason).toBeUndefined();

    await SubOrder.updateOne({ _id: o.ojabaSub._id }, { status: "FAILED_DELIVERY", failureReason: "Wrong address" });
    expect((await o.a.post(`/admin/sub-orders/${o.ojabaSub._id}/status`, { to: "CANCELLED" })).body.data.status).toBe("CANCELLED");
  });

  it("only allows cancel and retry, and not by anyone else", async () => {
    const o = await ready();
    for (const to of ["DELIVERED", "READY_FOR_PICKUP", "PAID", "COMPLETED"]) expect((await o.a.post(`/admin/sub-orders/${o.subId}/status`, { to })).status, to).toBe(422);
    expect((await asUser(o.vendorTokens.bodija).post(`/admin/sub-orders/${o.subId}/status`, { to: "CANCELLED" })).status).toBe(403);
    expect((await asUser(o.customer.bearer).post(`/admin/sub-orders/${o.subId}/status`, { to: "CANCELLED" })).status).toBe(403);
    expect((await reload(o.bodijaSub)).status).toBe("PAID");
  });
});

describe("staff accounts", () => {
  const body = (over: Record<string, unknown> = {}) => ({ name: "Femi Rider", email: "femi@example.com", phone: "08051112222", password: PASSWORD, ...over });

  it("creates a delivery handler who can sign in and lands on /handler", async () => {
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).post("/admin/staff", body());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ role: "HANDLER", email: "femi@example.com", isActive: true, activeDeliveries: 0 });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
    expect(String((await User.findOne({ email: "femi@example.com" }))!.createdBy)).toBe(String(admin.user._id));

    const login = await api().post("/api/auth/login").send({ email: "femi@example.com", password: PASSWORD });
    expect(login.body.data).toMatchObject({ home: "/handler", user: { role: "HANDLER" } });
  });

  it("makes a handler unless an administrator is asked for, and no other role can be made here", async () => {
    const admin = asUser((await createAdmin()).bearer);
    for (const role of ["CUSTOMER", "VENDOR", "admin", "SUPERUSER", "", null]) {
      expect((await admin.post("/admin/staff", body({ role }))).status, String(role)).toBe(422);
    }
    expect(await User.countDocuments({ email: "femi@example.com" })).toBe(0);
    expect((await admin.post("/admin/staff", body({ role: "HANDLER" }))).body.data.role).toBe("HANDLER");
  });

  it("rejects duplicates and weak input", async () => {
    const admin = asUser((await createAdmin()).bearer);
    expect((await admin.post("/admin/staff", body())).status).toBe(201);
    expect((await admin.post("/admin/staff", body())).status).toBe(409);
    expect((await admin.post("/admin/staff", body({ email: "b@example.com", password: "short" }))).status).toBe(422);
    expect((await admin.post("/admin/staff", body({ email: "c@example.com", phone: "123" }))).status).toBe(422);
  });

  it("lists handlers with their current workload", async () => {
    const o = await paidOrder();
    const admin = asUser((await createAdmin()).bearer);
    const rider = await createHandler();
    await admin.post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(rider.user._id) });
    await admin.post(`/admin/sub-orders/${o.ojabaSub._id}/assign`, { handlerId: String(rider.user._id) });
    const list = await admin.get("/admin/staff");
    expect(list.body.data.find((m: { email: string }) => m.email === rider.email)).toMatchObject({ role: "HANDLER", activeDeliveries: 2 });
  });

  it("deactivating a handler stops new logins and ends the current session at once", async () => {
    const admin = asUser((await createAdmin()).bearer);
    const rider = await createHandler();
    expect((await asUser(rider.bearer).get("/handler/deliveries")).status).toBe(200);
    const res = await admin.patch(`/admin/staff/${rider.user._id}`, { isActive: false });
    expect(res.body.data.isActive).toBe(false);
    expect((await asUser(rider.bearer).get("/handler/deliveries")).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: rider.email, password: PASSWORD })).status).toBe(403);
    await admin.patch(`/admin/staff/${rider.user._id}`, { isActive: true });
    expect((await api().post("/api/auth/login").send({ email: rider.email, password: PASSWORD })).status).toBe(200);
  });

  it("cannot be used to change a customer or a vendor", async () => {
    const admin = await createAdmin();
    const customer = await createUser("CUSTOMER", "c@example.com");
    const vendor = await createUser("VENDOR", "v@example.com");
    for (const id of [customer._id, vendor._id]) {
      expect((await asUser(admin.bearer).patch(`/admin/staff/${id}`, { isActive: false })).status).toBe(404);
    }
    expect((await User.findById(customer._id))!.isActive).toBe(true);
    expect((await User.findById(vendor._id))!.isActive).toBe(true);
  });

  it("is for admins only", async () => {
    const o = await paidOrder();
    for (const bearer of [o.customer.bearer, o.vendorTokens.bodija, (await createHandler()).bearer]) {
      expect((await asUser(bearer).post("/admin/staff", body())).status).toBe(403);
      expect((await asUser(bearer).get("/admin/staff")).status).toBe(403);
    }
    expect((await api().post("/api/admin/staff").send(body())).status).toBe(401);
  });
});

describe("completing delivered orders after the hold (4 working days)", () => {
  async function deliveredAt(daysAgo: number) {
    const o = await paidOrder();
    const when = new Date(Date.now() - daysAgo * 86_400_000);
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "DELIVERED", deliveredAt: when });
    return { ...o, when };
  }

  it("completes an order delivered long ago, and logs it as the system", async () => {
    const o = await deliveredAt(10);
    expect(await completeDeliveredOrders()).toBe(1);
    const sub = await reload(o.bodijaSub);
    expect(sub.status).toBe("COMPLETED");
    expect(sub.completedAt).toBeInstanceOf(Date);
    expect(await StatusLog.findOne({ subOrderId: o.bodijaSub._id, to: "COMPLETED" })).toMatchObject({ from: "DELIVERED", actorRole: "SYSTEM" });
  });

  it("leaves an order delivered a day ago alone, and one delivered the minute before the hold ends", async () => {
    const o = await paidOrder();
    // Delivered Thursday 15 Oct 2026; the hold ends Wednesday 21 Oct at the same time.
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "DELIVERED", deliveredAt: new Date("2026-10-15T10:00:00.000Z") });
    expect(await completeDeliveredOrders(new Date("2026-10-16T10:00:00.000Z"))).toBe(0);
    expect(await completeDeliveredOrders(new Date("2026-10-21T09:59:59.999Z"))).toBe(0);
    expect((await reload(o.bodijaSub)).status).toBe("DELIVERED");
  });

  it("completes at exactly the moment the hold ends", async () => {
    const o = await paidOrder();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "DELIVERED", deliveredAt: new Date("2026-10-15T10:00:00.000Z") });
    expect(await completeDeliveredOrders(new Date("2026-10-21T10:00:00.000Z"))).toBe(1);
    expect((await reload(o.bodijaSub)).status).toBe("COMPLETED");
  });

  it("only touches delivered orders, and is safe to run again and again", async () => {
    const o = await deliveredAt(12);
    await SubOrder.updateOne({ _id: o.ojabaSub._id }, { status: "PICKED_UP" });
    expect(await completeDeliveredOrders()).toBe(1);
    expect(await completeDeliveredOrders()).toBe(0);
    expect(await completeDeliveredOrders()).toBe(0);
    expect((await reload(o.ojabaSub)).status).toBe("PICKED_UP");
    expect(await StatusLog.countDocuments({ subOrderId: o.bodijaSub._id, to: "COMPLETED" })).toBe(1);
  });

  it("does not complete anything when two sweeps overlap more than once", async () => {
    const o = await deliveredAt(14);
    const counts = await Promise.all([completeDeliveredOrders(), completeDeliveredOrders(), completeDeliveredOrders()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await StatusLog.countDocuments({ subOrderId: o.bodijaSub._id, to: "COMPLETED" })).toBe(1);
  });
});

const reloadOrderDoc = (id: unknown) => Order.findById(id).then((x) => x!);
