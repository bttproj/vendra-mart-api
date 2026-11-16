import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOW_STOCK, stockLevel, uploadedAfterEdit, uploadedUnits } from "../src/domain/stock.js";
import { Product } from "../src/models/Product.js";
import { api, clearDb, createCustomer, createProduct, createVendor, loginToken, productBody, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, paidOrder } from "./fulfilmentHelpers.js";

describe("the stock rules", () => {
  it("calls a product out at 0, low up to the limit, and ok above it", () => {
    expect(DEFAULT_LOW_STOCK).toBe(5);
    expect(stockLevel(0)).toBe("out");
    expect(stockLevel(1)).toBe("low");
    expect(stockLevel(5)).toBe("low");
    expect(stockLevel(6)).toBe("ok");
    expect(stockLevel(3, 2)).toBe("ok");
    expect(stockLevel(2, 2)).toBe("low");
  });

  it("counts a product from before uploads were counted as what is left plus what sold", () => {
    expect(uploadedUnits({ stock: 3, soldCount: 7 })).toBe(10);
    expect(uploadedUnits({ stock: 3, soldCount: 7, uploadedCount: null })).toBe(10);
    expect(uploadedUnits({ stock: 3, soldCount: 7, uploadedCount: 12 })).toBe(12);
    expect(uploadedUnits({ stock: 0, soldCount: 0, uploadedCount: 0 })).toBe(0);
  });

  it("adds to uploaded when stock goes up, takes from it for a correction down, and never goes below zero", () => {
    expect(uploadedAfterEdit({ stock: 3, soldCount: 7, uploadedCount: 10 }, 13)).toBe(20);
    expect(uploadedAfterEdit({ stock: 3, soldCount: 7, uploadedCount: 10 }, 1)).toBe(8);
    expect(uploadedAfterEdit({ stock: 3, soldCount: 7 }, 5)).toBe(12); // an older product starts from left plus sold
    expect(uploadedAfterEdit({ stock: 3, soldCount: 0, uploadedCount: 1 }, 0)).toBe(0);
  });
});

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

/** Two stores. Bodija: flour 10 left of 15 (5 sold), oil 3 left (an older product: 7 sold). Ojaba: rice sold out (12 sold), beans 5 left. */
async function shelves() {
  const bodija = await createVendor({ name: "Bodija Provisions" });
  const ojaba = await createVendor({ name: "Oja'ba Foodstuff" });
  const flour = await createProduct(bodija.vendor, { name: "Bean Flour", stock: 10, soldCount: 5, uploadedCount: 15 });
  const oil = await createProduct(bodija.vendor, { name: "Palm Oil", stock: 3, soldCount: 7 });
  const rice = await createProduct(ojaba.vendor, { name: "Ofada Rice", stock: 0, soldCount: 12, uploadedCount: 12 });
  const beans = await createProduct(ojaba.vendor, { name: "Brown Beans", stock: 5, soldCount: 1, isActive: false });
  const admin = await createAdmin();
  return { bodija, ojaba, flour, oil, rice, beans, admin };
}

const names = (res: { body: { data: { name: string }[] } }) => res.body.data.map((p) => p.name);

describe("GET /api/admin/products", () => {
  it("lists every store's products with the vendor, their address, and uploaded, left and sold", async () => {
    const s = await shelves();
    const res = await asUser(s.admin.bearer).get("/admin/products?limit=48");
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(4);
    const flour = res.body.data.find((p: { name: string }) => p.name === "Bean Flour");
    expect(flour).toMatchObject({ uploaded: 15, left: 10, sold: 5, level: "ok", isActive: true, priceKobo: 1500000 });
    expect(flour.vendor).toMatchObject({ businessName: "Bodija Provisions", address: "Somewhere, Ibadan", city: "Ibadan", ownerName: "Owner", phone: "08031234567", status: "APPROVED" });
    expect(flour.vendor.email).toContain("@");
    // An older product (no uploaded count saved) is taken to have been uploaded as left plus sold.
    expect(res.body.data.find((p: { name: string }) => p.name === "Palm Oil")).toMatchObject({ uploaded: 10, left: 3, sold: 7, level: "low" });
    expect(res.body.data.find((p: { name: string }) => p.name === "Ofada Rice")).toMatchObject({ left: 0, level: "out" });
    expect(res.body.data.find((p: { name: string }) => p.name === "Brown Beans")).toMatchObject({ isActive: false, level: "low" });
  });

  it("filters to products running low, sold out, or either", async () => {
    const s = await shelves();
    const get = (q: string) => asUser(s.admin.bearer).get(`/admin/products?${q}`);
    expect(names(await get("stock=low")).sort()).toEqual(["Brown Beans", "Palm Oil"]);
    expect(names(await get("stock=out"))).toEqual(["Ofada Rice"]);
    expect(names(await get("stock=attention")).sort()).toEqual(["Brown Beans", "Ofada Rice", "Palm Oil"]);
    expect(names(await get("stock=low&lowAt=3"))).toEqual(["Palm Oil"]); // the admin picks what "low" means
    expect(names(await get("stock=attention&lowAt=1"))).toEqual(["Ofada Rice"]);
    expect(names(await get("stock=low&lowAt=20")).sort()).toEqual(["Bean Flour", "Brown Beans", "Palm Oil"]);
  });

  it("filters by store, and searches product and store names", async () => {
    const s = await shelves();
    const get = (q: string) => asUser(s.admin.bearer).get(`/admin/products?${q}`);
    expect(names(await get(`vendorId=${s.ojaba.vendor._id}`)).sort()).toEqual(["Brown Beans", "Ofada Rice"]);
    expect(names(await get("q=palm"))).toEqual(["Palm Oil"]);
    expect(names(await get("q=oja"))).toHaveLength(2); // by the store's name
    expect(names(await get("q=oja&stock=out"))).toEqual(["Ofada Rice"]);
    expect(names(await get("q=nothing-here"))).toEqual([]);
    expect(names(await get("q=.*"))).toEqual([]); // typed text is not a pattern
  });

  it("sorts by least stock left, most sold, name, or newest", async () => {
    const s = await shelves();
    const get = async (sort: string) => names(await asUser(s.admin.bearer).get(`/admin/products?sort=${sort}`));
    expect(await get("stock_asc")).toEqual(["Ofada Rice", "Palm Oil", "Brown Beans", "Bean Flour"]);
    expect(await get("stock_desc")).toEqual(["Bean Flour", "Brown Beans", "Palm Oil", "Ofada Rice"]);
    expect(await get("sold_desc")).toEqual(["Ofada Rice", "Palm Oil", "Bean Flour", "Brown Beans"]);
    expect(await get("name")).toEqual(["Bean Flour", "Brown Beans", "Ofada Rice", "Palm Oil"]);
    expect((await get("newest"))[0]).toBe("Brown Beans");
  });

  it("pages the list", async () => {
    const s = await shelves();
    const first = await asUser(s.admin.bearer).get("/admin/products?sort=name&limit=3");
    const second = await asUser(s.admin.bearer).get("/admin/products?sort=name&limit=3&page=2");
    expect(names(first)).toHaveLength(3);
    expect(names(second)).toEqual(["Palm Oil"]);
    expect(first.body.meta).toMatchObject({ total: 4, page: 1, limit: 3 });
  });

  it("refuses a bad store id, a bad filter, or a silly low-stock number", async () => {
    const s = await shelves();
    for (const q of ["vendorId=nope", "stock=some", "sort=random", "lowAt=0", "lowAt=5000", "lowAt=two", "limit=500"]) {
      expect((await asUser(s.admin.bearer).get(`/admin/products?${q}`)).status, q).toBe(422);
    }
  });
});

describe("GET /api/admin/products/summary", () => {
  it("counts products, sold out, running low, the stores that need stock, and the units left and sold", async () => {
    const s = await shelves();
    const res = await asUser(s.admin.bearer).get("/admin/products/summary");
    expect(res.body.data).toEqual({ lowAt: 5, products: 4, outOfStock: 1, runningLow: 2, storesNeedingStock: 2, unitsLeft: 18, unitsSold: 25 });
    const strict = await asUser(s.admin.bearer).get("/admin/products/summary?lowAt=3");
    expect(strict.body.data).toMatchObject({ lowAt: 3, outOfStock: 1, runningLow: 1, storesNeedingStock: 2 });
  });

  it("is all zeros with no products", async () => {
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).get("/admin/products/summary");
    expect(res.body.data).toEqual({ lowAt: 5, products: 0, outOfStock: 0, runningLow: 0, storesNeedingStock: 0, unitsLeft: 0, unitsSold: 0 });
  });
});

describe("who may see the stock", () => {
  it("is for a super admin and for staff with the catalogue or vendors area, and no one else", async () => {
    const s = await shelves();
    const customer = await createCustomer();
    expect((await asUser(customer.bearer).get("/admin/products")).status).toBe(403);
    expect((await asUser(await loginToken(s.bodija.email)).get("/admin/products")).status).toBe(403); // a vendor cannot see other stores
    expect((await api().get("/api/admin/products")).status).toBe(401);

    const staff = (title: string, email: string) => asUser(s.admin.bearer).post("/admin/staff", { name: "Some Manager", email, phone: "08031234567", password: "Passw0rdTest", role: "STAFF", staffTitle: title });
    await staff("PRODUCT_MANAGER", "product@example.com");
    await staff("VENDOR_MANAGER", "vendor-mgr@example.com");
    await staff("FINANCE_MANAGER", "finance@example.com");
    await staff("CUSTOMER_SUPPORT", "support@example.com");
    for (const [email, status] of [["product@example.com", 200], ["vendor-mgr@example.com", 200], ["finance@example.com", 403], ["support@example.com", 403]] as const) {
      const bearer = await loginToken(email);
      expect((await asUser(bearer).get("/admin/products")).status, email).toBe(status);
      expect((await asUser(bearer).get("/admin/products/summary")).status, email).toBe(status);
    }
  });

  it("cannot be changed from here", async () => {
    const s = await shelves();
    expect((await asUser(s.admin.bearer).post("/admin/products", {})).status).toBe(404);
    expect((await asUser(s.admin.bearer).patch(`/admin/products/${s.flour._id}`, { stock: 99 })).status).toBe(404);
    expect((await Product.findById(s.flour._id))!.stock).toBe(10);
  });
});

describe("keeping the uploaded count as a vendor changes stock", () => {
  it("starts at the first stock and follows each time stock is set", async () => {
    const { vendor, email } = await createVendor({ name: "Fresh Store" });
    const bearer = await loginToken(email);
    const made = await asUser(bearer).post("/vendor/products", await productBody({ stock: 20 }));
    expect(made.status).toBe(201);
    expect(made.body.data.uploadedCount).toBe(20);
    const id = made.body.data.id as string;
    const uploaded = async () => (await Product.findById(id))!.uploadedCount;

    await asUser(bearer).patch(`/vendor/products/${id}`, { stock: 30 }); // 10 more put up
    expect(await uploaded()).toBe(30);
    await asUser(bearer).patch(`/vendor/products/${id}`, { stock: 25 }); // 5 taken off (a miscount)
    expect(await uploaded()).toBe(25);
    await asUser(bearer).patch(`/vendor/products/${id}`, { name: "Garri, renamed" }); // not a stock change
    expect(await uploaded()).toBe(25);
    await asUser(bearer).patch(`/vendor/products/${id}`, { stock: 25 }); // the same stock again
    expect(await uploaded()).toBe(25);
    expect(vendor.status).toBe("APPROVED");
  });

  it("starts an older product from what is left plus what sold", async () => {
    const { vendor, email } = await createVendor();
    const old = await createProduct(vendor, { stock: 10, soldCount: 4 });
    expect(old.uploadedCount).toBeUndefined();
    const res = await asUser(await loginToken(email)).patch(`/vendor/products/${old._id}`, { stock: 12 });
    expect(res.body.data.uploadedCount).toBe(16); // 14 before, and 2 more put up
    expect((await Product.findById(old._id))!.uploadedCount).toBe(16);
  });
});

describe("the sold count when paid goods are cancelled", () => {
  it("goes down with the stock that is put back", async () => {
    const o = await paidOrder();
    const flour = async () => (await Product.findOne({ vendorId: o.bodijaSub.vendorId }))!;
    expect(await flour()).toMatchObject({ stock: 9, soldCount: 1 });
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).post(`/admin/sub-orders/${o.bodijaSub._id}/status`, { to: "CANCELLED", note: "Vendor ran out" });
    expect(res.status).toBe(200);
    expect(await flour()).toMatchObject({ stock: 10, soldCount: 0 });
  });
});
