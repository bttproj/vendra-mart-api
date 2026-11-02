import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { City } from "../src/models/City.js";
import { User } from "../src/models/User.js";
import { Vendor } from "../src/models/Vendor.js";
import {
  LAGOS, MID_OCEAN, OJA_BA, PASSWORD, api, clearDb, createUser, createVendor, loginToken, seedReferenceData, startDb, stopDb, vendorBody,
} from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

const register = (body = vendorBody()) => api().post("/api/auth/vendor/register").send(body);

describe("vendor onboarding", () => {
  it("creates a VENDOR login and a PENDING store with pickup lat/lng and a city", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe("VENDOR");
    expect(res.body.data.home).toBe("/vendor");
    expect(res.body.data.vendor).toMatchObject({ slug: "bodija-provisions", status: "PENDING" });
    expect(typeof res.body.data.token).toBe("string");
    expect(res.headers["set-cookie"]).toBeUndefined();

    const v = await Vendor.findOne({ slug: "bodija-provisions" });
    expect(v!.pickup!.lat).toBeCloseTo(7.4318, 4);
    expect(v!.pickup!.lng).toBeCloseTo(3.9144, 4);
    expect((await City.findById(v!.pickup!.cityId))!.name).toBe("Ibadan");
    expect(v!.cacNumber).toBe("RC1234567");
  });

  it("works without a CAC number (it is optional)", async () => {
    const res = await register(vendorBody({ cacNumber: "" }));
    expect(res.status).toBe(201);
    expect((await Vendor.findOne())!.cacNumber).toBeUndefined();
  });

  it("gives a second store with the same name a unique slug", async () => {
    await register();
    const res = await register(vendorBody({ email: "second@example.com" }));
    expect(res.body.data.vendor.slug).toBe("bodija-provisions-2");
  });

  it("lets the new vendor sign in at the normal login and lands on /vendor", async () => {
    await register();
    const res = await api().post("/api/auth/login").send({ email: "bodija@example.com", password: PASSWORD });
    expect(res.body.data.home).toBe("/vendor");
  });

  it("validates bank details, phone and the pickup pin", async () => {
    const res = await register(
      vendorBody({
        phone: "123",
        bank: { bankName: "G", accountNumber: "12345", accountName: "x" },
        pickup: { line: "x", lat: 200, lng: 3 },
      }),
    );
    expect(res.status).toBe(422);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["phone", "bank.bankName", "bank.accountNumber", "pickup.line", "pickup.lat"]));
  });

  it("requires a pickup address and bank details", async () => {
    const { pickup: _p, ...noPickup } = vendorBody();
    expect((await register(noPickup as ReturnType<typeof vendorBody>)).status).toBe(422);
    const { bank: _b, ...noBank } = vendorBody();
    expect((await register(noBank as ReturnType<typeof vendorBody>)).status).toBe(422);
  });

  it("refuses a pickup pin in a coming-soon city, and creates nothing", async () => {
    const res = await register(vendorBody({ pickup: { line: "Marina, Lagos", ...LAGOS } }));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Lagos is coming soon/);
    expect(await User.countDocuments()).toBe(0);
    expect(await Vendor.countDocuments()).toBe(0);
  });

  it("refuses a pin outside every known city", async () => {
    const res = await register(vendorBody({ pickup: { line: "Somewhere at sea", ...MID_OCEAN } }));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/outside the cities we serve/);
  });

  it("rejects a duplicate email with 409", async () => {
    await register();
    expect((await register()).status).toBe(409);
  });

  it("ignores a client-supplied status (cannot self-approve)", async () => {
    await register(vendorBody({ status: "APPROVED", role: "ADMIN" }) as ReturnType<typeof vendorBody>);
    expect((await Vendor.findOne())!.status).toBe("PENDING");
    expect((await User.findOne())!.role).toBe("VENDOR");
  });
});

describe("vendor profile", () => {
  it("shows the vendor their own profile with the account number masked", async () => {
    await register();
    const bearer = await loginToken("bodija@example.com");
    const res = await api().get("/api/vendor/profile").set("Authorization", bearer);
    expect(res.status).toBe(200);
    expect(res.body.data.bank).toEqual({ bankName: "GTBank", accountName: "Bodija Provisions", accountMasked: "•••• 6789" });
    expect(JSON.stringify(res.body)).not.toContain("0123456789");
  });

  it("updates profile fields, bank details and the pickup pin", async () => {
    await register();
    const bearer = await loginToken("bodija@example.com");

    const p = await api().patch("/api/vendor/profile").set("Authorization", bearer).send({ description: "Fresh stock daily", cacNumber: "RC99" });
    expect(p.body.data).toMatchObject({ description: "Fresh stock daily", cacNumber: "RC99" });

    const b = await api().patch("/api/vendor/bank").set("Authorization", bearer).send({ bankName: "Access", accountNumber: "1111222233", accountName: "Bodija Provisions" });
    expect(b.body.data.bank.accountMasked).toMatch(/2233$/);

    const loc = await api().patch("/api/vendor/pickup").set("Authorization", bearer).send({ line: "Oja'ba, Mapo, Ibadan", ...OJA_BA });
    expect(loc.status).toBe(200);
    expect(loc.body.data.pickup.line).toBe("Oja'ba, Mapo, Ibadan");
  });

  it("rejects unknown profile fields (cannot set status through the profile)", async () => {
    await register();
    const bearer = await loginToken("bodija@example.com");
    const res = await api().patch("/api/vendor/profile").set("Authorization", bearer).send({ status: "APPROVED" });
    expect(res.status).toBe(422);
  });

  it("refuses moving the pickup pin out of the live city", async () => {
    await register();
    const bearer = await loginToken("bodija@example.com");
    const res = await api().patch("/api/vendor/pickup").set("Authorization", bearer).send({ line: "Lagos", ...LAGOS });
    expect(res.status).toBe(422);
  });

  it("keeps other roles out of vendor routes", async () => {
    await createUser("CUSTOMER", "c@example.com");
    const bearer = await loginToken("c@example.com");
    expect((await api().get("/api/vendor/profile").set("Authorization", bearer)).status).toBe(403);
    expect((await api().get("/api/vendor/profile")).status).toBe(401);
  });
});

describe("admin vendor approval", () => {
  it("lists, approves and suspends vendors (admin only)", async () => {
    await register();
    await createUser("ADMIN", "admin@example.com");
    const admin = await loginToken("admin@example.com");
    const id = String((await Vendor.findOne())!._id);
    // A store cannot go live before its owner has confirmed their email (the link they were sent); that rule has its own tests.
    await User.updateOne({ email: "bodija@example.com" }, { emailVerified: true });

    const list = await api().get("/api/admin/vendors?status=PENDING").set("Authorization", admin);
    expect(list.body.meta.total).toBe(1);
    // Admin can review CAC and the full account number
    expect(list.body.data[0]).toMatchObject({ cacNumber: "RC1234567", bank: { accountNumber: "0123456789" } });

    const approve = await api().post(`/api/admin/vendors/${id}/approve`).set("Authorization", admin);
    expect(approve.body.data.status).toBe("APPROVED");
    expect(approve.body.data.approvedAt).toBeTruthy();

    const suspend = await api().post(`/api/admin/vendors/${id}/suspend`).set("Authorization", admin).send({ reason: "Fake CAC number" });
    expect(suspend.body.data).toMatchObject({ status: "SUSPENDED", statusReason: "Fake CAC number" });

    const again = await api().post(`/api/admin/vendors/${id}/approve`).set("Authorization", admin);
    expect(again.body.data).toMatchObject({ status: "APPROVED", statusReason: null });
  });

  it("requires a reason to suspend", async () => {
    const { vendor } = await createVendor({ status: "APPROVED" });
    await createUser("ADMIN", "admin@example.com");
    const admin = await loginToken("admin@example.com");
    const res = await api().post(`/api/admin/vendors/${vendor._id}/suspend`).set("Authorization", admin).send({});
    expect(res.status).toBe(422);
  });

  it("forbids vendors, customers and handlers from approving anyone", async () => {
    const { vendor } = await createVendor({ status: "PENDING", email: "me@example.com" });
    for (const role of ["VENDOR", "CUSTOMER", "HANDLER"] as const) {
      const email = role === "VENDOR" ? "me@example.com" : `${role}@example.com`;
      if (role !== "VENDOR") await createUser(role, email);
      const bearer = await loginToken(email);
      const res = await api().post(`/api/admin/vendors/${vendor._id}/approve`).set("Authorization", bearer);
      expect(res.status, role).toBe(403);
    }
    expect((await Vendor.findById(vendor._id))!.status).toBe("PENDING");
  });
});
