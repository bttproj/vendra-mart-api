import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Category } from "../src/models/Category.js";
import { api, clearDb, createCustomer, createProduct, createVendor, pngBytes, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

describe("the administrator managing categories", () => {
  it("lists every category with how many products it has, and says which are starter ones", async () => {
    const admin = await createAdmin();
    const { vendor } = await createVendor();
    await createProduct(vendor);
    const res = await asUser(admin.bearer).get("/admin/categories");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(7);
    const grains = res.body.data.find((c: { slug: string }) => c.slug === "grains-and-flour");
    expect(grains).toMatchObject({ builtIn: true, hasOwnImage: false });
    expect(grains.productCount).toBeGreaterThanOrEqual(0);
    expect(res.body.data.reduce((n: number, c: { productCount: number }) => n + c.productCount, 0)).toBe(1);
  });

  it("adds a category that shoppers and vendors see straight away, at the end of the list", async () => {
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).post("/admin/categories", { name: "Home & Kitchen" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Home & Kitchen", slug: "home-and-kitchen", builtIn: false, productCount: 0 });
    const publicList = (await api().get("/api/categories")).body.data;
    expect(publicList).toHaveLength(8);
    expect(publicList[7]).toMatchObject({ name: "Home & Kitchen", slug: "home-and-kitchen" });
  });

  it("adds one with its own picture", async () => {
    const admin = await createAdmin();
    const up = await api().post("/api/admin/categories/image").set("Authorization", admin.bearer).attach("file", pngBytes(), { filename: "c.png", contentType: "image/png" });
    expect(up.status).toBe(201);
    expect(up.body.data.url).toContain("categories/");
    const res = await asUser(admin.bearer).post("/admin/categories", { name: "Electronics", image: up.body.data.url });
    expect(res.body.data).toMatchObject({ hasOwnImage: true, image: up.body.data.url });
  });

  it("refuses a picture that is not an image, or an address that is not a picture link", async () => {
    const admin = await createAdmin();
    const fake = await api().post("/api/admin/categories/image").set("Authorization", admin.bearer).attach("file", Buffer.from("<script>1</script>"), { filename: "x.png", contentType: "image/png" });
    expect(fake.status).toBe(422);
    expect((await asUser(admin.bearer).post("/admin/categories", { name: "Toys", image: "javascript:alert(1)" })).status).toBe(422);
  });

  it("refuses a name that is too short or already used, however it is capitalised", async () => {
    const admin = await createAdmin();
    expect((await asUser(admin.bearer).post("/admin/categories", { name: "a" })).status).toBe(422);
    expect((await asUser(admin.bearer).post("/admin/categories", { name: "  fashion " })).status).toBe(409);
    expect((await asUser(admin.bearer).post("/admin/categories", { name: "Grains and flour" })).status).toBe(409); // same address as "Grains & flour"
    expect(await Category.countDocuments()).toBe(7);
  });

  it("renames a category without changing its address, so old links keep working", async () => {
    const admin = await createAdmin();
    const fashion = (await Category.findOne({ slug: "fashion" }))!;
    const res = await asUser(admin.bearer).put(`/admin/categories/${fashion._id}`, { name: "Clothing" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Clothing", slug: "fashion" });
    expect((await asUser(admin.bearer).put(`/admin/categories/${fashion._id}`, { name: "Accessories" })).status).toBe(409);
    expect((await asUser(admin.bearer).put(`/admin/categories/${fashion._id}`, { name: "Clothing" })).status).toBe(200); // its own name is fine
  });

  it("changes and removes a picture", async () => {
    const admin = await createAdmin();
    const fashion = (await Category.findOne({ slug: "fashion" }))!;
    const set = await asUser(admin.bearer).put(`/admin/categories/${fashion._id}`, { name: "Fashion", image: "https://res.cloudinary.com/x/image/upload/f.jpg" });
    expect(set.body.data).toMatchObject({ hasOwnImage: true, image: "https://res.cloudinary.com/x/image/upload/f.jpg" });
    const kept = await asUser(admin.bearer).put(`/admin/categories/${fashion._id}`, { name: "Fashion" });
    expect(kept.body.data.hasOwnImage).toBe(true); // leaving the picture out leaves it alone
    const cleared = await asUser(admin.bearer).put(`/admin/categories/${fashion._id}`, { name: "Fashion", image: null });
    expect(cleared.body.data.hasOwnImage).toBe(false);
  });

  it("deletes an empty category of its own, but not one with products or a starter one", async () => {
    const admin = await createAdmin();
    const made = (await asUser(admin.bearer).post("/admin/categories", { name: "Toys" })).body.data;
    const { vendor } = await createVendor();
    await createProduct(vendor, { categoryId: made.id });
    const busy = await asUser(admin.bearer).delete(`/admin/categories/${made.id}`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toContain("1 product is");

    const empty = (await asUser(admin.bearer).post("/admin/categories", { name: "Books" })).body.data;
    expect((await asUser(admin.bearer).delete(`/admin/categories/${empty.id}`)).status).toBe(200);
    expect(await Category.exists({ slug: "books" })).toBeNull();

    const starter = (await Category.findOne({ slug: "fashion" }))!;
    expect((await asUser(admin.bearer).delete(`/admin/categories/${starter._id}`)).status).toBe(409);
    expect(await Category.exists({ slug: "fashion" })).not.toBeNull();
    expect((await asUser(admin.bearer).delete(`/admin/categories/${"a".repeat(24)}`)).status).toBe(404);
  });

  it("is for administrators only", async () => {
    const customer = await createCustomer();
    expect((await asUser(customer.bearer).post("/admin/categories", { name: "Toys" })).status).toBe(403);
    expect((await asUser(customer.bearer).get("/admin/categories")).status).toBe(403);
    expect((await api().post("/api/admin/categories").send({ name: "Toys" })).status).toBe(401);
    expect((await asUser(customer.bearer).delete(`/admin/categories/${"a".repeat(24)}`)).status).toBe(403);
  });
});
