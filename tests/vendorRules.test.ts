import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { User } from "../src/models/User.js";
import { Vendor } from "../src/models/Vendor.js";
import { PASSWORD, api, clearDb, createCustomer, createVendor, loginToken, seedReferenceData, startDb, stopDb, vendorBody } from "./helpers.js";
import { asUser, createAdmin, emailLog } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  emailLog.reset();
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const withoutNin = () => {
  const { nin: _drop, ...rest } = vendorBody();
  return rest;
};

describe("the NIN requirement switch", () => {
  it("is on by default: a vendor cannot register without a NIN, and anyone can read the rule", async () => {
    expect((await api().get("/api/vendor-rules")).body.data).toEqual({ requireNin: true });
    const res = await api().post("/api/auth/vendor/register").send(withoutNin());
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([{ path: "nin", message: "Your NIN is 11 digits" }]);
    expect(await User.countDocuments({ email: "bodija@example.com" })).toBe(0);
  });

  it("only an administrator can change it", async () => {
    const customer = await createCustomer();
    expect((await asUser(customer.bearer).put("/admin/settings/vendor-rules", { requireNin: false })).status).toBe(403);
    expect((await api().put("/api/admin/settings/vendor-rules").send({ requireNin: false })).status).toBe(401);
    const vendor = await createVendor();
    expect((await asUser(await loginToken(vendor.user.email)).put("/admin/settings/vendor-rules", { requireNin: false })).status).toBe(403);
    expect((await api().get("/api/vendor-rules")).body.data.requireNin).toBe(true);
  });

  it("when switched off, a vendor registers without a NIN, and the admin screen and public rule both say so", async () => {
    const admin = await createAdmin();
    const set = await asUser(admin.bearer).put("/admin/settings/vendor-rules", { requireNin: false });
    expect(set.status).toBe(200);
    expect(set.body.data.vendorRules).toEqual({ requireNin: false });
    expect((await asUser(admin.bearer).get("/admin/settings")).body.data.vendorRules).toEqual({ requireNin: false });
    expect((await api().get("/api/vendor-rules")).body.data).toEqual({ requireNin: false });

    const res = await api().post("/api/auth/vendor/register").send(withoutNin());
    expect(res.status).toBe(201);
    const vendor = (await Vendor.findOne({ email: "bodija@example.com" }))!;
    expect(vendor.nin).toBeUndefined();
  });

  it("two vendors can both skip the NIN while it is off, but a NIN that is given is still one per store", async () => {
    const admin = await createAdmin();
    await asUser(admin.bearer).put("/admin/settings/vendor-rules", { requireNin: false });
    expect((await api().post("/api/auth/vendor/register").send(withoutNin())).status).toBe(201);
    expect((await api().post("/api/auth/vendor/register").send({ ...withoutNin(), email: "two@example.com", businessName: "Two Stores" })).status).toBe(201);
    expect((await api().post("/api/auth/vendor/register").send({ ...vendorBody({ email: "three@example.com", businessName: "Three", nin: "12345678901" }) })).status).toBe(201);
    const dup = await api().post("/api/auth/vendor/register").send(vendorBody({ email: "four@example.com", businessName: "Four", nin: "12345678901" }));
    expect(dup.status).toBe(409);
  });

  it("a NIN that is given is still checked for 11 digits while the rule is off", async () => {
    const admin = await createAdmin();
    await asUser(admin.bearer).put("/admin/settings/vendor-rules", { requireNin: false });
    expect((await api().post("/api/auth/vendor/register").send(vendorBody({ nin: "123" }))).status).toBe(422);
  });

  it("switching it back on makes the NIN required again", async () => {
    const admin = await createAdmin();
    await asUser(admin.bearer).put("/admin/settings/vendor-rules", { requireNin: false });
    await asUser(admin.bearer).put("/admin/settings/vendor-rules", { requireNin: true });
    expect((await api().post("/api/auth/vendor/register").send(withoutNin())).status).toBe(422);
  });

  it("rejects anything but true or false", async () => {
    const admin = await createAdmin();
    expect((await asUser(admin.bearer).put("/admin/settings/vendor-rules", { requireNin: "no" })).status).toBe(422);
    expect((await asUser(admin.bearer).put("/admin/settings/vendor-rules", { requireNin: false, extra: 1 })).status).toBe(422);
  });

  it("does not disturb the pricing settings", async () => {
    const admin = await createAdmin();
    const before = (await asUser(admin.bearer).get("/admin/settings")).body.data.pricing;
    await asUser(admin.bearer).put("/admin/settings/vendor-rules", { requireNin: false });
    expect((await asUser(admin.bearer).get("/admin/settings")).body.data.pricing).toEqual(before);
  });
});

describe("the administrator creating a vendor", () => {
  const body = (over: Record<string, unknown> = {}) => {
    const { password: _drop, ...rest } = vendorBody({ email: "newstore@example.com", businessName: "New Store" });
    return { ...rest, ...over };
  };

  it("makes the login and the store, emails the owner a link to choose a password, and sends no password", async () => {
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).post("/admin/vendors", body());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ businessName: "New Store", email: "newstore@example.com", status: "PENDING" });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);

    const user = (await User.findOne({ email: "newstore@example.com" }))!;
    expect(user.role).toBe("VENDOR");
    expect(user.emailVerified).toBe(false);

    await waitFor(() => emailLog.to("newstore@example.com").length === 1);
    const mail = emailLog.to("newstore@example.com")[0]!;
    expect(mail).toMatchObject({ title: "Your VendraMart store account is ready", cta: "Choose my password" });
    expect(mail.link).toMatch(/^\/reset-password\/\?token=/);
  });

  it("the owner follows the link, chooses a password and signs in, and then the store can be approved", async () => {
    const admin = await createAdmin();
    const created = await asUser(admin.bearer).post("/admin/vendors", body());
    await waitFor(() => emailLog.to("newstore@example.com").length === 1);
    const token = emailLog.to("newstore@example.com")[0]!.link!.split("token=")[1]!;

    expect((await asUser(admin.bearer).post(`/admin/vendors/${created.body.data.id}/approve`)).status).toBe(409); // not confirmed yet
    expect((await api().post("/api/auth/reset-password").send({ token, password: "ChosenPass123" })).status).toBe(200);
    const login = await api().post("/api/auth/login").send({ email: "newstore@example.com", password: "ChosenPass123" });
    expect(login.body.data).toMatchObject({ home: "/vendor", user: { role: "VENDOR" } });
    expect((await asUser(admin.bearer).post(`/admin/vendors/${created.body.data.id}/approve`)).status).toBe(200);
  });

  it("no one can sign in with a made-up password before the owner chooses one", async () => {
    const admin = await createAdmin();
    await asUser(admin.bearer).post("/admin/vendors", body());
    for (const password of [PASSWORD, "Passw0rd123", "", "a1"]) {
      expect((await api().post("/api/auth/login").send({ email: "newstore@example.com", password })).status).not.toBe(200);
    }
  });

  it("follows the NIN switch, and the NIN is optional when it is off", async () => {
    const admin = await createAdmin();
    const { nin: _drop, ...noNin } = body();
    expect((await asUser(admin.bearer).post("/admin/vendors", noNin)).status).toBe(422);
    await asUser(admin.bearer).put("/admin/settings/vendor-rules", { requireNin: false });
    expect((await asUser(admin.bearer).post("/admin/vendors", noNin)).status).toBe(201);
  });

  it("refuses an email that already has an account, and a bad pickup pin, creating nothing", async () => {
    const admin = await createAdmin();
    await createVendor({ email: "newstore@example.com" });
    expect((await asUser(admin.bearer).post("/admin/vendors", body())).status).toBe(409);
    const before = await User.countDocuments();
    const bad = await asUser(admin.bearer).post("/admin/vendors", body({ email: "other@example.com", pickup: { line: "Middle of the sea", lat: 0, lng: 0 } }));
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(await User.countDocuments()).toBe(before);
  });

  it("is for administrators only, and a password in the request is refused", async () => {
    const customer = await createCustomer();
    expect((await asUser(customer.bearer).post("/admin/vendors", body())).status).toBe(403);
    expect((await api().post("/api/admin/vendors").send(body())).status).toBe(401);
    const admin = await createAdmin();
    expect((await asUser(admin.bearer).post("/admin/vendors", { ...body(), password: "Passw0rd123" })).status).toBe(422);
  });
});

describe("changing your own password", () => {
  async function signedIn() {
    const customer = await createCustomer();
    return { email: customer.user.email, bearer: customer.bearer };
  }

  it("changes it: the new one works, the old one stops working, and an email says so", async () => {
    const me = await signedIn();
    emailLog.reset();
    const res = await asUser(me.bearer).post("/auth/change-password", { currentPassword: PASSWORD, newPassword: "BrandNew123" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ changed: true });
    expect((await api().post("/api/auth/login").send({ email: me.email, password: "BrandNew123" })).status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: me.email, password: PASSWORD })).status).toBe(401);
    await waitFor(() => emailLog.to(me.email).length === 1);
    expect(emailLog.to(me.email)[0]).toMatchObject({ kind: "PASSWORD_CHANGED" });
    expect(JSON.stringify(emailLog.to(me.email))).not.toContain("BrandNew123");
  });

  it("needs the right current password, and changes nothing otherwise", async () => {
    const me = await signedIn();
    const res = await asUser(me.bearer).post("/auth/change-password", { currentPassword: "WrongPass123", newPassword: "BrandNew123" });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([{ path: "currentPassword", message: "That is not your current password" }]);
    expect((await api().post("/api/auth/login").send({ email: me.email, password: PASSWORD })).status).toBe(200);
  });

  it("refuses a weak new password, the same password, and a request that is not signed in", async () => {
    const me = await signedIn();
    expect((await asUser(me.bearer).post("/auth/change-password", { currentPassword: PASSWORD, newPassword: "short1" })).status).toBe(422);
    expect((await asUser(me.bearer).post("/auth/change-password", { currentPassword: PASSWORD, newPassword: "onlyletters" })).status).toBe(422);
    expect((await asUser(me.bearer).post("/auth/change-password", { currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(422);
    expect((await api().post("/api/auth/change-password").send({ currentPassword: PASSWORD, newPassword: "BrandNew123" })).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: me.email, password: PASSWORD })).status).toBe(200);
  });

  it("works for every role, and only changes the password of the person asking", async () => {
    const admin = await createAdmin();
    const vendor = await createVendor();
    const vendorBearer = await loginToken(vendor.user.email);
    expect((await asUser(admin.bearer).post("/auth/change-password", { currentPassword: PASSWORD, newPassword: "AdminNew123" })).status).toBe(200);
    expect((await asUser(vendorBearer).post("/auth/change-password", { currentPassword: PASSWORD, newPassword: "VendorNew123" })).status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: admin.email, password: "AdminNew123" })).status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: vendor.user.email, password: "VendorNew123" })).status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: admin.email, password: "VendorNew123" })).status).toBe(401);
  });
});
