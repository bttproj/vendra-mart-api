import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Vendor } from "../src/models/Vendor.js";
import { STORAGE_ROOT, storageFolder, vendorFolderPrefixes } from "../src/utils/storagePaths.js";
import { api, clearDb, createVendor, loginToken, memoryStorage, pngBytes, productBody, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  memoryStorage.files.clear();
});

const upload = (path: string, bearer: string, data: Buffer = pngBytes(), name = "a.png") =>
  api().post(path).set("Authorization", bearer).attach("file", data, { filename: name, contentType: "image/png" });

describe("everything is stored under the vendramart folder", () => {
  it("the root folder is vendramart unless the setting says otherwise", () => {
    expect(STORAGE_ROOT).toBe("vendramart");
    expect(storageFolder("vendors", "abc", "products")).toBe("vendramart/vendors/abc/products");
    expect(storageFolder("banners")).toBe("vendramart/banners");
    expect(vendorFolderPrefixes("abc")).toEqual(["vendramart/vendors/abc/", "vendors/abc/"]);
  });

  it("a product photo goes to vendramart/vendors/<id>/products, and its address and id come back to be saved on the product", async () => {
    const v = await createVendor({ email: "v@example.com" });
    const res = await upload("/api/vendor/uploads/image", await loginToken(v.email));
    expect(res.status).toBe(201);
    expect(res.body.data.publicId).toMatch(new RegExp(`^vendramart/vendors/${v.vendor._id}/products/`));
    expect(res.body.data.url).toMatch(/^https:\/\//);

    const bearer = await loginToken(v.email);
    const made = await asUser(bearer).post("/vendor/products", await productBody({ images: [res.body.data] }));
    expect(made.status).toBe(201);
    expect(made.body.data.images).toEqual([{ url: res.body.data.url, publicId: res.body.data.publicId }]);
  });

  it("a photo stored before the root folder existed can still be kept on its product", async () => {
    const v = await createVendor({ email: "v@example.com" });
    const bearer = await loginToken(v.email);
    const legacy = { url: "https://res.cloudinary.com/x/old.jpg", publicId: `vendors/${v.vendor._id}/products/old` };
    expect((await asUser(bearer).post("/vendor/products", await productBody({ images: [legacy] }))).status).toBe(201);
  });

  it("a vendor cannot attach another store's file, in either folder form", async () => {
    const a = await createVendor({ email: "a@example.com" });
    const b = await createVendor({ email: "b@example.com" });
    const bearer = await loginToken(a.email);
    for (const publicId of [`vendramart/vendors/${b.vendor._id}/products/x`, `vendors/${b.vendor._id}/products/x`, "vendramart/banners/x"]) {
      const res = await asUser(bearer).post("/vendor/products", await productBody({ images: [{ url: "https://img.test/x.jpg", publicId }] }));
      expect(res.status, publicId).toBe(422);
    }
  });

  it("a banner picture goes to vendramart/banners", async () => {
    const admin = await createAdmin();
    const res = await upload("/api/admin/banners/image", admin.bearer);
    expect(res.status).toBe(201);
    expect(res.body.data.publicId).toMatch(/^vendramart\/banners\//);
  });
});

describe("the store logo", () => {
  it("is uploaded to Cloudinary's folder for that store, and its address is saved on the store", async () => {
    const v = await createVendor({ email: "v@example.com" });
    const bearer = await loginToken(v.email);
    const res = await upload("/api/vendor/uploads/logo", bearer);
    expect(res.status).toBe(200);
    expect(res.body.data.logo).toMatch(/^https:\/\//);

    const stored = (await Vendor.findById(v.vendor._id))!;
    expect(stored.logo).toBe(res.body.data.logo);
    expect(stored.logoPublicId).toMatch(new RegExp(`^vendramart/vendors/${v.vendor._id}/logo/`));
    expect((await api().get(`/api/vendors/${v.vendor.slug}`)).body.data.logo).toBe(stored.logo);
  });

  it("replacing it removes the old file", async () => {
    const v = await createVendor({ email: "v@example.com" });
    const bearer = await loginToken(v.email);
    await upload("/api/vendor/uploads/logo", bearer);
    const first = (await Vendor.findById(v.vendor._id))!.logoPublicId!;
    await upload("/api/vendor/uploads/logo", bearer);
    const second = (await Vendor.findById(v.vendor._id))!.logoPublicId!;
    expect(second).not.toBe(first);
    expect(memoryStorage.files.has(first)).toBe(false);
    expect(memoryStorage.files.has(second)).toBe(true);
  });

  it("must be a real image, from a store that is not suspended, and nobody can set it to any address they like", async () => {
    const v = await createVendor({ email: "v@example.com" });
    const bearer = await loginToken(v.email);
    expect((await upload("/api/vendor/uploads/logo", bearer, Buffer.from("<svg onload=alert(1)>"), "x.png")).status).toBe(422);
    expect((await api().post("/api/vendor/uploads/logo").set("Authorization", bearer)).status).toBe(422);
    expect((await asUser(bearer).patch("/vendor/profile", { logo: "https://evil.example/x.png" })).status).toBe(422);

    await Vendor.updateOne({ _id: v.vendor._id }, { status: "SUSPENDED" });
    expect((await upload("/api/vendor/uploads/logo", bearer)).status).toBe(403);
    expect((await Vendor.findById(v.vendor._id))!.logo).toBeUndefined();
  });
});
