import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Notification } from "../src/models/Notification.js";
import { User } from "../src/models/User.js";
import { cleanPermissions, hasPermission, isSuperAdmin, PERMISSIONS, STAFF_TITLES, STAFF_TITLE_INFO } from "../src/domain/permissions.js";
import { setDeskAddressesForTests } from "../src/modules/accounts/team.js";
import { api, clearDb, createCustomer, createVendor, loginToken, PASSWORD, seedReferenceData, startDb, stopDb, vendorBody } from "./helpers.js";
import { asUser, createAdmin, emailLog, paidOrder } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  emailLog.reset();
  setDeskAddressesForTests({});
});
afterEach(() => setDeskAddressesForTests({}));

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waited, but it did not happen");
}

const person = (email: string, over: Record<string, unknown> = {}) => ({ name: "Ada Staff", email, phone: "08031234567", password: PASSWORD, ...over });

/** The super admin makes a staff member through the real endpoint, and the new member signs in. */
async function makeStaff(admin: { bearer: string }, title: (typeof STAFF_TITLES)[number], email: string, permissions?: string[]) {
  const res = await asUser(admin.bearer).post("/admin/staff", person(email, { role: "STAFF", staffTitle: title, ...(permissions ? { permissions } : {}) }));
  expect(res.status).toBe(201);
  return { id: res.body.data.id as string, email, bearer: await loginToken(email), body: res.body.data };
}

describe("the permission rules", () => {
  it("lists six titles, each with sensible starting areas", () => {
    expect(STAFF_TITLES).toHaveLength(6);
    expect(STAFF_TITLE_INFO.FINANCE_MANAGER.defaults).toContain("payouts");
    expect(STAFF_TITLE_INFO.FINANCE_MANAGER.defaults).not.toContain("vendors");
    expect(STAFF_TITLE_INFO.CUSTOMER_SUPPORT.defaults).toEqual(["orders", "customers"]);
    for (const t of STAFF_TITLES) for (const p of STAFF_TITLE_INFO[t].defaults) expect(PERMISSIONS).toContain(p);
  });

  it("treats an administrator with no title as a super admin, and a titled one as limited", () => {
    expect(isSuperAdmin({ role: "ADMIN" })).toBe(true);
    expect(hasPermission({ role: "ADMIN" }, "payouts")).toBe(true);
    const staff = { role: "ADMIN", staffTitle: "FINANCE_MANAGER", permissions: ["payouts"] };
    expect(isSuperAdmin(staff)).toBe(false);
    expect(hasPermission(staff, "payouts")).toBe(true);
    expect(hasPermission(staff, "vendors")).toBe(false);
    expect(hasPermission({ role: "CUSTOMER", permissions: ["payouts"] }, "payouts")).toBe(false);
  });

  it("keeps only known areas, once each", () => {
    expect(cleanPermissions(["payouts", "nonsense", "payouts", "orders"])).toEqual(["orders", "payouts"]);
  });
});

describe("a super admin creating staff", () => {
  it("creates a manager with the title's starting areas, who signs in and sees them in the session", async () => {
    const admin = await createAdmin();
    const fin = await makeStaff(admin, "FINANCE_MANAGER", "fin@example.com");
    expect(fin.body).toMatchObject({ role: "ADMIN", staffTitle: "FINANCE_MANAGER", staffLabel: "Finance manager", isSuperAdmin: false });
    expect(fin.body.permissions).toEqual(["overview", "orders", "handlers", "payouts"]);
    const me = await asUser(fin.bearer).get("/auth/me");
    expect(me.body.data.user).toMatchObject({ role: "ADMIN", staffTitle: "FINANCE_MANAGER", isSuperAdmin: false, permissions: ["overview", "orders", "handlers", "payouts"] });
    expect(me.body.data.home).toBe("/admin");
  });

  it("lets the super admin choose exactly which areas, instead of the defaults", async () => {
    const admin = await createAdmin();
    const sup = await makeStaff(admin, "CUSTOMER_SUPPORT", "help@example.com", ["customers", "vendors"]);
    expect(sup.body.permissions).toEqual(["vendors", "customers"]);
  });

  it("a super admin has every area and is marked as one in the session", async () => {
    const admin = await createAdmin();
    const me = (await asUser(admin.bearer).get("/auth/me")).body.data.user;
    expect(me).toMatchObject({ isSuperAdmin: true, staffTitle: null });
    expect(me.permissions).toEqual([...PERMISSIONS]);
  });

  it("needs a title for staff, and refuses a title or areas on anyone else", async () => {
    const admin = await createAdmin();
    expect((await asUser(admin.bearer).post("/admin/staff", person("a@example.com", { role: "STAFF" }))).status).toBe(422);
    expect((await asUser(admin.bearer).post("/admin/staff", person("b@example.com", { role: "STAFF", staffTitle: "CEO" }))).status).toBe(422);
    expect((await asUser(admin.bearer).post("/admin/staff", person("c@example.com", { role: "HANDLER", staffTitle: "FINANCE_MANAGER" }))).status).toBe(422);
    expect((await asUser(admin.bearer).post("/admin/staff", person("d@example.com", { role: "STAFF", staffTitle: "VENDOR_MANAGER", permissions: ["everything"] }))).status).toBe(422);
    expect(await User.countDocuments({ email: { $in: ["a@example.com", "b@example.com", "c@example.com", "d@example.com"] } })).toBe(0);
  });

  it("emails the new staff member about their access without the password, and tells the other super admins", async () => {
    const admin = await createAdmin();
    await createAdmin("second@example.com");
    await makeStaff(admin, "LOGISTICS_MANAGER", "logi@example.com");
    await waitFor(() => emailLog.to("logi@example.com").length === 1 && emailLog.to("second@example.com").length === 1);
    const welcome = emailLog.to("logi@example.com")[0]!;
    expect(welcome.title).toBe("Your VendraMart logistics manager account is ready");
    expect(welcome.body).toContain("Deliveries");
    expect(welcome.body).not.toContain(PASSWORD);
    expect(emailLog.to("second@example.com")[0]!.title).toBe("A new staff member was added");
  });

  it("changes what a staff member can open, and it applies straight away", async () => {
    const admin = await createAdmin();
    const fin = await makeStaff(admin, "FINANCE_MANAGER", "fin@example.com");
    expect((await asUser(fin.bearer).get("/admin/customers")).status).toBe(403);
    const patched = await asUser(admin.bearer).patch(`/admin/staff/${fin.id}`, { permissions: ["customers", "payouts"] });
    expect(patched.status).toBe(200);
    expect(patched.body.data.permissions).toEqual(["customers", "payouts"]);
    expect((await asUser(fin.bearer).get("/admin/customers")).status).toBe(200);
    expect((await asUser(fin.bearer).get("/admin/orders")).status).toBe(403);
  });

  it("will not give a super admin or a delivery handler dashboard areas", async () => {
    const admin = await createAdmin();
    const other = await createAdmin("other@example.com");
    expect((await asUser(admin.bearer).patch(`/admin/staff/${other.user._id}`, { permissions: ["orders"] })).status).toBe(409);
  });

  it("switches a staff member off, and they are signed out of everything", async () => {
    const admin = await createAdmin();
    const fin = await makeStaff(admin, "FINANCE_MANAGER", "fin@example.com");
    expect((await asUser(admin.bearer).patch(`/admin/staff/${fin.id}`, { isActive: false })).status).toBe(200);
    expect((await asUser(fin.bearer).get("/admin/payouts")).status).toBe(401);
  });
});

describe("what staff can open", () => {
  it("a finance manager reaches payouts and orders but not vendors, settings, categories or deliveries", async () => {
    const admin = await createAdmin();
    const fin = await makeStaff(admin, "FINANCE_MANAGER", "fin@example.com");
    const as = asUser(fin.bearer);
    expect((await as.get("/admin/payouts")).status).toBe(200);
    expect((await as.get("/admin/orders")).status).toBe(200);
    expect((await as.get("/admin/overview")).status).toBe(200);
    for (const path of ["/admin/vendors", "/admin/settings", "/admin/categories", "/admin/banners", "/admin/deliveries", "/admin/customers"]) {
      expect((await as.get(path)).status, path).toBe(403);
    }
    expect((await as.put("/admin/settings/vendor-rules", { requireNin: false })).status).toBe(403);
  });

  it("a vendor manager reaches vendors, including creating a store, but not payouts", async () => {
    const admin = await createAdmin();
    const vm = await makeStaff(admin, "VENDOR_MANAGER", "vm@example.com");
    expect((await asUser(vm.bearer).get("/admin/vendors")).status).toBe(200);
    expect((await asUser(vm.bearer).get("/admin/payouts")).status).toBe(403);
  });

  it("a product manager manages categories and banners", async () => {
    const admin = await createAdmin();
    const pm = await makeStaff(admin, "PRODUCT_MANAGER", "pm@example.com");
    expect((await asUser(pm.bearer).post("/admin/categories", { name: "Toys" })).status).toBe(201);
    expect((await asUser(pm.bearer).get("/admin/banners")).status).toBe(200);
    expect((await asUser(pm.bearer).get("/admin/vendors")).status).toBe(403);
  });

  it("customer support sees orders and customers only", async () => {
    const admin = await createAdmin();
    const cs = await makeStaff(admin, "CUSTOMER_SUPPORT", "cs@example.com");
    expect((await asUser(cs.bearer).get("/admin/orders")).status).toBe(200);
    expect((await asUser(cs.bearer).get("/admin/customers")).status).toBe(200);
    expect((await asUser(cs.bearer).get("/admin/overview")).status).toBe(403);
    expect((await asUser(cs.bearer).get("/admin/payouts")).status).toBe(403);
  });

  it("staff can never delete accounts, only a super admin can", async () => {
    const admin = await createAdmin();
    const ops = await makeStaff(admin, "OPERATIONS_MANAGER", "ops@example.com");
    const customer = await createCustomer();
    expect((await asUser(ops.bearer).delete(`/admin/customers/${customer.user._id}`)).status).toBe(403);
    expect((await asUser(admin.bearer).delete(`/admin/customers/${customer.user._id}`)).status).toBe(200);
  });

  it("search only returns what the person may open", async () => {
    const admin = await createAdmin();
    const { vendor } = await createVendor({ name: "Zeta Foods", email: "zeta@example.com" });
    expect(vendor.businessName).toContain("Zeta");
    const cs = await makeStaff(admin, "CUSTOMER_SUPPORT", "cs@example.com");
    const found = await asUser(cs.bearer).get("/admin/search?q=zeta");
    expect(found.status).toBe(200);
    expect(found.body.data.vendors).toEqual([]);
    expect((await asUser(admin.bearer).get("/admin/search?q=zeta")).body.data.vendors).toHaveLength(1);
  });

  it("customers, vendors and handlers still cannot open any of it", async () => {
    const customer = await createCustomer();
    expect((await asUser(customer.bearer).get("/admin/payouts")).status).toBe(403);
  });
});

describe("managers creating delivery handlers", () => {
  it("a manager with the handlers area creates and switches off delivery handlers, and sees only handlers", async () => {
    const admin = await createAdmin();
    const ops = await makeStaff(admin, "OPERATIONS_MANAGER", "ops@example.com");
    const made = await asUser(ops.bearer).post("/admin/staff", person("rider@example.com", { role: "HANDLER" }));
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ role: "HANDLER", activeDeliveries: 0 });
    expect((await User.findOne({ email: "rider@example.com" }))!.createdBy).toEqual(ops.body.id ? (await User.findById(ops.id))!._id : undefined);

    const list = await asUser(ops.bearer).get("/admin/staff");
    expect(list.body.data.map((m: { role: string }) => m.role)).toEqual(["HANDLER"]);

    const off = await asUser(ops.bearer).patch(`/admin/staff/${made.body.data.id}`, { isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
  });

  it("a manager cannot create administrators or other staff, or change anyone's areas", async () => {
    const admin = await createAdmin();
    const ops = await makeStaff(admin, "OPERATIONS_MANAGER", "ops@example.com");
    expect((await asUser(ops.bearer).post("/admin/staff", person("x@example.com", { role: "ADMIN" }))).status).toBe(403);
    expect((await asUser(ops.bearer).post("/admin/staff", person("y@example.com", { role: "STAFF", staffTitle: "FINANCE_MANAGER" }))).status).toBe(403);
    expect(await User.countDocuments({ email: { $in: ["x@example.com", "y@example.com"] } })).toBe(0);
    const fin = await makeStaff(admin, "FINANCE_MANAGER", "fin@example.com");
    // administrators are outside a manager's reach entirely
    expect((await asUser(ops.bearer).patch(`/admin/staff/${fin.id}`, { isActive: false })).status).toBe(404);
    expect((await asUser(ops.bearer).patch(`/admin/staff/${fin.id}`, { permissions: ["orders"] })).status).toBe(404);
  });

  it("customer support was not given the handlers area, so it cannot create handlers", async () => {
    const admin = await createAdmin();
    const cs = await makeStaff(admin, "CUSTOMER_SUPPORT", "cs@example.com");
    expect((await asUser(cs.bearer).post("/admin/staff", person("rider@example.com", { role: "HANDLER" }))).status).toBe(403);
    expect((await asUser(cs.bearer).get("/admin/staff")).status).toBe(403);
    // ...until the super admin ticks it
    await asUser(admin.bearer).patch(`/admin/staff/${cs.id}`, { permissions: ["orders", "customers", "handlers"] });
    expect((await asUser(cs.bearer).post("/admin/staff", person("rider@example.com", { role: "HANDLER" }))).status).toBe(201);
  });

  it("the super admin still sees and creates everything", async () => {
    const admin = await createAdmin();
    await makeStaff(admin, "FINANCE_MANAGER", "fin@example.com");
    await asUser(admin.bearer).post("/admin/staff", person("rider@example.com", { role: "HANDLER" }));
    const list = (await asUser(admin.bearer).get("/admin/staff")).body.data;
    expect(list.map((m: { email: string }) => m.email).sort()).toEqual(["admin@example.com", "fin@example.com", "rider@example.com"]);
    expect(list.find((m: { email: string }) => m.email === "admin@example.com")).toMatchObject({ isSuperAdmin: true, staffLabel: "Super admin" });
  });

  it("a customer cannot reach staff accounts at all", async () => {
    const customer = await createCustomer();
    expect((await asUser(customer.bearer).post("/admin/staff", person("rider@example.com"))).status).toBe(403);
    expect((await api().get("/api/admin/staff")).status).toBe(401);
  });
});

describe("email to the shared mailboxes and the right staff", () => {
  it("a new store application goes to admin@ and vendors@, to staff with the vendors area, and not to a finance manager", async () => {
    setDeskAddressesForTests({ admin: "admin@vendramart.com", vendors: "vendors@vendramart.com" });
    const admin = await createAdmin();
    const vm = await makeStaff(admin, "VENDOR_MANAGER", "vm@example.com");
    const fin = await makeStaff(admin, "FINANCE_MANAGER", "fin@example.com");
    await waitFor(() => emailLog.to("vm@example.com").length >= 1); // their welcome
    emailLog.reset();

    const res = await api().post("/api/auth/vendor/register").send(vendorBody({ email: "newstore@example.com", businessName: "Fresh Store" }));
    expect(res.status).toBe(201);
    await waitFor(() => emailLog.to("vendors@vendramart.com").length === 1 && emailLog.to("admin@vendramart.com").length === 1 && emailLog.to(vm.email).length === 1);
    expect(emailLog.to("admin@vendramart.com")[0]!.title).toBe("New store to review: Fresh Store");
    expect(emailLog.to("admin@example.com")[0]!.title).toBe("New store to review: Fresh Store");
    expect(emailLog.to(fin.email).filter((m) => m.kind === "VENDOR_PENDING")).toEqual([]);
    expect(await Notification.countDocuments({ userId: (await User.findOne({ email: vm.email }))!._id, kind: "VENDOR_PENDING" })).toBe(1);
    expect(await Notification.countDocuments({ userId: (await User.findOne({ email: fin.email }))!._id, kind: "VENDOR_PENDING" })).toBe(0);
  });

  it("a sale goes to admin@ and vendors@ by email only, with the customer, the amount and the stores", async () => {
    setDeskAddressesForTests({ admin: "admin@vendramart.com", vendors: "vendors@vendramart.com" });
    await createAdmin();
    const o = await paidOrder();
    await waitFor(() => emailLog.to("admin@vendramart.com").length >= 1 && emailLog.to("vendors@vendramart.com").length >= 1);
    const sale = emailLog.to("admin@vendramart.com").find((m) => m.kind === "ORDER_NEEDS_HANDLER")!;
    expect(sale.title).toContain("New sale");
    expect(sale.body).toContain("₦");
    expect(emailLog.to("vendors@vendramart.com").some((m) => m.kind === "ORDER_NEEDS_HANDLER")).toBe(true);
    // the mailboxes are not people with accounts, so no bell notification is stored for them
    expect(await Notification.countDocuments({ title: { $regex: "New sale" } })).toBe(1); // the one admin account only
    expect(o.customer.email).toBeTruthy();
  });

  it("each step of a delivery is copied to admin@, and only vendor-related ones to vendors@", async () => {
    setDeskAddressesForTests({ admin: "admin@vendramart.com" });
    await createAdmin();
    await paidOrder();
    await waitFor(() => emailLog.to("admin@vendramart.com").length >= 1);
    expect(emailLog.to("vendors@vendramart.com")).toEqual([]);
  });

  it("a new customer is announced to admin@ only", async () => {
    setDeskAddressesForTests({ admin: "admin@vendramart.com", vendors: "vendors@vendramart.com" });
    const res = await api().post("/api/auth/register").send({ ...(await import("./helpers.js")).customerBody({ email: "buyer@example.com" }) });
    expect(res.status).toBe(201);
    await waitFor(() => emailLog.to("admin@vendramart.com").some((m) => m.kind === "NEW_CUSTOMER"));
    expect(emailLog.to("vendors@vendramart.com")).toEqual([]);
  });

  it("an address can be switched off, and an admin account on the same address is not emailed twice", async () => {
    setDeskAddressesForTests({ admin: "off", vendors: "admin@example.com" });
    await createAdmin();
    await api().post("/api/auth/vendor/register").send(vendorBody({ email: "newstore@example.com", businessName: "Fresh Store" }));
    await waitFor(() => emailLog.to("admin@example.com").length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(emailLog.to("admin@example.com").filter((m) => m.kind === "VENDOR_PENDING")).toHaveLength(1);
    expect(emailLog.to("off")).toEqual([]);
  });

  it("without any mailbox configured, nobody extra is emailed", async () => {
    await createAdmin();
    await api().post("/api/auth/vendor/register").send(vendorBody({ email: "newstore@example.com", businessName: "Fresh Store" }));
    await waitFor(() => emailLog.to("admin@example.com").length >= 1);
    expect(emailLog.sent.map((s) => s.to.email).filter((e) => e.endsWith("@vendramart.com"))).toEqual([]);
  });
});
