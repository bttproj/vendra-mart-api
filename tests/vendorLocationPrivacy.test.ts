import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Vendor } from "../src/models/Vendor.js";
import { api, clearDb, quoteReq, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin } from "./fulfilmentHelpers.js";
import { placeOrder, twoVendorScenario } from "./paymentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

const SECRET = "17 Secret Lane, Mokola, Ibadan";

/** Buyers must not learn where a store is: no address, no area, no pickup details of any kind. */
function expectNoLocation(body: unknown, label: string) {
  const text = JSON.stringify(body);
  expect(text, `${label} leaked the address`).not.toContain("Secret Lane");
  for (const key of ["pickup", "pickupLine", "pickupArea"]) expect(text, `${label} has "${key}"`).not.toContain(`"${key}"`);
}

describe("a store's location is not shown to buyers", () => {
  it("is absent from every page and answer a shopper can reach", async () => {
    const s = await twoVendorScenario();
    await Vendor.updateMany({}, { "pickup.line": SECRET });
    const addressId = String(s.customer.address._id);
    const get = (path: string) => api().get(`/api${path}`);

    expectNoLocation((await get("/home")).body, "home");
    expectNoLocation((await get("/vendors")).body, "store list");
    expectNoLocation((await get(`/vendors/${s.bodija.vendor.slug}`)).body, "store page");
    expectNoLocation((await get("/products")).body, "product list");
    expectNoLocation((await get(`/products/${s.flour.slug}`)).body, "product page");
    expectNoLocation((await api().post("/api/cart/validate").send({ items: s.items })).body, "cart");

    const quote = await quoteReq(s.customer.bearer, { items: s.items, addressId });
    expect(quote.status).toBe(200);
    expectNoLocation(quote.body, "checkout quote");
    // The distance and the fee are still shown: that is what the shopper pays for.
    expect(quote.body.data.legs[0].delivery).toMatchObject({ distanceKm: "3.2", feeKobo: 64000 });

    const placed = await placeOrder(s.customer, s.items);
    const order = await api().get(`/api/orders/${placed.data.orderId}`).set("Authorization", s.customer.bearer);
    expect(order.status).toBe(200);
    expectNoLocation(order.body, "order page");
    expect(order.body.data.subOrders[0].delivery).toMatchObject({ distanceKm: expect.any(String), feeKobo: expect.any(Number) });
    expectNoLocation((await api().get("/api/orders").set("Authorization", s.customer.bearer)).body, "order list");
  });

  it("shows only the city: on the home page, the store list, the store page and the product page", async () => {
    const s = await twoVendorScenario();
    await Vendor.updateMany({}, { "pickup.line": SECRET });
    const get = (path: string) => api().get(`/api${path}`);

    expect((await get("/home")).body.data.stores.map((x: { cityName: string }) => x.cityName)).toEqual(["Ibadan", "Ibadan"]);
    expect((await get("/vendors")).body.data.map((x: { cityName: string }) => x.cityName)).toEqual(["Ibadan", "Ibadan"]);
    expect((await get(`/vendors/${s.bodija.vendor.slug}`)).body.data.cityName).toBe("Ibadan");
    expect((await get(`/products/${s.flour.slug}`)).body.data.vendorDetail.cityName).toBe("Ibadan");
  });

  it("is still there for the people who need it: the admin, and the vendor's own settings", async () => {
    const s = await twoVendorScenario();
    await Vendor.updateMany({}, { "pickup.line": SECRET });
    const admin = await createAdmin();
    const detail = await asUser(admin.bearer).get(`/admin/vendors/${s.bodija.vendor._id}`);
    expect(detail.body.data.pickup.line).toBe(SECRET);
    const stock = await asUser(admin.bearer).get("/admin/products");
    expect(stock.body.data[0].vendor.address).toBe(SECRET);
    const { loginToken } = await import("./helpers.js");
    const own = await asUser(await loginToken(s.bodija.email)).get("/vendor/profile");
    expect(JSON.stringify(own.body)).toContain("Secret Lane");
  });
});
