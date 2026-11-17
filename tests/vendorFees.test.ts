import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Settings } from "../src/models/Settings.js";
import { api, clearDb, createCustomer, createProduct, createVendor, loginToken, productBody, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

async function vendorSession() {
  const { vendor, email } = await createVendor();
  return { vendor, v: asUser(await loginToken(email)) };
}

describe("GET /api/vendor/fees", () => {
  it("tells a vendor the service fee rate", async () => {
    const { v } = await vendorSession();
    const res = await v.get("/vendor/fees");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ serviceFeeBps: 1000 }); // the default 10%
  });

  it("works out the fee and what the vendor receives for one item at a price", async () => {
    const { v } = await vendorSession();
    const res = await v.get("/vendor/fees?priceKobo=1500000"); // N15,000
    expect(res.body.data).toEqual({ serviceFeeBps: 1000, priceKobo: 1500000, serviceFeeKobo: 150000, youReceiveKobo: 1350000 });
  });

  it("follows the rate the admin has set, and the fee plus what is received always equal the price", async () => {
    const { v } = await vendorSession();
    await Settings.updateOne({ key: "singleton" }, { commissionBps: 1250 });
    expect((await v.get("/vendor/fees?priceKobo=1500000")).body.data).toMatchObject({ serviceFeeBps: 1250, serviceFeeKobo: 187500, youReceiveKobo: 1312500 });
    for (const price of [100, 101, 999, 12345, 1999999]) {
      const d = (await v.get(`/vendor/fees?priceKobo=${price}`)).body.data;
      expect(d.serviceFeeKobo + d.youReceiveKobo, String(price)).toBe(price);
      expect(Number.isInteger(d.serviceFeeKobo)).toBe(true);
    }
  });

  it("gives only the rate when no price is typed yet", async () => {
    const { v } = await vendorSession();
    expect((await v.get("/vendor/fees?priceKobo=0")).body.data).toEqual({ serviceFeeBps: 1000 });
  });

  it("refuses a price that is not whole kobo or is negative", async () => {
    const { v } = await vendorSession();
    for (const q of ["priceKobo=1.5", "priceKobo=-1", "priceKobo=abc", "priceKobo=99999999999999"]) {
      expect((await v.get(`/vendor/fees?${q}`)).status, q).toBe(422);
    }
  });

  it("is for vendors only: shoppers and signed-out visitors never learn the rate", async () => {
    const customer = await createCustomer();
    const admin = await createAdmin();
    expect((await asUser(customer.bearer).get("/vendor/fees")).status).toBe(403);
    expect((await asUser(admin.bearer).get("/vendor/fees")).status).toBe(403);
    expect((await api().get("/api/vendor/fees")).status).toBe(401);
  });
});

describe("a vendor's products show the fee and what they receive", () => {
  it("is on each product in the list, when one is added and when one is opened", async () => {
    const { vendor, v } = await vendorSession();
    const made = await createProduct(vendor, { name: "Bean Flour", priceKobo: 1500000 });
    const list = await v.get("/vendor/products");
    expect(list.body.data[0]).toMatchObject({ priceKobo: 1500000, serviceFeeKobo: 150000, youReceiveKobo: 1350000 });
    expect((await v.get(`/vendor/products/${made._id}`)).body.data).toMatchObject({ serviceFeeKobo: 150000, youReceiveKobo: 1350000 });
    const added = await v.post("/vendor/products", await productBody({ priceKobo: 2000000 }));
    expect(added.body.data).toMatchObject({ serviceFeeKobo: 200000, youReceiveKobo: 1800000 });
  });

  it("follows a change in the price and in the admin's rate", async () => {
    const { vendor, v } = await vendorSession();
    const made = await createProduct(vendor, { priceKobo: 1000000 });
    expect((await v.patch(`/vendor/products/${made._id}`, { priceKobo: 2000000 })).body.data).toMatchObject({ serviceFeeKobo: 200000, youReceiveKobo: 1800000 });
    await Settings.updateOne({ key: "singleton" }, { commissionBps: 500 });
    expect((await v.get(`/vendor/products/${made._id}`)).body.data).toMatchObject({ serviceFeeKobo: 100000, youReceiveKobo: 1900000 });
  });
});
