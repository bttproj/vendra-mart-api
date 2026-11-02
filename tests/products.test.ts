import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Product } from "../src/models/Product.js";
import { Vendor } from "../src/models/Vendor.js";
import { api, clearDb, createProduct, createVendor, loginToken, memoryStorage, pngBytes, productBody, seedReferenceData, startDb, stopDb } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  memoryStorage.files.clear();
});

async function asVendor(opts: Parameters<typeof createVendor>[0] = {}) {
  const v = await createVendor(opts);
  const bearer = await loginToken(v.email);
  const post = (path: string, body?: unknown) => api().post(`/api/vendor${path}`).set("Authorization", bearer).send(body as object);
  const patch = (path: string, body?: unknown) => api().patch(`/api/vendor${path}`).set("Authorization", bearer).send(body as object);
  const get = (path: string) => api().get(`/api/vendor${path}`).set("Authorization", bearer);
  const del = (path: string) => api().delete(`/api/vendor${path}`).set("Authorization", bearer);
  const upload = (buf: Buffer, filename = "photo.png") =>
    api().post("/api/vendor/uploads/image").set("Authorization", bearer).attach("file", buf, filename);
  return { ...v, bearer, post, patch, get, del, upload };
}

describe("vendor product CRUD", () => {
  it("creates a product with kobo price, stock and category; city is copied from the store", async () => {
    const v = await asVendor();
    const res = await v.post("/products", await productBody());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Garri Ijebu, white bag", priceKobo: 1500000, stock: 20, isActive: true, slug: "garri-ijebu-white-bag" });
    const saved = await Product.findOne();
    expect(String(saved!.cityId)).toBe(String(v.vendor.pickup!.cityId));
    expect(String(saved!.vendorId)).toBe(String(v.vendor._id));
  });

  it("gives duplicate names unique slugs", async () => {
    const v = await asVendor();
    await v.post("/products", await productBody());
    const second = await v.post("/products", await productBody());
    expect(second.body.data.slug).toBe("garri-ijebu-white-bag-2");
  });

  it("rejects a decimal or tiny price, negative or fractional stock, and a bad category", async () => {
    const v = await asVendor();
    for (const bad of [{ priceKobo: 1500.5 }, { priceKobo: 50 }, { stock: -1 }, { stock: 2.5 }, { categoryId: "nope" }, { name: "x" }]) {
      const res = await v.post("/products", await productBody(bad));
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    const missing = await v.post("/products", await productBody({ categoryId: "a".repeat(24) }));
    expect(missing.status).toBe(422);
    expect(await Product.countDocuments()).toBe(0);
  });

  it("lists only the vendor's own products, with search and pagination", async () => {
    const a = await asVendor({ name: "Store A" });
    const b = await asVendor({ name: "Store B" });
    for (const name of ["Rice", "Beans", "Yam"]) await createProduct(a.vendor, { name });
    await createProduct(b.vendor, { name: "Rice B" });

    const all = await a.get("/products");
    expect(all.body.meta.total).toBe(3);
    const search = await a.get("/products?q=ri");
    expect(search.body.data.map((p: { name: string }) => p.name)).toEqual(["Rice"]);
    const page = await a.get("/products?limit=2&page=2");
    expect(page.body.data).toHaveLength(1);
  });

  it("updates, and a vendor cannot read, edit or delete another vendor's product", async () => {
    const a = await asVendor({ name: "Store A" });
    const b = await asVendor({ name: "Store B" });
    const p = await createProduct(a.vendor);

    const ok = await a.patch(`/products/${p._id}`, { stock: 5, priceKobo: 1600000 });
    expect(ok.body.data).toMatchObject({ stock: 5, priceKobo: 1600000 });

    // Another vendor sees it as not found, the same as a missing id.
    expect((await b.get(`/products/${p._id}`)).status).toBe(404);
    expect((await b.patch(`/products/${p._id}`, { stock: 0 })).status).toBe(404);
    expect((await b.del(`/products/${p._id}`)).status).toBe(404);
    expect((await Product.findById(p._id))!.stock).toBe(5);
  });

  it("deletes a product and its stored images", async () => {
    const v = await asVendor();
    const img = (await v.upload(pngBytes())).body.data;
    const created = await v.post("/products", await productBody({ images: [img] }));
    expect(memoryStorage.files.has(img.publicId)).toBe(true);

    const res = await v.del(`/products/${created.body.data.id}`);
    expect(res.body.data.deleted).toBe(true);
    expect(await Product.countDocuments()).toBe(0);
    expect(memoryStorage.files.has(img.publicId)).toBe(false);
  });

  it("removes images that are dropped when a product is edited", async () => {
    const v = await asVendor();
    const a = (await v.upload(pngBytes())).body.data;
    const b = (await v.upload(pngBytes())).body.data;
    const created = await v.post("/products", await productBody({ images: [a, b] }));
    await v.patch(`/products/${created.body.data.id}`, { images: [b] });
    expect(memoryStorage.files.has(a.publicId)).toBe(false);
    expect(memoryStorage.files.has(b.publicId)).toBe(true);
  });

  it("blocks a suspended store from adding, editing or uploading, but still lets it read", async () => {
    const v = await asVendor({ status: "SUSPENDED" });
    const p = await createProduct(v.vendor);
    expect((await v.post("/products", await productBody())).status).toBe(403);
    expect((await v.patch(`/products/${p._id}`, { stock: 1 })).status).toBe(403);
    expect((await v.del(`/products/${p._id}`)).status).toBe(403);
    expect((await v.upload(pngBytes())).status).toBe(403);
    expect((await v.get("/products")).status).toBe(200);
  });

  it("lets a PENDING store prepare its catalogue", async () => {
    const v = await asVendor({ status: "PENDING" });
    expect((await v.post("/products", await productBody())).status).toBe(201);
  });

  it("moves a vendor's products to the new city when the pickup pin changes city", async () => {
    // Only Ibadan is live, so use a second live city to prove the products follow the store.
    const v = await asVendor();
    const p = await createProduct(v.vendor);
    const { City } = await import("../src/models/City.js");
    await City.updateOne({ slug: "lagos" }, { isActive: true });
    const res = await v.patch("/pickup", { line: "Marina, Lagos", lat: 6.5244, lng: 3.3792 });
    expect(res.status).toBe(200);
    const lagos = await City.findOne({ slug: "lagos" });
    expect(String((await Product.findById(p._id))!.cityId)).toBe(String(lagos!._id));
    expect(String((await Vendor.findById(v.vendor._id))!.pickup!.cityId)).toBe(String(lagos!._id));
  });
});

describe("image upload", () => {
  it("stores a real image under the vendramart folder, in the vendor's own folder", async () => {
    const v = await asVendor();
    const res = await v.upload(pngBytes());
    expect(res.status).toBe(201);
    expect(res.body.data.publicId.startsWith(`vendramart/vendors/${v.vendor._id}/products/`)).toBe(true);
    expect(res.body.data.url).toMatch(/^https?:\/\//);
  });

  it("rejects a file that only pretends to be an image", async () => {
    const v = await asVendor();
    const res = await v.upload(Buffer.from("<script>alert(1)</script>"), "evil.png");
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/JPG, PNG or WebP/);
    expect(memoryStorage.files.size).toBe(0);
  });

  it("rejects files over 5 MB", async () => {
    const v = await asVendor();
    const res = await v.upload(pngBytes(5 * 1024 * 1024 + 10));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/too large/);
  });

  it("rejects a request with no file", async () => {
    const v = await asVendor();
    const res = await api().post("/api/vendor/uploads/image").set("Authorization", v.bearer);
    expect(res.status).toBe(422);
  });

  it("requires a vendor login", async () => {
    const res = await api().post("/api/vendor/uploads/image").attach("file", pngBytes(), "a.png");
    expect(res.status).toBe(401);
  });

  it("refuses to attach another store's image to a product", async () => {
    const a = await asVendor({ name: "Store A" });
    const b = await asVendor({ name: "Store B" });
    const foreign = (await a.upload(pngBytes())).body.data;
    const res = await b.post("/products", await productBody({ images: [foreign] }));
    expect(res.status).toBe(422);
    expect(await Product.countDocuments()).toBe(0);
  });

  it("limits a product to 5 images", async () => {
    const v = await asVendor();
    const images = [];
    for (let i = 0; i < 6; i++) images.push((await v.upload(pngBytes())).body.data);
    expect((await v.post("/products", await productBody({ images }))).status).toBe(422);
  });
});
