import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Order } from "../src/models/Order.js";
import { StatusLog } from "../src/models/StatusLog.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { User } from "../src/models/User.js";
import { ensureAdmin } from "../src/seed/admin.js";
import { DEMO_EMAIL_DOMAIN, seedDemoData } from "../src/seed/demo.js";
import { holdEndsAt } from "../src/domain/earnings.js";
import { seedDemoOrders } from "../src/seed/demoOrders.js";
import { api, clearDb, loginToken, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser } from "./fulfilmentHelpers.js";

const PASSWORD = "Demo12345";
const HOUR = 3_600_000;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

async function seedAll() {
  await seedDemoData(PASSWORD);
  return seedDemoOrders();
}

describe("the starting data set", () => {
  it("creates the demo orders once and leaves them alone on a second run", async () => {
    expect(await seedAll()).toBe(9);
    expect(await Order.countDocuments()).toBe(9);
    const subs = await SubOrder.countDocuments();

    expect(await seedDemoOrders()).toBe(0);
    expect(await seedDemoData(PASSWORD)).toEqual({ users: 0, vendors: 0, products: 0 });
    expect(await Order.countDocuments()).toBe(9);
    expect(await SubOrder.countDocuments()).toBe(subs);
  });

  it("does nothing when the demo stores have not been loaded", async () => {
    expect(await seedDemoOrders()).toBe(0);
    expect(await Order.countDocuments()).toBe(0);
  });

  it("adds up to the kobo: order totals, deliveries, commission and what each vendor earns", async () => {
    await seedAll();
    for (const order of await Order.find()) {
      const subs = await SubOrder.find({ orderId: order._id });
      expect(order.status).toBe("PAID");
      expect(order.payment!.amountKobo).toBe(order.totalKobo);
      expect(order.itemsSubtotalKobo + order.deliveryTotalKobo).toBe(order.totalKobo);
      expect(subs.reduce((n, s) => n + s.itemsTotalKobo, 0)).toBe(order.itemsSubtotalKobo);
      expect(subs.reduce((n, s) => n + s.delivery!.feeKobo, 0)).toBe(order.deliveryTotalKobo);
      for (const s of subs) {
        expect(s.commissionTotalKobo + s.vendorEarningKobo).toBe(s.itemsTotalKobo);
        expect(s.items.reduce((n, i) => n + i.lineTotalKobo, 0)).toBe(s.itemsTotalKobo);
        expect(s.items.reduce((n, i) => n + i.vendorEarningKobo, 0)).toBe(s.vendorEarningKobo);
        expect(s.commissionBps).toBe(order.pricing!.commissionBps);
      }
    }
  });

  it("logs every status change, in order, ending at the delivery's current status", async () => {
    await seedAll();
    for (const sub of await SubOrder.find()) {
      const logs = await StatusLog.find({ subOrderId: sub._id }).sort({ at: 1 });
      expect(logs[0]).toMatchObject({ from: null, to: "PENDING_PAYMENT", actorRole: "CUSTOMER" });
      for (let i = 1; i < logs.length; i++) expect(logs[i]!.from, `${sub.ref} step ${i}`).toBe(logs[i - 1]!.to);
      expect(logs.at(-1)!.to).toBe(sub.status);
    }
  });

  it("completes a delivery exactly when its hold (4 working days) ends", async () => {
    await seedAll();
    const done = await SubOrder.find({ status: "COMPLETED" });
    expect(done.length).toBeGreaterThan(0);
    for (const s of done) expect(s.completedAt!.getTime()).toBe(holdEndsAt(s.deliveredAt!).getTime());
    for (const s of await SubOrder.find({ status: "DELIVERED" })) expect(Date.now() - s.deliveredAt!.getTime()).toBeLessThan(24 * HOUR);
  });

  it("gives a store money that is available, on hold and on its way, and the vendor can request a payout", async () => {
    await seedAll();
    const bearer = await loginToken(`vendor@${DEMO_EMAIL_DOMAIN}`, PASSWORD);
    const summary = (await asUser(bearer).get("/vendor/earnings")).body.data.summary;
    expect(summary.availableKobo).toBeGreaterThan(0);
    expect(summary.onHoldKobo).toBeGreaterThan(0);
    expect(summary.awaitingKobo).toBeGreaterThan(0);

    const res = await asUser(bearer).post("/vendor/payouts");
    expect(res.status).toBe(201);
    expect(res.body.data.amountKobo).toBe(summary.availableKobo);
  });

  it("fills the admin dashboard and leaves one delivery waiting for a handler", async () => {
    await seedAll();
    await ensureAdmin({ email: "admin@example.com", password: PASSWORD });
    const bearer = await loginToken("admin@example.com", PASSWORD);
    const o = (await asUser(bearer).get("/admin/overview")).body.data;
    expect(o.sales.orders).toBe(9);
    expect(o.commissionKobo).toBeGreaterThan(0);
    expect(o.deliveries.needsHandler).toBe(1);
    expect(o.deliveries.inProgress).toBeGreaterThanOrEqual(3);
    expect(o.vendors.approved).toBe(2);
    expect(o.last7Days.reduce((n: number, d: { orders: number }) => n + d.orders, 0)).toBeGreaterThanOrEqual(4); // the 4 recent orders are always inside the window; a finished one is older (it waits out the 4 working day hold) and can fall just outside it, on a Tuesday or early on a Wednesday
  });

  it("shows the seeded orders to the customer, with the handler only on the deliveries assigned to them", async () => {
    await seedAll();
    const customer = await loginToken(`customer@${DEMO_EMAIL_DOMAIN}`, PASSWORD);
    expect((await asUser(customer).get("/orders")).body.data.length).toBeGreaterThan(0);

    const handler = await User.findOne({ email: `handler@${DEMO_EMAIL_DOMAIN}` });
    const bearer = await loginToken(`handler@${DEMO_EMAIL_DOMAIN}`, PASSWORD);
    const res = await asUser(bearer).get("/handler/deliveries?limit=30");
    expect(res.status).toBe(200);
    const { active, done } = res.body.data.counts;
    expect(active).toBeGreaterThan(0);
    expect(done).toBeGreaterThan(0);
    // Everything the handler is shown is assigned to them: the unassigned delivery never appears.
    const assigned = await SubOrder.find({ handlerId: handler!._id }).select("ref");
    const unassigned = await SubOrder.find({ handlerId: null }).select("ref");
    expect(unassigned.length).toBe(1);
    const shown = res.body.data.deliveries.map((d: { ref: string }) => d.ref);
    for (const ref of shown) expect(assigned.map((s) => s.ref)).toContain(ref);
    expect(shown).not.toContain(unassigned[0]!.ref);
  });
});

describe("the admin account seed", () => {
  it("creates the admin, then only resets the password on a second run", async () => {
    expect(await ensureAdmin({ email: "Boss@Example.com", password: "Passw0rd123", name: "Boss" })).toBe("created");
    expect(await ensureAdmin({ email: "boss@example.com", password: "NewPassw0rd9" })).toBe("reset");
    expect(await User.countDocuments({ role: "ADMIN" })).toBe(1);
    expect((await api().post("/api/auth/login").send({ email: "boss@example.com", password: "NewPassw0rd9" })).status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: "boss@example.com", password: "Passw0rd123" })).status).toBe(401);
  });

  it("refuses to turn an existing customer or vendor into an admin, and short passwords", async () => {
    await seedDemoData(PASSWORD);
    await expect(ensureAdmin({ email: `customer@${DEMO_EMAIL_DOMAIN}`, password: "Passw0rd123" })).rejects.toThrow(/refusing/);
    expect((await User.findOne({ email: `customer@${DEMO_EMAIL_DOMAIN}` }))!.role).toBe("CUSTOMER");
    await expect(ensureAdmin({ email: "new@example.com", password: "short" })).rejects.toThrow(/8 characters/);
    expect(await User.exists({ email: "new@example.com" })).toBeNull();
  });
});
