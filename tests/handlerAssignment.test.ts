import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chooseHandler } from "../src/domain/handlerChoice.js";
import { Settings } from "../src/models/Settings.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { User } from "../src/models/User.js";
import { autoAssignWaiting } from "../src/modules/orders/autoAssign.js";
import { api, clearDb, createCustomer, loginToken, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, createHandler, paidOrder } from "./fulfilmentHelpers.js";

describe("choosing a handler", () => {
  it("picks the one carrying the fewest deliveries", () => {
    expect(chooseHandler([{ id: "a", open: 3, total: 10 }, { id: "b", open: 1, total: 40 }, { id: "c", open: 2, total: 0 }])).toBe("b");
  });

  it("on a tie, picks the one given the fewest in all, so a quiet day goes round the team", () => {
    expect(chooseHandler([{ id: "a", open: 0, total: 9 }, { id: "b", open: 0, total: 4 }, { id: "c", open: 0, total: 6 }])).toBe("b");
  });

  it("on a last tie, picks the lower id, and gives nothing when there is no one", () => {
    expect(chooseHandler([{ id: "b", open: 0, total: 0 }, { id: "a", open: 0, total: 0 }])).toBe("a");
    expect(chooseHandler([])).toBeNull();
  });
});

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

const turnOn = () => Settings.updateOne({ key: "singleton" }, { autoAssignHandlers: true });
const handlerOf = async (subId: unknown) => (await SubOrder.findById(subId))!.handlerId;

describe("the Choose a handler list", () => {
  it("lists delivery handlers only: no administrators, customers, vendors or switched-off handlers", async () => {
    const admin = await createAdmin();
    const rider1 = await createHandler("rider1@example.com");
    const rider2 = await createHandler("rider2@example.com");
    const off = await createHandler("off@example.com");
    await User.updateOne({ _id: off.user._id }, { isActive: false });
    await createAdmin("second-admin@example.com");
    await createCustomer();
    const res = await asUser(admin.bearer).get("/admin/deliveries/handlers");
    expect(res.status).toBe(200);
    expect(res.body.data.map((h: { id: string }) => h.id).sort()).toEqual([String(rider1.user._id), String(rider2.user._id)].sort());
    expect(res.body.data[0]).toEqual({ id: expect.any(String), name: expect.any(String), openDeliveries: 0 });
  });

  it("shows how many deliveries each handler is carrying", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const rider = await createHandler();
    await asUser(admin.bearer).post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(rider.user._id) });
    await asUser(admin.bearer).post(`/admin/sub-orders/${o.ojabaSub._id}/assign`, { handlerId: String(rider.user._id) });
    const res = await asUser(admin.bearer).get("/admin/deliveries/handlers");
    expect(res.body.data).toEqual([{ id: String(rider.user._id), name: rider.user.name, openDeliveries: 2 }]);
  });

  it("opens for staff who may open deliveries without needing the staff area, and not for anyone else", async () => {
    const admin = await createAdmin();
    await createHandler();
    const staff = (title: string, email: string, permissions?: string[]) => asUser(admin.bearer).post("/admin/staff", { name: "Some Manager", email, phone: "08031234567", password: "Passw0rdTest", role: "STAFF", staffTitle: title, ...(permissions ? { permissions } : {}) });
    await staff("LOGISTICS_MANAGER", "logistics@example.com", ["deliveries"]); // deliveries only: no staff area
    await staff("FINANCE_MANAGER", "finance@example.com");
    expect((await asUser(await loginToken("logistics@example.com")).get("/admin/deliveries/handlers")).status).toBe(200);
    expect((await asUser(await loginToken("finance@example.com")).get("/admin/deliveries/handlers")).status).toBe(403);
    expect((await asUser((await createCustomer()).bearer).get("/admin/deliveries/handlers")).status).toBe(403);
    expect((await api().get("/api/admin/deliveries/handlers")).status).toBe(401);
  });
});

describe("switching between automatic and manual assignment", () => {
  it("starts manual, and the deliveries list says so", async () => {
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).get("/admin/deliveries");
    expect(res.body.data.autoAssign).toBe(false);
  });

  it("is switched by a super admin and no one else", async () => {
    const admin = await createAdmin();
    const on = await asUser(admin.bearer).put("/admin/deliveries/assignment", { autoAssign: true });
    expect(on.status).toBe(200);
    expect(on.body.data).toEqual({ autoAssign: true, assignedNow: 0 });
    expect((await asUser(admin.bearer).get("/admin/deliveries")).body.data.autoAssign).toBe(true);
    await asUser(admin.bearer).put("/admin/deliveries/assignment", { autoAssign: false });
    expect((await asUser(admin.bearer).get("/admin/deliveries")).body.data.autoAssign).toBe(false);

    await asUser(admin.bearer).post("/admin/staff", { name: "Log Manager", email: "logistics@example.com", phone: "08031234567", password: "Passw0rdTest", role: "STAFF", staffTitle: "LOGISTICS_MANAGER" });
    const manager = asUser(await loginToken("logistics@example.com"));
    expect((await manager.get("/admin/deliveries")).status).toBe(200); // can see it
    expect((await manager.put("/admin/deliveries/assignment", { autoAssign: true })).status).toBe(403); // cannot change it
    expect((await asUser((await createCustomer()).bearer).put("/admin/deliveries/assignment", { autoAssign: true })).status).toBe(403);
    expect((await api().put("/api/admin/deliveries/assignment").send({ autoAssign: true })).status).toBe(401);
    expect((await Settings.findOne({ key: "singleton" }))!.autoAssignHandlers).toBe(false);
  });

  it("refuses anything but a yes or no", async () => {
    const admin = await createAdmin();
    for (const body of [{}, { autoAssign: "yes" }, { autoAssign: 1 }, { autoAssign: true, extra: 1 }]) {
      expect((await asUser(admin.bearer).put("/admin/deliveries/assignment", body)).status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe("automatic assignment", () => {
  it("does nothing while it is off: the admin picks each handler", async () => {
    await createHandler();
    const o = await paidOrder();
    expect(await handlerOf(o.bodijaSub._id)).toBeFalsy();
    expect(await handlerOf(o.ojabaSub._id)).toBeFalsy();
  });

  it("gives each paid delivery to a handler as soon as the payment is confirmed", async () => {
    const rider = await createHandler();
    await turnOn();
    const o = await paidOrder();
    expect(String(await handlerOf(o.bodijaSub._id))).toBe(String(rider.user._id));
    expect(String(await handlerOf(o.ojabaSub._id))).toBe(String(rider.user._id));
    const mine = await asUser(rider.bearer).get("/handler/deliveries");
    expect(mine.body.data.deliveries).toHaveLength(2);
  });

  it("spreads deliveries across handlers, the lightest load first", async () => {
    const first = await createHandler("rider-a@example.com");
    const second = await createHandler("rider-b@example.com");
    await turnOn();
    const o = await paidOrder();
    const a = String(await handlerOf(o.bodijaSub._id));
    const b = String(await handlerOf(o.ojabaSub._id));
    expect(new Set([a, b])).toEqual(new Set([String(first.user._id), String(second.user._id)]));
    expect(a).not.toBe(b);
  });

  it("never picks a switched-off handler, and leaves the delivery waiting when there is no one", async () => {
    const off = await createHandler();
    await User.updateOne({ _id: off.user._id }, { isActive: false });
    await turnOn();
    const o = await paidOrder();
    expect(await handlerOf(o.bodijaSub._id)).toBeFalsy();
  });

  it("gives a waiting delivery a handler when the vendor marks it ready, if none was free before", async () => {
    await turnOn();
    const o = await paidOrder(); // no handler existed when it was paid
    expect(await handlerOf(o.bodijaSub._id)).toBeFalsy();
    const rider = await createHandler();
    const ready = await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.bodijaSub._id}/ready`);
    expect(ready.status).toBe(200);
    expect(String(await handlerOf(o.bodijaSub._id))).toBe(String(rider.user._id));
  });

  it("never takes a delivery from the handler the admin chose", async () => {
    const chosen = await createHandler("chosen@example.com");
    const o = await paidOrder(); // manual: not assigned
    const admin = await createAdmin();
    await asUser(admin.bearer).post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(chosen.user._id) });
    await createHandler("lighter@example.com"); // a handler with no load at all
    await turnOn();
    await autoAssignWaiting();
    await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.bodijaSub._id}/ready`);
    expect(String(await handlerOf(o.bodijaSub._id))).toBe(String(chosen.user._id));
  });

  it("switching it on gives the deliveries already waiting to handlers, and says how many", async () => {
    const rider = await createHandler();
    const o = await paidOrder(); // paid while manual: both wait
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).put("/admin/deliveries/assignment", { autoAssign: true });
    expect(res.body.data).toEqual({ autoAssign: true, assignedNow: 2 });
    expect(String(await handlerOf(o.bodijaSub._id))).toBe(String(rider.user._id));
    expect(String(await handlerOf(o.ojabaSub._id))).toBe(String(rider.user._id));
  });

  it("the periodic sweep does nothing while it is off, and picks up waiting deliveries once it is on", async () => {
    const o = await paidOrder();
    await createHandler();
    expect(await autoAssignWaiting()).toBe(0);
    expect(await handlerOf(o.bodijaSub._id)).toBeFalsy();
    await turnOn();
    expect(await autoAssignWaiting()).toBe(2);
    expect(await autoAssignWaiting()).toBe(0); // nothing left to give
  });
});
