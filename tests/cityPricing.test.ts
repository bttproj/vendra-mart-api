import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ratesForCity } from "../src/domain/deliveryFee.js";
import { City } from "../src/models/City.js";
import { Settings } from "../src/models/Settings.js";
import { api, clearDb, createCustomer, fakeDistance, loginToken, quoteReq, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin } from "./fulfilmentHelpers.js";
import { placeOrder, twoVendorScenario } from "./paymentHelpers.js";

describe("which rates apply in a city", () => {
  const platform = { pricePerKmKobo: 20000, minDeliveryFeeKobo: null };

  it("uses the platform rates for a city with none of its own", () => {
    expect(ratesForCity(platform, { pricePerKmKobo: null, minDeliveryFeeKobo: null })).toEqual(platform);
    expect(ratesForCity(platform, {})).toEqual(platform);
    expect(ratesForCity(platform, null)).toEqual(platform);
  });

  it("uses a city's own price, and each value falls back on its own", () => {
    expect(ratesForCity(platform, { pricePerKmKobo: 30000 })).toEqual({ pricePerKmKobo: 30000, minDeliveryFeeKobo: null });
    expect(ratesForCity({ pricePerKmKobo: 20000, minDeliveryFeeKobo: 50000 }, { minDeliveryFeeKobo: 0 })).toEqual({ pricePerKmKobo: 20000, minDeliveryFeeKobo: 0 }); // 0 is a real value: no minimum
  });
});

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  fakeDistance.reset();
});

const setPricing = (bearer: string, cityId: unknown, body: unknown) => asUser(bearer).put(`/admin/cities/${cityId}/pricing`, body);
const ibadan = async () => (await City.findOne({ slug: "ibadan" }))!;
const fees = (res: { body: { data: { legs: { delivery: { feeKobo: number } }[] } } }) => res.body.data.legs.map((l) => l.delivery.feeKobo);

describe("a city's own delivery fares", () => {
  it("starts with every city on the platform price", async () => {
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).get("/admin/settings");
    for (const c of res.body.data.cities) {
      expect(c).toMatchObject({ pricePerKmKobo: null, minDeliveryFeeKobo: null, effective: { pricePerKmKobo: 20000, minDeliveryFeeKobo: null } });
    }
  });

  it("charges customers in that city by its price per km, and the order keeps it", async () => {
    const admin = await createAdmin();
    const { customer, items } = await twoVendorScenario();
    const saved = await setPricing(admin.bearer, (await ibadan())._id, { pricePerKmKobo: 30000, minDeliveryFeeKobo: null }); // N300 per km in Ibadan
    expect(saved.status).toBe(200);
    expect(saved.body.data.cities.find((c: { slug: string }) => c.slug === "ibadan")).toMatchObject({ pricePerKmKobo: 30000, effective: { pricePerKmKobo: 30000 } });

    const quote = await quoteReq(customer.bearer, { items, addressId: String(customer.address._id) });
    expect(fees(quote)).toEqual([96000, 192000]); // 3.2 km and 6.4 km at N300
    expect(quote.body.data.pricing.pricePerKmKobo).toBe(30000);

    const { order, subs } = await placeOrder(customer, items);
    expect(order.pricing!.pricePerKmKobo).toBe(30000);
    expect(subs.map((s) => s.delivery!.pricePerKmKobo)).toEqual([30000, 30000]);
    expect(order.deliveryTotalKobo).toBe(288000);

    // Changing the city's price later does not touch the order already placed.
    await setPricing(admin.bearer, (await ibadan())._id, { pricePerKmKobo: 50000, minDeliveryFeeKobo: null });
    const again = await City.findOne({ slug: "ibadan" });
    expect(again!.pricePerKmKobo).toBe(50000);
    const stored = await (await import("../src/models/Order.js")).Order.findById(order._id);
    expect(stored!.deliveryTotalKobo).toBe(288000);
    expect(stored!.pricing!.pricePerKmKobo).toBe(30000);
  });

  it("a platform price change does not move a city that has its own, but does move one that has not", async () => {
    const admin = await createAdmin();
    const { customer, items } = await twoVendorScenario();
    await setPricing(admin.bearer, (await ibadan())._id, { pricePerKmKobo: 30000, minDeliveryFeeKobo: null });
    await Settings.updateOne({ key: "singleton" }, { pricePerKmKobo: 25000 });
    expect(fees(await quoteReq(customer.bearer, { items, addressId: String(customer.address._id) }))).toEqual([96000, 192000]);

    await setPricing(admin.bearer, (await ibadan())._id, { pricePerKmKobo: null, minDeliveryFeeKobo: null }); // back to the platform price
    expect(fees(await quoteReq(customer.bearer, { items, addressId: String(customer.address._id) }))).toEqual([80000, 160000]); // N250
  });

  it("leaves other cities alone", async () => {
    const admin = await createAdmin();
    const { customer, items } = await twoVendorScenario();
    const lagos = (await City.findOne({ slug: "lagos" }))!;
    await setPricing(admin.bearer, lagos._id, { pricePerKmKobo: 90000, minDeliveryFeeKobo: null });
    expect(fees(await quoteReq(customer.bearer, { items, addressId: String(customer.address._id) }))).toEqual([64000, 128000]); // Ibadan still N200
  });

  it("can have its own minimum, or no minimum at all", async () => {
    const admin = await createAdmin();
    const { customer, items } = await twoVendorScenario();
    await Settings.updateOne({ key: "singleton" }, { minDeliveryFeeKobo: 100000 }); // platform minimum N1,000
    const ask = async () => quoteReq(customer.bearer, { items, addressId: String(customer.address._id) });

    expect(fees(await ask())).toEqual([100000, 128000]); // the 3.2 km trip is raised to the minimum
    await setPricing(admin.bearer, (await ibadan())._id, { pricePerKmKobo: null, minDeliveryFeeKobo: 0 });
    expect(fees(await ask())).toEqual([64000, 128000]); // no minimum in this city
    await setPricing(admin.bearer, (await ibadan())._id, { pricePerKmKobo: null, minDeliveryFeeKobo: 70000 });
    const quote = await ask();
    expect(fees(quote)).toEqual([70000, 128000]);
    expect(quote.body.data.legs[0].delivery.minFeeApplied).toBe(true);
  });

  it("can be set before a city goes live", async () => {
    const admin = await createAdmin();
    const lagos = (await City.findOne({ slug: "lagos" }))!;
    expect(lagos.isActive).toBe(false);
    expect((await setPricing(admin.bearer, lagos._id, { pricePerKmKobo: 45000, minDeliveryFeeKobo: 150000 })).status).toBe(200);
    expect((await City.findById(lagos._id))!.pricePerKmKobo).toBe(45000);
  });

  it("is not shown to shoppers in the public list of cities", async () => {
    const admin = await createAdmin();
    await setPricing(admin.bearer, (await ibadan())._id, { pricePerKmKobo: 30000, minDeliveryFeeKobo: null });
    const list = await api().get("/api/cities");
    expect(JSON.stringify(list.body)).not.toContain("30000");
  });

  it("refuses amounts that are not whole kobo, are negative, are far too high, or come with extra fields", async () => {
    const admin = await createAdmin();
    const id = (await ibadan())._id;
    for (const body of [
      { pricePerKmKobo: 1.5, minDeliveryFeeKobo: null },
      { pricePerKmKobo: -1, minDeliveryFeeKobo: null },
      { pricePerKmKobo: 2_000_000, minDeliveryFeeKobo: null },
      { pricePerKmKobo: 20000, minDeliveryFeeKobo: 20_000_000 },
      { pricePerKmKobo: "200", minDeliveryFeeKobo: null },
      { pricePerKmKobo: 20000 },
      { pricePerKmKobo: 20000, minDeliveryFeeKobo: null, isActive: true },
    ]) {
      expect((await setPricing(admin.bearer, id, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await ibadan()).pricePerKmKobo).toBeNull();
    expect((await setPricing(admin.bearer, "64b000000000000000000000", { pricePerKmKobo: 1, minDeliveryFeeKobo: null })).status).toBe(404);
  });

  it("is only for an administrator who may open pricing", async () => {
    const admin = await createAdmin();
    const id = (await ibadan())._id;
    const body = { pricePerKmKobo: 30000, minDeliveryFeeKobo: null };
    const customer = await createCustomer();
    expect((await setPricing(customer.bearer, id, body)).status).toBe(403);
    expect((await api().put(`/api/admin/cities/${id}/pricing`).send(body)).status).toBe(401);

    await asUser(admin.bearer).post("/admin/staff", { name: "Fin Manager", email: "fin@example.com", phone: "08031234567", password: "Passw0rdTest", role: "STAFF", staffTitle: "FINANCE_MANAGER" });
    expect((await setPricing(await loginToken("fin@example.com"), id, body)).status).toBe(403); // no pricing area
    expect((await ibadan()).pricePerKmKobo).toBeNull();
  });
});
