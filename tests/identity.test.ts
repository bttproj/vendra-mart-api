import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { User } from "../src/models/User.js";
import { Vendor } from "../src/models/Vendor.js";
import type { OpenResult, PrivateFileStorage, PutOptions } from "../src/services/storage/PrivateFileStorage.js";
import { setPrivateStorage } from "../src/services/storage/index.js";
import { api, clearDb, createUser, createVendor, loginToken, pngBytes, seedReferenceData, startDb, stopDb, vendorBody } from "./helpers.js";
import { asUser, createAdmin } from "./fulfilmentHelpers.js";

/** Keeps files in memory so tests never touch the disk or Cloudinary. */
class FakePrivateStorage implements PrivateFileStorage {
  files = new Map<string, { data: Buffer; mime: string }>();
  private n = 0;
  async put(buffer: Buffer, { folder, mime, ext }: PutOptions) {
    const publicId = `${folder}/${++this.n}.${ext}`;
    this.files.set(publicId, { data: buffer, mime });
    return { publicId };
  }
  async open(publicId: string): Promise<OpenResult> {
    const f = this.files.get(publicId);
    if (!f) throw new Error("missing file");
    return { kind: "buffer", data: f.data, mime: f.mime };
  }
  async remove(publicId: string) {
    this.files.delete(publicId);
  }
}
const storage = new FakePrivateStorage();
setPrivateStorage(storage);

const pdfBytes = () => Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const NIN = "12345678901";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  storage.files.clear();
});

async function register(over: Record<string, unknown> = {}) {
  const body = vendorBody({ email: "owner@example.com", nin: NIN, ...over });
  const res = await api().post("/api/auth/vendor/register").send(body);
  return { res, body, email: body.email as string };
}

async function registered() {
  const r = await register();
  expect(r.res.status).toBe(201);
  return { ...r, bearer: await loginToken(r.email), vendor: (await Vendor.findOne({ email: r.email }))! };
}

const upload = (bearer: string, data: Buffer | null, name = "slip.png", type = "image/png") => {
  const req = api().post("/api/vendor/identity/slip").set("Authorization", bearer);
  return data ? req.attach("file", data, { filename: name, contentType: type }) : req;
};

describe("registering with a NIN", () => {
  it("needs a NIN of exactly 11 digits", async () => {
    for (const nin of [undefined, "", "1234567890", "123456789012", "1234567890a", "123 4567 8901"]) {
      const { res } = await register({ nin });
      expect(res.status, String(nin)).toBe(422);
    }
    expect(await User.countDocuments({ role: "VENDOR" })).toBe(0);
  });

  it("stores the NIN, and shows the vendor only the last four digits", async () => {
    const o = await registered();
    expect(o.vendor.nin).toBe(NIN);
    const profile = (await asUser(o.bearer).get("/vendor/profile")).body.data;
    expect(profile).toMatchObject({ ninMasked: "*******8901", hasNinSlip: false, canEditIdentity: true });
    expect(JSON.stringify(profile)).not.toContain(NIN);
  });

  it("refuses a NIN that already belongs to another store, and creates no account", async () => {
    await registered();
    const { res } = await register({ email: "second@example.com", businessName: "Second Store" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already linked to another store/);
    expect(await User.exists({ email: "second@example.com" })).toBeNull();
  });

  it("never appears on the public storefront or in the registration reply", async () => {
    const o = await registered();
    await Vendor.updateOne({ _id: o.vendor._id }, { status: "APPROVED" });
    expect(JSON.stringify(o.res.body)).not.toContain(NIN);
    expect(JSON.stringify((await api().get("/api/vendors")).body)).not.toContain(NIN);
    expect(JSON.stringify((await api().get(`/api/vendors/${o.vendor.slug}`)).body)).not.toContain(NIN);
  });
});

describe("uploading the NIN slip", () => {
  it("accepts an image and keeps it private", async () => {
    const o = await registered();
    const res = await upload(o.bearer, pngBytes());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ hasNinSlip: true });
    const stored = (await Vendor.findById(o.vendor._id))!;
    expect(stored.ninSlip).toMatchObject({ mime: "image/png" });
    expect(stored.ninSlip!.publicId).toMatch(/^vendramart\/vendors\/.+\/identity\//);
    expect(storage.files.size).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(stored.ninSlip!.publicId!);
  });

  it("accepts a PDF", async () => {
    const o = await registered();
    expect((await upload(o.bearer, pdfBytes(), "slip.pdf", "application/pdf")).status).toBe(200);
    expect((await Vendor.findById(o.vendor._id))!.ninSlip!.mime).toBe("application/pdf");
  });

  it("judges the file by its bytes, not its name or the type the browser claims", async () => {
    const o = await registered();
    const res = await upload(o.bearer, Buffer.from("<script>alert(1)</script>"), "slip.png", "image/png");
    expect(res.status).toBe(422);
    expect(storage.files.size).toBe(0);
    expect((await upload(o.bearer, null)).status).toBe(422);
  });

  it("replaces an earlier slip and removes the old file", async () => {
    const o = await registered();
    await upload(o.bearer, pngBytes());
    await upload(o.bearer, pdfBytes(), "new.pdf", "application/pdf");
    expect(storage.files.size).toBe(1);
    expect((await Vendor.findById(o.vendor._id))!.ninSlip!.mime).toBe("application/pdf");
  });

  it("lets the vendor open their own slip", async () => {
    const o = await registered();
    await upload(o.bearer, pngBytes());
    const res = await asUser(o.bearer).get("/vendor/identity/slip");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("is only for vendors", async () => {
    await createUser("CUSTOMER", "c@example.com");
    const bearer = await loginToken("c@example.com");
    expect((await upload(bearer, pngBytes())).status).toBe(403);
    expect((await api().post("/api/vendor/identity/slip")).status).toBe(401);
  });
});

describe("what an admin sees", () => {
  it("the full NIN and whether a slip is on file, and can open the slip", async () => {
    const o = await registered();
    const admin = asUser((await createAdmin()).bearer);
    const before = (await admin.get(`/admin/vendors/${o.vendor._id}`)).body.data;
    expect(before).toMatchObject({ nin: NIN, ninSlip: null });
    expect((await admin.get(`/admin/vendors/${o.vendor._id}/nin-slip`)).status).toBe(404);

    await upload(o.bearer, pngBytes());
    const after = (await admin.get(`/admin/vendors/${o.vendor._id}`)).body.data;
    expect(after.ninSlip).toMatchObject({ mime: "image/png" });
    const file = await admin.get(`/admin/vendors/${o.vendor._id}/nin-slip`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("image/png");
    expect(JSON.stringify(after)).not.toContain("identity/");
  });

  it("nobody else can open a slip: not another vendor, a customer, a handler or a visitor", async () => {
    const o = await registered();
    await upload(o.bearer, pngBytes());
    const other = await createVendor({ email: "other@example.com" });
    const path = `/api/admin/vendors/${o.vendor._id}/nin-slip`;
    expect((await api().get(path)).status).toBe(401);
    for (const email of [other.email, "customer@example.com", "handler@example.com"]) {
      if (email !== other.email) await createUser(email.startsWith("customer") ? "CUSTOMER" : "HANDLER", email);
      expect((await api().get(path).set("Authorization", await loginToken(email))).status, email).toBe(403);
    }
    // The vendor's own route only ever returns their own slip.
    expect((await asUser(await loginToken(other.email)).get("/vendor/identity/slip")).status).toBe(404);
  });
});

describe("changing identity details later", () => {
  it("is allowed while the store waits for approval", async () => {
    const o = await registered();
    await upload(o.bearer, pngBytes());
    const res = await asUser(o.bearer).patch("/vendor/identity", { nin: "10987654321" });
    expect(res.status).toBe(200);
    expect(res.body.data.ninMasked).toBe("*******4321");
    expect((await upload(o.bearer, pdfBytes(), "x.pdf", "application/pdf")).status).toBe(200);
  });

  it("is locked once the store is approved and both are on file", async () => {
    const o = await registered();
    await upload(o.bearer, pngBytes());
    await Vendor.updateOne({ _id: o.vendor._id }, { status: "APPROVED" });
    expect((await asUser(o.bearer).get("/vendor/profile")).body.data.canEditIdentity).toBe(false);
    expect((await asUser(o.bearer).patch("/vendor/identity", { nin: "10987654321" })).status).toBe(403);
    expect((await upload(o.bearer, pngBytes())).status).toBe(403);
    expect((await Vendor.findById(o.vendor._id))!.nin).toBe(NIN);
  });

  it("stays open to an approved store that never gave a slip (stores that registered before this existed)", async () => {
    const v = await createVendor({ email: "old@example.com" });
    const bearer = await loginToken(v.email);
    expect((await asUser(bearer).get("/vendor/profile")).body.data).toMatchObject({ ninMasked: null, hasNinSlip: false, canEditIdentity: true });
    expect((await asUser(bearer).patch("/vendor/identity", { nin: NIN })).status).toBe(200);
    expect((await upload(bearer, pngBytes())).status).toBe(200);
  });

  it("will not take a NIN that another store has, or one that is not 11 digits", async () => {
    await registered();
    const v = await createVendor({ email: "old@example.com" });
    const bearer = await loginToken(v.email);
    expect((await asUser(bearer).patch("/vendor/identity", { nin: NIN })).status).toBe(409);
    expect((await asUser(bearer).patch("/vendor/identity", { nin: "123" })).status).toBe(422);
    expect((await asUser(bearer).patch("/vendor/identity", { nin: "10987654321", extra: 1 })).status).toBe(422);
  });

  it("lets a vendor save their own NIN again without a clash", async () => {
    const o = await registered();
    expect((await asUser(o.bearer).patch("/vendor/identity", { nin: NIN })).status).toBe(200);
  });
});
