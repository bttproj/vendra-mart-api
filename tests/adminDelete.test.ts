import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Address } from "../src/models/Address.js";
import { Notification } from "../src/models/Notification.js";
import { Order } from "../src/models/Order.js";
import { Payout } from "../src/models/Payout.js";
import { Product } from "../src/models/Product.js";
import { StatusLog } from "../src/models/StatusLog.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { User } from "../src/models/User.js";
import { Vendor } from "../src/models/Vendor.js";
import type { OpenResult, PrivateFileStorage, PutOptions } from "../src/services/storage/PrivateFileStorage.js";
import { setPrivateStorage } from "../src/services/storage/index.js";
import { api, clearDb, createCustomer, createProduct, createVendor, loginToken, memoryStorage, pngBytes, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, createHandler, emailLog, paidOrder } from "./fulfilmentHelpers.js";
import { twoVendorScenario, placeOrder } from "./paymentHelpers.js";

class FakePrivateStorage implements PrivateFileStorage {
  files = new Map<string, Buffer>();
  private n = 0;
  async put(buffer: Buffer, { folder, ext }: PutOptions) {
    const publicId = `${folder}/${++this.n}.${ext}`;
    this.files.set(publicId, buffer);
    return { publicId };
  }
  async open(): Promise<OpenResult> {
    throw new Error("not used here");
  }
  async remove(publicId: string) {
    this.files.delete(publicId);
  }
}
const privateFiles = new FakePrivateStorage();
setPrivateStorage(privateFiles);

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  emailLog.reset();
  signedIn = null;
  memoryStorage.files.clear();
  privateFiles.files.clear();
});

// One admin per test (they are created on first use).
let signedIn: ReturnType<typeof asUser> | null = null;
const admin = async () => (signedIn ??= asUser((await createAdmin()).bearer));

describe("who can delete", () => {
  it("only the Super Admin: nobody else, and nobody signed out", async () => {
    const c = await createCustomer();
    const v = await createVendor({ email: "v@example.com" });
    for (const path of [`/api/admin/customers/${c.user._id}`, `/api/admin/vendors/${v.vendor._id}`, `/api/admin/staff/${c.user._id}`]) {
      expect((await api().delete(path)).status, path).toBe(401);
      expect((await api().delete(path).set("Authorization", c.bearer)).status, path).toBe(403);
      expect((await api().delete(path).set("Authorization", await loginToken(v.email))).status, path).toBe(403);
    }
    expect(await User.countDocuments()).toBe(2);
    expect(await Vendor.countDocuments()).toBe(1);
  });

  it("cannot reach an admin account or another role through the wrong route", async () => {
    const a = await createAdmin("boss@example.com");
    const other = await createAdmin("second@example.com");
    const handler = await createHandler();
    const c = await createCustomer();
    const sa = asUser(a.bearer);
    expect((await sa.delete(`/admin/customers/${other.user._id}`)).status).toBe(404);
    expect((await sa.delete(`/admin/staff/${other.user._id}`)).status).toBe(404);
    expect((await sa.delete(`/admin/staff/${c.user._id}`)).status).toBe(404);
    expect((await sa.delete(`/admin/customers/${handler.user._id}`)).status).toBe(404);
    expect((await sa.delete(`/admin/customers/${a.user._id}`)).status).toBe(404);
    expect(await User.countDocuments()).toBe(4);
  });

  it("refuses a malformed id and a missing record", async () => {
    const a = await admin();
    expect((await a.delete("/admin/customers/not-an-id")).status).toBe(422);
    expect((await a.delete("/admin/customers/507f1f77bcf86cd799439011")).status).toBe(404);
    expect((await a.delete("/admin/vendors/507f1f77bcf86cd799439011")).status).toBe(404);
    expect((await a.delete("/admin/staff/507f1f77bcf86cd799439011")).status).toBe(404);
  });
});

describe("deleting a customer", () => {
  it("removes the account, their addresses and notifications from the database, and emails them", async () => {
    const c = await createCustomer({ email: "gone@example.com" });
    await Notification.create({ userId: c.user._id, kind: "WELCOME", title: "Hi", body: "Hi" });
    const res = await (await admin()).delete(`/admin/customers/${c.user._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: String(c.user._id), role: "CUSTOMER", removed: { addresses: 1 } });

    expect(await User.findById(c.user._id)).toBeNull();
    expect(await Address.countDocuments({ userId: c.user._id })).toBe(0);
    expect(await Notification.countDocuments({ userId: c.user._id })).toBe(0);
    expect(emailLog.to("gone@example.com")[0]).toMatchObject({ kind: "ACCOUNT_DELETED", title: "Your VendraMart account has been removed" });
    expect((await api().post("/api/auth/login").send({ email: "gone@example.com", password: "Passw0rdTest" })).status).toBe(401);
    expect((await (await admin()).delete(`/admin/customers/${c.user._id}`)).status).toBe(404);
  });

  it("is refused when they have a paid order: those are sales and refund records", async () => {
    const o = await paidOrder();
    const res = await (await admin()).delete(`/admin/customers/${o.customer.user._id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/paid orders/);
    expect(await User.findById(o.customer.user._id)).not.toBeNull();
    expect(await Order.countDocuments()).toBe(1);
    expect(emailLog.to(o.customer.email).some((m) => m.kind === "ACCOUNT_DELETED")).toBe(false);
  });

  it("is refused while an order is waiting for payment", async () => {
    const s = await twoVendorScenario();
    await placeOrder(s.customer, s.items);
    const res = await (await admin()).delete(`/admin/customers/${s.customer.user._id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/waiting for payment/);
  });

  it("removes cancelled orders that never took money, with their parts and history", async () => {
    const s = await twoVendorScenario();
    const placed = await placeOrder(s.customer, s.items);
    await Order.updateOne({ _id: placed.order._id }, { status: "CANCELLED" });
    await SubOrder.updateMany({ orderId: placed.order._id }, { status: "CANCELLED" });
    expect(await StatusLog.countDocuments({ orderId: placed.order._id })).toBeGreaterThan(0);

    const res = await (await admin()).delete(`/admin/customers/${s.customer.user._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.removed).toMatchObject({ orders: 1, subOrders: 2 });
    expect(await Order.countDocuments()).toBe(0);
    expect(await SubOrder.countDocuments()).toBe(0);
    expect(await StatusLog.countDocuments()).toBe(0);
  });
});

describe("deleting a store", () => {
  async function storeWithFiles() {
    const v = await createVendor({ email: "shop@example.com", name: "Doomed Store" });
    const publicId = `vendramart/vendors/${v.vendor._id}/products/1.jpg`;
    memoryStorage.files.set(publicId, pngBytes());
    memoryStorage.files.set(`vendramart/vendors/${v.vendor._id}/logo/2.jpg`, pngBytes());
    await createProduct(v.vendor, { name: "One", images: [{ url: `https://img.test/${publicId}`, publicId }, { url: "https://u/x.jpg", publicId: "placeholder/abc" }] });
    await createProduct(v.vendor, { name: "Two" });
    await Vendor.updateOne({ _id: v.vendor._id }, { logoPublicId: `vendramart/vendors/${v.vendor._id}/logo/2.jpg`, ninSlip: { publicId: `vendramart/vendors/${v.vendor._id}/identity/1.png`, mime: "image/png" } });
    privateFiles.files.set(`vendramart/vendors/${v.vendor._id}/identity/1.png`, pngBytes());
    return v;
  }

  it("removes the store, its owner login, its products and every file from storage", async () => {
    const v = await storeWithFiles();
    const res = await (await admin()).delete(`/admin/vendors/${v.vendor._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Doomed Store", role: "VENDOR", removed: { products: 2, images: 2 } });

    expect(await Vendor.countDocuments()).toBe(0);
    expect(await Product.countDocuments()).toBe(0);
    expect(await User.findById(v.user._id)).toBeNull();
    expect(memoryStorage.files.size).toBe(0);
    expect(privateFiles.files.size).toBe(0);
    expect(emailLog.to("shop@example.com")[0]).toMatchObject({ kind: "ACCOUNT_DELETED" });
    expect((await api().get("/api/vendors/" + v.vendor.slug)).status).toBe(404);
  });

  it("is refused when it has paid orders, and nothing at all is removed", async () => {
    const o = await paidOrder();
    const res = await (await admin()).delete(`/admin/vendors/${o.bodija.vendor._id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/paid or are being delivered/);
    expect(await Vendor.findById(o.bodija.vendor._id)).not.toBeNull();
    expect(await Product.countDocuments({ vendorId: o.bodija.vendor._id })).toBe(1);
    expect(emailLog.to(o.bodija.email).some((m) => m.kind === "ACCOUNT_DELETED")).toBe(false);
  });

  it("is refused when it has payout records", async () => {
    const v = await storeWithFiles();
    await Payout.collection.insertOne({ vendorId: v.vendor._id, number: "PR-1", status: "PAID" });
    const res = await (await admin()).delete(`/admin/vendors/${v.vendor._id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/payout records/);
  });

  it("is refused while a customer is paying for one of its orders", async () => {
    const s = await twoVendorScenario();
    await placeOrder(s.customer, s.items);
    const res = await (await admin()).delete(`/admin/vendors/${s.bodija.vendor._id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/paying for an order/);
  });
});

describe("deleting a delivery handler", () => {
  it("removes the account, and frees finished deliveries so nothing points at them", async () => {
    const h = await createHandler("rider@example.com");
    const o = await paidOrder();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { handlerId: h.user._id, status: "COMPLETED" });
    await SubOrder.updateOne({ _id: o.ojabaSub._id }, { status: "CANCELLED" });

    const res = await (await admin()).delete(`/admin/staff/${h.user._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.removed).toEqual({ deliveriesUnassigned: 1 });
    expect(await User.findById(h.user._id)).toBeNull();
    expect((await SubOrder.findById(o.bodijaSub._id))!.handlerId).toBeUndefined();
    expect(emailLog.to("rider@example.com")[0]).toMatchObject({ kind: "ACCOUNT_DELETED" });
  });

  it("is refused while they still have deliveries in progress", async () => {
    const h = await createHandler("rider@example.com");
    const o = await paidOrder();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { handlerId: h.user._id, status: "PICKED_UP" });
    const res = await (await admin()).delete(`/admin/staff/${h.user._id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/in progress/);
    expect(await User.findById(h.user._id)).not.toBeNull();
  });
});

describe("a failing email never stops a delete", () => {
  it("the account still goes", async () => {
    const c = await createCustomer({ email: "gone@example.com" });
    emailLog.failWith = new Error("mail server down");
    const res = await (await admin()).delete(`/admin/customers/${c.user._id}`);
    expect(res.status).toBe(200);
    expect(await User.findById(c.user._id)).toBeNull();
  });
});
